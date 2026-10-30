import type { AgentClient, GrantClient, Operation, SwapRequest } from "@/lib/agent-api/types";
import { AgentApiError, PriceUnavailableError } from "@/lib/errors";
import { atomicToMicroUsd, portfolioValueMicroUsd, requirePrice, usdToMicro } from "@/lib/risk/pricing";
import { shouldBankStake } from "@/lib/risk/trigger";
import type { EventLog } from "@/lib/runner/events";
import type { StateStore } from "@/lib/runner/store";
import type { Strategy } from "@/lib/strategy/strategy";

export type SwapReason = "trend" | "raise_cash";

/** What the trader is about to send. The gate decides whether it goes out or waits for the DAO. */
export type SwapIntent = {
  req: SwapRequest;
  /** Fill floor already applied to `req` by the trader's slippage setting. */
  key: string;
  valueMicroUsd: bigint;
  reason: SwapReason;
};

export type SwapGate = (intent: SwapIntent) => Promise<"send" | "held">;

export type TraderConfig = {
  client: Pick<AgentClient, "getTokens" | "getStatus">;
  grant: GrantClient;
  agentId: string;
  /** The stable asset (what the stake is denominated and banked in). */
  stableAsset: string;
  riskAsset: string;
  stakeAtomic: bigint;
  stakeMicroUsd: bigint;
  strategy: Strategy;
  store: StateStore;
  log: EventLog;
  now?: () => Date;
  /** Equity / stake ratio at which the banker banks, in basis points. Matches the banker's setting. */
  multipleBps: bigint;
  /** Largest stable-asset amount per swap (the policy's per-transaction cap). */
  maxStableSwap?: bigint;
  /**
   * Worst fill accepted versus the quote, in basis points. The swap runs after the policy timelock and is
   * priced then, so size this to the market's move over that delay or every swap fails its min-output check.
   */
  slippageBps?: bigint;
  /** Called before a swap is sent. Return "held" to keep it back for a DAO decision. */
  gate?: SwapGate;
};

const DUST_MICRO_USD = 1_000_000n; // do not trade amounts under $1

/**
 * The trading half of a sleeve. It decides, quotes and swaps through the sleeve's grant; it never touches
 * the safe. Two rules keep it from fighting the stake's exit (ported from House Money):
 *  1. When equity reaches the trigger it stops trading for the market and converts the position into the
 *     stable asset, so the stake can be withdrawn.
 *  2. While the exit is queued, the stable balance it needs is reserved and never swapped away.
 * New: a swap can be held for the DAO by the gate, and later adopted once the DAO has approved and sent it.
 */
export class Trader {
  private pending: { id: string } | null = null;
  /** A swap kept back for a DAO decision. The trader does nothing else until it is resolved. */
  private waiting: SwapIntent | null = null;
  private seq = 0;
  private readonly now: () => Date;

