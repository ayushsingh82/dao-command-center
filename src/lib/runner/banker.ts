import type { AgentClient, GrantClient } from "@/lib/agent-api/types";
import { AgentApiError, PriceUnavailableError } from "@/lib/errors";
import { portfolioValueMicroUsd } from "@/lib/risk/pricing";
import { shouldBankStake, stakeKey } from "@/lib/risk/trigger";
import { EventLog } from "@/lib/runner/events";
import type { RunnerState, StateStore } from "@/lib/runner/store";

export type BankerConfig = {
  client: Pick<AgentClient, "getTokens" | "getStatus">;
  grant: GrantClient;
  agentId: string;
  /** The stable asset the stake is denominated and banked in. */
  asset: string;
  /** The stake in the asset's atomic units; the exact amount that gets banked. */
  stakeAtomic: bigint;
  /** The stake valued in micro-USD (fixed when the sleeve was funded). */
  stakeMicroUsd: bigint;
  /** Where the stake goes: the DAO's safe. */
  chain: string;
  safeAddress: string;
  store: StateStore;
  log?: EventLog;
  now?: () => Date;
  /** Equity / stake at which the stake is banked, in basis points (20_000 = 2x). */
  multipleBps: bigint;
};

/**
 * Banks a sleeve's stake once, when its gains cover it. Ported from House Money's runner: it reads the
 * sleeve's value from priced balances (failing closed on a bad price), latches the trigger, and withdraws
 * exactly the stake to the safe under a fixed idempotency key. Sealing the policy afterwards is the
 * command center's job (it is an owner action, so a DAO vote).
 */
export class StakeBanker {
  readonly log: EventLog;
  private now: () => Date;

  constructor(private cfg: BankerConfig) {
    this.log = cfg.log ?? new EventLog();
    this.now = cfg.now ?? (() => new Date());
  }

  private at() {
    return this.now().toISOString();
  }

  /** One pass: bank the stake if covered, otherwise report on a queued exit. */
  async tick(): Promise<void> {
    const state = await this.cfg.store.load();
    if (state.banked) return this.reportSettlement(state);

    let equity: bigint;
    let held: bigint;
    try {
      const [{ balances }, tokens] = await Promise.all([
        this.cfg.grant.getBalances(this.cfg.agentId),
        this.cfg.client.getTokens(),
      ]);
      equity = portfolioValueMicroUsd(balances, tokens, this.now());
      held = BigInt(balances[this.cfg.asset] ?? "0");
    } catch (e) {
      if (e instanceof PriceUnavailableError) {
        this.log.emit({ type: "price_unavailable", at: this.at(), assetId: e.assetId, reason: e.message });
        return; // fail closed: never act on unpriced equity
      }
      throw e;
    }

    const stake = this.cfg.stakeMicroUsd;
    this.log.emit({ type: "tick", at: this.at(), equityMicroUsd: equity.toString(), principalMicroUsd: stake.toString() });
    if (!state.triggered) {
      if (!shouldBankStake({ equity, principal: stake, banked: false, multipleBps: this.cfg.multipleBps })) return;
      this.log.emit({ type: "trigger", at: this.at(), equityMicroUsd: equity.toString(), principalMicroUsd: stake.toString() });
      await this.cfg.store.save({ ...state, triggered: true });
    }

    // Gains held in another asset cannot be withdrawn as the stake: wait until the trader has raised the cash.
    if (held < this.cfg.stakeAtomic) {
      this.log.emit({ type: "awaiting_cash", at: this.at(), heldAtomic: held.toString(), neededAtomic: this.cfg.stakeAtomic.toString() });
      return;
    }
    try {
      // Withdraw first, persist second: a crash in between retries under the same key and replays.
      const op = await this.cfg.grant.withdraw(
        this.cfg.agentId,
        { asset: this.cfg.asset, amount: this.cfg.stakeAtomic.toString(), chain: this.cfg.chain, recipient: this.cfg.safeAddress },
        { idempotencyKey: stakeKey(this.cfg.agentId, state.attempt ?? 0) },
      );
      await this.cfg.store.save({ ...state, triggered: true, banked: true, withdrawalId: op.correlation_id, bankedAt: this.at() });
      this.log.emit({ type: "withdraw_queued", at: this.at(), correlationId: op.correlation_id, executeAfter: op.execute_after });
    } catch (e) {
      if (e instanceof AgentApiError) {
        this.log.emit({ type: "refused", at: this.at(), code: e.code });
        return; // not banked; next tick re-evaluates
      }
      throw e;
    }
  }

  private async reportSettlement(state: RunnerState) {
    if (state.settledReported || !state.withdrawalId) return;
    const op = await this.cfg.client.getStatus(state.withdrawalId);
    if (op.status === "SUCCESS") {
      this.log.emit({ type: "withdraw_settled", at: this.at(), correlationId: op.correlation_id });
      await this.cfg.store.save({ ...state, settledReported: true, exitSettled: true });
    } else if (op.status === "FAILED" || op.status === "CANCELLED") {
      this.log.emit({ type: "withdraw_failed", at: this.at(), correlationId: op.correlation_id, failureCode: op.failure_code ?? op.status });
      await this.cfg.store.save({ ...state, settledReported: true });
    }
    // QUEUED, HELD or PROCESSING: still in flight; check again on the next tick.
  }

  /**
   * After the DAO vetoed or the API failed the exit: allow exactly one new attempt under a new key.
   * Returns false when there is nothing to retry (never banked, still in flight, or already settled).
   */
  async retry(): Promise<boolean> {
    const state = await this.cfg.store.load();
    if (!state.banked || !state.settledReported || state.exitSettled) return false;
    await this.cfg.store.save({
      triggered: true,
      banked: false,
      attempt: (state.attempt ?? 0) + 1,
    });
    return true;
  }
}