  constructor(private cfg: TraderConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  private at() {
    return this.now().toISOString();
  }

  get isWaitingForApproval() {
    return this.waiting !== null;
  }

  async step(): Promise<void> {
    const { cfg } = this;
    if (this.waiting) return; // the DAO has not decided yet
    if (this.pending && !(await this.settlePending())) return; // one swap in flight at a time

    let balances: Record<string, string>;
    let tokens;
    let equity: bigint;
    let riskPrice: number;
    let stablePrice: number;
    try {
      [{ balances }, tokens] = await Promise.all([cfg.grant.getBalances(cfg.agentId), cfg.client.getTokens()]);
      equity = portfolioValueMicroUsd(balances, tokens, this.now());
      // The strategy decides from the risk asset's price, so that price must be fresh even when none is held.
      // (Valuing the balances only checks the assets the sleeve holds.)
      riskPrice = requirePrice(tokens.find((t) => t.asset_id === cfg.riskAsset), cfg.riskAsset, this.now());
      stablePrice = requirePrice(tokens.find((t) => t.asset_id === cfg.stableAsset), cfg.stableAsset, this.now());
    } catch (e) {
      if (e instanceof PriceUnavailableError) {
        cfg.log.emit({ type: "price_unavailable", at: this.at(), assetId: e.assetId, reason: e.message });
        return;
      }
      throw e;
    }
    const risk = tokens.find((t) => t.asset_id === cfg.riskAsset)!;
    const stable = tokens.find((t) => t.asset_id === cfg.stableAsset)!;

    const target = cfg.strategy.update(riskPrice);
    const state = await cfg.store.load();
    const stableBal = BigInt(balances[cfg.stableAsset] ?? "0");
    const riskBal = BigInt(balances[cfg.riskAsset] ?? "0");
    const riskToMicro = (a: bigint) => (a * usdToMicro(riskPrice)) / 10n ** BigInt(risk.decimals);
    const stableToMicro = (a: bigint) => (a * usdToMicro(stablePrice)) / 10n ** BigInt(stable.decimals);

    const exitPending = state.banked && !state.exitSettled && !state.settledReported;
    const reserve = exitPending ? cfg.stakeAtomic : 0n;
    const triggered =
      !state.banked &&
      (state.triggered === true ||
        shouldBankStake({ equity, principal: cfg.stakeMicroUsd, banked: false, multipleBps: cfg.multipleBps }));

    let req: SwapRequest | null = null;
    let reason: SwapReason = "trend";

    if (triggered) {
      // The swap is priced when its timelock releases, so a market that is moving can shortchange any
      // partial sale. Sell the whole position: the stake must be whole in the stable asset.
      if (stableBal < cfg.stakeAtomic && riskBal > 0n) {
        reason = "raise_cash";
        req = { origin_asset: cfg.riskAsset, destination_asset: cfg.stableAsset, amount: riskBal.toString() };
      }
    } else if (target === "risk") {
      let buy = stableBal - reserve;
      if (cfg.maxStableSwap !== undefined && buy > cfg.maxStableSwap) buy = cfg.maxStableSwap;
      if (buy > 0n && stableToMicro(buy) >= DUST_MICRO_USD)
        req = { origin_asset: cfg.stableAsset, destination_asset: cfg.riskAsset, amount: buy.toString() };
    } else if (riskBal > 0n && riskToMicro(riskBal) >= DUST_MICRO_USD) {
      req = { origin_asset: cfg.riskAsset, destination_asset: cfg.stableAsset, amount: riskBal.toString() };
    }
    if (!req) return;

    try {
      const { amountOut } = await cfg.grant.quote(cfg.agentId, req);
      const minOut = (BigInt(amountOut) * (10_000n - (cfg.slippageBps ?? 100n))) / 10_000n;
      const withFloor: SwapRequest = { ...req, min_amount_out: minOut.toString() };
      const originToken = req.origin_asset === cfg.stableAsset ? stable : risk;
      const valueMicroUsd = atomicToMicroUsd(BigInt(req.amount), originToken, req.origin_asset, this.now());
      const intent: SwapIntent = { req: withFloor, key: `swap:${cfg.agentId}:${++this.seq}`, valueMicroUsd, reason };

      if (cfg.gate && (await cfg.gate(intent)) === "held") {
        this.waiting = intent;
        cfg.log.emit({
          type: "swap_held",
          at: this.at(),
          from: req.origin_asset,
          to: req.destination_asset,
          amountIn: req.amount,
          valueMicroUsd: valueMicroUsd.toString(),
          reason,
        });
        return;
      }
      const op = await cfg.grant.swap(cfg.agentId, withFloor, { idempotencyKey: intent.key });
      this.afterSend(op, withFloor, reason);
    } catch (e) {
      if (e instanceof AgentApiError) {
        cfg.log.emit({ type: "refused", at: this.at(), code: e.code });
        return;
      }
      throw e;
    }
  }

  /** The DAO approved the held swap and the command center sent it. Track it like any other swap. */
  adopt(op: Operation, req: SwapRequest, reason: SwapReason) {
    this.waiting = null;
    this.afterSend(op, req, reason);
  }

  /** The DAO vetoed the held swap or it expired. The trader may decide again on the next step. */
  discardHeld() {
    this.waiting = null;
  }

  private afterSend(op: Operation, req: SwapRequest, reason: SwapReason) {
    this.cfg.log.emit({
      type: "swap_queued",
      at: this.at(),
      correlationId: op.correlation_id,
      from: req.origin_asset,
      to: req.destination_asset,
      amountIn: req.amount,
      executeAfter: op.execute_after,
      reason,
    });
    if (op.status === "QUEUED" || op.status === "HELD" || op.status === "PROCESSING") this.pending = { id: op.correlation_id };
    else this.report(op.correlation_id, op.status, op.swap?.amountOut, op.failure_code);
  }

  /** True once the in-flight swap has reached a final state. */
  private async settlePending(): Promise<boolean> {
    const op = await this.cfg.client.getStatus(this.pending!.id);
    if (op.status === "QUEUED" || op.status === "HELD" || op.status === "PROCESSING") return false;
    this.report(op.correlation_id, op.status, op.swap?.amountOut, op.failure_code);
    this.pending = null;
    return true;
  }

  private report(correlationId: string, status: string, amountOut?: string, failureCode?: string) {
    if (status === "SUCCESS") this.cfg.log.emit({ type: "swap_settled", at: this.at(), correlationId, amountOut });
    else this.cfg.log.emit({ type: "swap_failed", at: this.at(), correlationId, failureCode: failureCode ?? status });
  }
}
