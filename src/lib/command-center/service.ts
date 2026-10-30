import { AuditLog, type AuditData } from "@/lib/audit/log";
import type { AgentClient, Operation } from "@/lib/agent-api/types";
import { runAttackTest } from "@/lib/command-center/attack-test";
import { buildBooks } from "@/lib/command-center/books";
import type {
  ApprovalRecord,
  ApprovalView,
  AttackReport,
  Books,
  CommandCenterState,
  KillReport,
  SleeveRecord,
  SleeveView,
  Snapshot,
  TickReport,
} from "@/lib/command-center/types";
import { AgentApiError, CommandCenterError, MandateViolationError, PriceUnavailableError } from "@/lib/errors";
import { fmtAsset } from "@/lib/format";
import type { Governance, OwnerAction, Proposal, Vote } from "@/lib/governance/types";
import { diffPolicies } from "@/lib/mandate/diff";
import { mandateDigest, usdAmount, validateMandate, type Mandate } from "@/lib/mandate/mandate";
import { buildSleevePolicy, freezePolicy, sealPolicy } from "@/lib/mandate/policies";
import type { Policy, TokenInfo } from "@/lib/policy/types";
import { atomicToMicroUsd, microToUsdString, microUsdToAtomic, portfolioValueMicroUsd } from "@/lib/risk/pricing";
import { StakeBanker, type BankerConfig } from "@/lib/runner/banker";
import { EventLog } from "@/lib/runner/events";
import type { RunnerState, StateStore } from "@/lib/runner/store";
import { PERSISTED_VERSION, PersistenceError, type PersistedState, type StateRepository } from "@/lib/persistence/repository";
import { HoldStrategy, type Strategy, type StrategySpec } from "@/lib/strategy/strategy";
import { Trader, type SwapIntent, type TraderConfig } from "@/lib/strategy/trader";
import { TrendStrategy } from "@/lib/strategy/trend";

const DAY_MS = 86_400_000;

/** Controls that exist only on the mock: moving time and prices. A live deployment has none of them. */
export type SimControls = {
  advance(ms: number): void;
  setPrice(assetId: string, price: number): void;
  setStale(assetId: string, stale: boolean): void;
};

export type CommandCenterDeps = {
  api: AgentClient;
  governance: Governance;
  now: () => Date;
  sim?: SimControls;
  /** The DAO's stable balance at the start, atomic units. */
  treasuryStableAtomic: bigint;
  /** How long a trade request waits for the DAO before it lapses. Default 24 hours. */
  approvalTtlMs?: number;
  /** How long a sleeve's grant lasts. Default 30 days. */
  grantTtlMs?: number;
  /** Where to save state after every change. Without one, a restart starts over. */
  repository?: StateRepository;
};

export type OpenSleeveInput = {
  name: string;
  /** Decimal USD, for example "1000". */
  stakeUsd: string;
  strategy: StrategySpec;
  riskAsset: string;
  /** Put this sleeve on owner approval: every money action it takes waits for the DAO. */
  hold?: boolean;
};

type Engine = { banker: StakeBanker; trader: Trader; bankerCfg: BankerConfig; traderCfg: TraderConfig };

/** The sleeve's runner state lives on its record, so a snapshot of the state is a snapshot of the runners. */
class SleeveStore implements StateStore {
  constructor(private sleeve: SleeveRecord) {}
  async load(): Promise<RunnerState> {
    return structuredClone(this.sleeve.runner);
  }
  async save(state: RunnerState) {
    this.sleeve.runner = structuredClone(state);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The DAO command center. It holds the mandate, runs strategy sleeves inside it, queues large moves for
 * the DAO, and can stop everything at once. Every decision the DAO makes goes through governance (a vote);
 * every action is written to an audit trail tagged with the mandate it ran under.
 */
export class CommandCenter {
  readonly audit: AuditLog;
  private state: CommandCenterState;
  private engines = new Map<string, Engine>();
  private strategies = new Map<string, Strategy>();
  private settling = false;
  private seq = 0;
  private readonly approvalTtlMs: number;
  private readonly grantTtlMs: number;

  constructor(private deps: CommandCenterDeps) {
    this.state = {
      mandate: null,
      mandateDigest: "none",
      treasuryStableAtomic: deps.treasuryStableAtomic.toString(),
      sleeves: [],
      approvals: [],
      killed: null,
    };
    this.audit = new AuditLog(() => this.state.mandateDigest, deps.now);
    this.approvalTtlMs = deps.approvalTtlMs ?? DAY_MS;
    this.grantTtlMs = deps.grantTtlMs ?? 30 * DAY_MS;
  }

  /** Save the state if a repository is set. A failed save is written to the audit trail and thrown. */
  private async persist() {
    const repo = this.deps.repository;
    if (!repo) return;
    try {
      await repo.save(this.exportState());
    } catch (e) {
      this.audit.record("persist_failed", { message: errorText(e) });
      throw e;
    }
  }

  /** The whole state, as plain data. Contains each sleeve's grant: store it like a secret. */
  exportState(): PersistedState {
    return structuredClone({ version: PERSISTED_VERSION, savedAt: this.iso(), seq: this.seq, state: this.state, audit: this.audit.all() });
  }

  /**
   * Load state saved earlier. Only into a fresh center. Engines and strategies are rebuilt on demand from
   * each sleeve's record; a trend strategy starts its average again, and a swap that was waiting on the DAO
   * is asked for again on the next tick.
   */
  restoreState(saved: PersistedState) {
    if (this.audit.length || this.state.mandate || this.state.sleeves.length) throw new PersistenceError("state can only be restored into a fresh command center");
    this.state = structuredClone(saved.state);
    this.seq = saved.seq;
    this.audit.restore(saved.audit);
    this.engines.clear();
    this.strategies.clear();
  }

  /** Restore from the repository, if it holds anything. Returns whether it did. */
  async restore(): Promise<boolean> {
    const saved = await this.deps.repository?.load();
    if (!saved) return false;
    this.restoreState(saved);
    this.audit.record("state_restored", { savedAt: saved.savedAt, sleeves: saved.state.sleeves.length });
    return true;
  }

  get sim() {
    return this.deps.sim;
  }

  private now() {
    return this.deps.now();
  }
  private iso() {
    return this.now().toISOString();
  }

  private mandate(): Mandate {
    if (!this.state.mandate) throw new MandateViolationError("mandate_not_set", "the DAO has not set a mandate yet");
    return this.state.mandate;
  }

  private sleeve(id: string): SleeveRecord {
    const s = this.state.sleeves.find((x) => x.id === id);
    if (!s) throw new CommandCenterError("unknown_sleeve", `no sleeve ${id}`);
    return s;
  }

  // ===================================================================================================
  // Governance: everything the DAO decides is a proposal
  // ===================================================================================================

  /** File a proposal, run it if it passes at once, and return it as it now stands. */
  private async file(action: OwnerAction, by: string, summary: string): Promise<Proposal> {
    const p = await this.deps.governance.propose(action, by, summary);
    this.audit.record("proposal_filed", { id: p.id, type: action.type, by, summary, status: p.status });
    await this.settleProposals();
    return (await this.deps.governance.get(p.id)) ?? p;
  }

  /** Cast a member's vote on a pending proposal, then run anything that has now passed. */
  async vote(proposalId: string, member: string, vote: Vote): Promise<Proposal> {
    const p = await this.deps.governance.vote(proposalId, member, vote);
    this.audit.record("vote_cast", { id: p.id, member, vote, status: p.status });
    await this.settleProposals();
    return (await this.deps.governance.get(p.id)) ?? p;
  }

  /** Run every proposal that has passed and not yet been run. Returns how many ran. */
  async settleProposals(): Promise<number> {
    if (this.settling) return 0;
    this.settling = true;
    let ran = 0;
    try {
      for (let round = 0; round < 10; round++) {
        const passed = (await this.deps.governance.list()).filter((p) => p.status === "approved");
        if (!passed.length) break;
        for (const p of passed) {
          try {
            await this.execute(p.action);
            await this.deps.governance.markExecuted(p.id, this.iso());
            this.audit.record("proposal_executed", { id: p.id, type: p.action.type });
            ran++;
          } catch (e) {
            await this.deps.governance.markFailed(p.id, errorText(e), this.iso());
            this.audit.record("proposal_failed", { id: p.id, type: p.action.type, error: errorText(e) });
          }
        }
      }
    } finally {
      this.settling = false;
    }
    await this.persist();
    return ran;
  }

  // ===================================================================================================
  // The mandate
  // ===================================================================================================

  /** Propose a new mandate. It is validated first; nothing changes until the DAO approves it. */
  async setMandate(mandate: Mandate, by: string): Promise<Proposal> {
    validateMandate(mandate);
    return this.file({ type: "set_mandate", mandate }, by, `Set mandate ${mandateDigest(mandate).slice(0, 12)}`);
  }

  /** What changing to `mandate` would change in each sleeve's policy. Read-only; for the vote. */
  async previewMandate(mandate: Mandate): Promise<Array<{ sleeveId: string; changes: ReturnType<typeof diffPolicies> }>> {
    validateMandate(mandate);
    const out = [];
    for (const s of this.state.sleeves) {
      const { policy } = await this.deps.api.getPolicy(s.agentId);
      out.push({ sleeveId: s.id, changes: diffPolicies(policy, this.desiredPolicy(s, mandate)) });
    }
    return out;
  }

  private desiredPolicy(s: SleeveRecord, m: Mandate): Policy {
    return buildSleevePolicy(
      m,
      { stakeAtomic: BigInt(s.stakeAtomic), riskAsset: s.riskAsset, riskCapAtomic: BigInt(s.riskCapAtomic), hold: s.hold },
      { sealed: s.sealed, frozen: s.status === "frozen" },
    );
  }

  private async applyMandate(mandate: Mandate) {
    validateMandate(mandate);
    this.state.mandate = mandate;
    this.state.mandateDigest = mandateDigest(mandate);
    this.audit.record("mandate_set", { digest: this.state.mandateDigest, runwayFloorUsd: mandate.runwayFloorUsd, maxRiskBucketUsd: mandate.maxRiskBucketUsd });
    // Running engines keep their trader/banker; they just pick up the new settings.
    for (const e of this.engines.values()) {
      e.bankerCfg.multipleBps = BigInt(mandate.bankMultipleBps);
      e.bankerCfg.chain = mandate.safe.chain;
      e.bankerCfg.safeAddress = mandate.safe.address;
      e.traderCfg.multipleBps = BigInt(mandate.bankMultipleBps);
      e.traderCfg.slippageBps = BigInt(mandate.slippageBps);
    }
    for (const s of this.state.sleeves) s.policyStale = true;
    await this.syncPolicies();
  }

  /** Bring each sleeve's policy in line with the mandate. A sleeve the API will not edit yet stays stale. */
  async syncPolicies(): Promise<{ synced: number; stale: number }> {
    const out = await this.syncPoliciesNow();
    await this.persist();
    return out;
  }

  private async syncPoliciesNow(): Promise<{ synced: number; stale: number }> {
    const m = this.state.mandate;
    if (!m) return { synced: 0, stale: 0 };
    let synced = 0;
    for (const s of this.state.sleeves) {
      if (!s.policyStale || s.status === "frozen") continue;
      try {
        const { policy, revision } = await this.deps.api.getPolicy(s.agentId);
        const desired = this.desiredPolicy(s, m);
        const changes = diffPolicies(policy, desired);
        if (changes.length && revision !== null) {
          const next = await this.deps.api.updatePolicy(s.agentId, desired, revision);
          s.policyRevision = next.revision;
          this.audit.record("policy_synced", { changes: changes.map((c) => c.path), revision: next.revision }, s.id);
        }
        s.policyStale = false;
        s.policyMandateDigest = this.state.mandateDigest;
        synced++;
      } catch (e) {
        if (e instanceof AgentApiError && e.code === "policy_change_throttled") {
          this.audit.record("policy_sync_deferred", { code: e.code }, s.id);
          continue; // try again on a later tick
        }
        this.audit.record("error", { message: errorText(e) }, s.id);
      }
    }
    return { synced, stale: this.state.sleeves.filter((s) => s.policyStale).length };
  }

  // ===================================================================================================
  // Sleeves
  // ===================================================================================================

  private atRiskMicro(): bigint {
    return this.state.sleeves
      .filter((s) => !s.creditedToTreasury)
      .reduce((sum, s) => sum + BigInt(s.stakeMicroUsd), 0n);
  }

  /** Every mandate rule that applies to opening a sleeve of this size. Throws MandateViolationError. */
  private async checkOpen(riskAsset: string, stakeMicro: bigint) {
    const m = this.mandate();
    if (!m.riskAssets.includes(riskAsset)) throw new MandateViolationError("asset_not_allowed", `${riskAsset} is not a risk asset in the mandate`);
    if (stakeMicro > usdAmount(m.maxSleeveStakeUsd)!) throw new MandateViolationError("stake_exceeds_sleeve_cap", `a sleeve may hold at most ${m.maxSleeveStakeUsd} USD`);
    if (this.atRiskMicro() + stakeMicro > usdAmount(m.maxRiskBucketUsd)!)
      throw new MandateViolationError("risk_bucket_exceeded", `the risk bucket holds at most ${m.maxRiskBucketUsd} USD`);

    const tokens = await this.deps.api.getTokens();
    const stable = tokens.find((t) => t.asset_id === m.stableAsset);
    const risk = tokens.find((t) => t.asset_id === riskAsset);
    const now = this.now();
    const stakeAtomic = microUsdToAtomic(stakeMicro, stable, m.stableAsset, now);
    const floorAtomic = microUsdToAtomic(usdAmount(m.runwayFloorUsd)!, stable, m.stableAsset, now);
    if (BigInt(this.state.treasuryStableAtomic) - stakeAtomic < floorAtomic)
      throw new MandateViolationError("runway_floor_breached", `the treasury must keep ${m.runwayFloorUsd} USD of runway`);
    // Generous enough to sell the whole position after large gains, but still a bound.
    const riskCapAtomic = microUsdToAtomic(stakeMicro * 50n, risk, riskAsset, now);
    return { stakeAtomic, riskCapAtomic };
  }

  /** Propose a new sleeve. The mandate is checked now and again when the DAO's vote passes. */
  async openSleeve(input: OpenSleeveInput, by: string): Promise<Proposal> {
    const stakeMicro = usdAmount(input.stakeUsd);
    if (stakeMicro === null || stakeMicro <= 0n) throw new CommandCenterError("bad_request", "stakeUsd must be a positive USD amount");
    if (!input.name.trim()) throw new CommandCenterError("bad_request", "a sleeve needs a name");
    if (this.state.killed) throw new CommandCenterError("killed", "the kill switch is on; resume first");
    const { stakeAtomic } = await this.checkOpen(input.riskAsset, stakeMicro);
    const action: OwnerAction = {
      type: "open_sleeve",
      sleeveId: `s${++this.seq}`,
      name: input.name.trim(),
      stakeAtomic: stakeAtomic.toString(),
      strategy: input.strategy,
      riskAsset: input.riskAsset,
      hold: input.hold ?? false,
    };
    return this.file(action, by, `Open sleeve "${action.name}" with ${input.stakeUsd} USD`);
  }

  private strategyFor(s: SleeveRecord): Strategy {
    let strategy = this.strategies.get(s.id);
    if (!strategy) {
      strategy = s.strategy.kind === "hold" ? new HoldStrategy() : new TrendStrategy({ alpha: s.strategy.alpha, band: s.strategy.band });
      this.strategies.set(s.id, strategy);
    }
    return strategy;
  }

  private engine(s: SleeveRecord): Engine {
    const existing = this.engines.get(s.id);
    if (existing) return existing;
    const m = this.mandate();
    const api = this.deps.api;
    const grant = api.forGrant(s.grantToken);
    const store = new SleeveStore(s);
    const log = new EventLog();
    log.subscribe((event) => {
      const { type, at, ...rest } = event;
      this.audit.record(type, rest as AuditData, s.id, at);
    });
    const stakeAtomic = BigInt(s.stakeAtomic);
    const stakeMicroUsd = BigInt(s.stakeMicroUsd);
    const bankerCfg: BankerConfig = {
      client: api, grant, agentId: s.agentId, asset: m.stableAsset, stakeAtomic, stakeMicroUsd,
      chain: m.safe.chain, safeAddress: m.safe.address, store, log, now: () => this.now(),
      multipleBps: BigInt(m.bankMultipleBps),
    };
    const traderCfg: TraderConfig = {
      client: api, grant, agentId: s.agentId, stableAsset: m.stableAsset, riskAsset: s.riskAsset, stakeAtomic, stakeMicroUsd,
      strategy: this.strategyFor(s), store, log, now: () => this.now(), multipleBps: BigInt(m.bankMultipleBps),
      maxStableSwap: stakeAtomic, slippageBps: BigInt(m.slippageBps), gate: (intent) => this.gate(s, intent),
    };
    const e: Engine = { banker: new StakeBanker(bankerCfg), trader: new Trader(traderCfg), bankerCfg, traderCfg };
    this.engines.set(s.id, e);
    return e;
  }

  // ===================================================================================================
  // Approvals: large trades, policy holds, and the veto window
  // ===================================================================================================

  /**
   * Called by a sleeve's trader before it sends a swap. A trade that adds risk, and is worth more than the
   * threshold, waits for the DAO. A trade into the stable asset never does: it only reduces risk, and making
   * it wait for a vote would hold a sleeve in a falling market while the council deliberates.
   */
  private async gate(s: SleeveRecord, intent: SwapIntent): Promise<"send" | "held"> {
    if (intent.reason === "raise_cash" || intent.req.destination_asset === this.mandate().stableAsset) return "send";
    if (intent.valueMicroUsd <= usdAmount(this.mandate().approvalThresholdUsd)!) return "send";
    const tokens = await this.deps.api.getTokens();
    const id = `trade:${s.id}:${intent.key}`;
    this.state.approvals.push({
      id,
      kind: "trade_request",
      sleeveId: s.id,
      summary: `${s.name}: swap ${fmtAsset(BigInt(intent.req.amount), intent.req.origin_asset, tokens)} to ${tokens.find((t) => t.asset_id === intent.req.destination_asset)?.symbol ?? "?"}`,
      valueMicroUsd: intent.valueMicroUsd.toString(),
      createdAt: this.iso(),
      expiresAt: new Date(this.now().getTime() + this.approvalTtlMs).toISOString(),
      status: "pending",
      trade: { req: intent.req, key: intent.key, reason: intent.reason },
    });
    this.audit.record("approval_requested", { id, kind: "trade_request", valueUsd: microToUsdString(intent.valueMicroUsd) }, s.id);
    return "held";
  }

  private describeOp(op: Operation, tokens: TokenInfo[]): string {
    if (op.swap) {
      const to = tokens.find((t) => t.asset_id === op.swap!.request.destination_asset)?.symbol ?? "?";
      return `swap ${fmtAsset(BigInt(op.request.amount), op.request.asset, tokens)} to ${to}`;
    }
    return `withdraw ${fmtAsset(BigInt(op.request.amount), op.request.asset, tokens)} to the safe`;
  }

  private opValueMicro(op: Operation, tokens: TokenInfo[]): bigint {
    try {
      return atomicToMicroUsd(BigInt(op.request.amount), tokens.find((t) => t.asset_id === op.request.asset), op.request.asset, this.now());
    } catch {
      return 0n;
    }
  }

  /** Refresh the approvals queue from the API: new holds and veto windows, finished ones, lapsed requests. */
  private async scanApprovals(): Promise<number> {
    const api = this.deps.api;
    const tokens = await api.getTokens();
    const known = new Set(this.state.approvals.map((a) => a.id));
    let added = 0;

    for (const s of this.state.sleeves) {
      for (const op of await api.listScheduledExecutions(s.agentId)) {
        const id = `veto:${op.correlation_id}`;
        if (known.has(id)) continue;
        this.state.approvals.push({
          id, kind: "veto_window", sleeveId: s.id, opId: op.correlation_id, status: "pending",
          summary: `${s.name}: ${this.describeOp(op, tokens)}`, valueMicroUsd: this.opValueMicro(op, tokens).toString(),
          createdAt: this.iso(), expiresAt: op.execute_after,
        });
        known.add(id);
        added++;
      }
      for (const op of await api.listHeldExecutions(s.agentId)) {
        const id = `hold:${op.correlation_id}`;
        if (known.has(id)) continue;
        this.state.approvals.push({
          id, kind: "policy_hold", sleeveId: s.id, opId: op.correlation_id, status: "pending",
          summary: `${s.name}: ${this.describeOp(op, tokens)} (held for the DAO)`, valueMicroUsd: this.opValueMicro(op, tokens).toString(),
          createdAt: this.iso(),
        });
        known.add(id);
        added++;
      }
    }

    for (const a of this.state.approvals) {
      if (a.status !== "pending") continue;
      if (a.kind === "trade_request") {
        if (a.expiresAt && Date.parse(a.expiresAt) <= this.now().getTime()) {
          a.status = "expired";
          a.decidedAt = this.iso();
          this.engine(this.sleeve(a.sleeveId)).trader.discardHeld();
          this.audit.record("approval_expired", { id: a.id }, a.sleeveId);
        }
        continue;
      }
      const op = await api.getStatus(a.opId!);
      const stillWaiting = a.kind === "veto_window" ? op.status === "QUEUED" : op.status === "HELD";
      if (stillWaiting) continue;
      a.status = op.status === "CANCELLED" ? "vetoed" : "executed"; // it ran (or failed) without a veto
      a.decidedAt = this.iso();
      this.audit.record("approval_closed", { id: a.id, outcome: a.status, opStatus: op.status }, a.sleeveId);
    }
    return added;
  }

  /** The DAO's decision on a queue item. It becomes a proposal; a member's call is their vote. */
  async decide(itemId: string, decision: "approve" | "veto", member: string): Promise<{ item: ApprovalRecord; proposal: Proposal }> {
    const item = this.state.approvals.find((a) => a.id === itemId);
    if (!item) throw new CommandCenterError("unknown_approval", `no approval ${itemId}`);
    if (item.status !== "pending") throw new CommandCenterError("not_pending", `${itemId} is already ${item.status}`);

    const existing = (await this.deps.governance.list()).find(
      (p) => p.status === "pending" && p.action.type === "decide_item" && p.action.itemId === itemId && p.action.decision === decision,
    );
    let proposal =
      existing ?? (await this.deps.governance.propose({ type: "decide_item", itemId, decision }, member, `${decision === "veto" ? "Veto" : "Approve"}: ${item.summary}`));
    if (!existing) this.audit.record("proposal_filed", { id: proposal.id, type: "decide_item", by: member, summary: proposal.summary, status: proposal.status });
    if (proposal.status === "pending") proposal = await this.deps.governance.vote(proposal.id, member, "approve");
    this.audit.record("vote_cast", { id: proposal.id, member, vote: "approve", status: proposal.status });
    await this.settleProposals();
    return { item: this.state.approvals.find((a) => a.id === itemId)!, proposal: (await this.deps.governance.get(proposal.id)) ?? proposal };
  }

  private async executeDecision(itemId: string, decision: "approve" | "veto") {
    const item = this.state.approvals.find((a) => a.id === itemId);
    if (!item) throw new CommandCenterError("unknown_approval", `no approval ${itemId}`);
    if (item.status !== "pending") throw new CommandCenterError("not_pending", `${itemId} is already ${item.status}`);
    const s = this.sleeve(item.sleeveId);
    const api = this.deps.api;

    if (item.kind === "trade_request") {
      const trader = this.engine(s).trader;
      if (decision === "veto") {
        trader.discardHeld();
        item.status = "vetoed";
      } else {
        try {
          const op = await api.forGrant(s.grantToken).swap(s.agentId, item.trade!.req, { idempotencyKey: item.trade!.key });
          trader.adopt(op, item.trade!.req, item.trade!.reason);
          item.status = "executed";
        } catch (e) {
          if (!(e instanceof AgentApiError)) throw e;
          // The policy refused what the DAO approved (the agent was frozen meanwhile, say). Nothing was sent.
          trader.discardHeld();
          item.status = "dismissed";
          this.audit.record("approved_trade_refused", { id: item.id, code: e.code }, s.id);
        }
      }
    } else if (item.kind === "policy_hold") {
      if (decision === "approve") {
        await api.releaseHold(s.agentId, item.opId!);
        item.status = "approved";
      } else {
        await api.rejectHold(s.agentId, item.opId!);
        item.status = "vetoed";
      }
    } else if (decision === "veto") {
      await api.cancelExecution(s.agentId, item.opId!);
      item.status = "vetoed";
    } else {
      item.status = "dismissed"; // the DAO looked and chose not to veto
    }
    item.decidedAt = this.iso();
    this.audit.record("approval_decided", { id: item.id, kind: item.kind, decision, outcome: item.status }, s.id);
  }

  // ===================================================================================================
  // Running
  // ===================================================================================================

  /**
   * One pass over every sleeve: the trader decides and trades, the banker banks the stake when it is covered,
   * then the queue and any passed proposals are brought up to date. Does nothing while the kill switch is on.
   */
  async tick(): Promise<TickReport> {
    const report = await this.tickNow();
    await this.persist();
    return report;
  }

  private async tickNow(): Promise<TickReport> {
    const at = this.iso();
    if (!this.state.mandate) return { at, skipped: "no_mandate", sleeves: [], newApprovals: 0, executedProposals: 0 };
    if (this.state.killed) {
      await this.retryResumes();
      if (this.state.killed) {
        this.audit.record("tick_skipped", { reason: "kill_switch" });
        return { at, skipped: "kill_switch", sleeves: [], newApprovals: 0, executedProposals: 0 };
      }
    }

    await this.syncPolicies();
    const report: TickReport = { at, sleeves: [], newApprovals: 0, executedProposals: 0 };
    for (const s of this.state.sleeves) {
      if (s.status !== "active" && s.status !== "banked") {
        report.sleeves.push({ id: s.id, status: s.status });
        continue;
      }
      try {
        const e = this.engine(s);
        await e.trader.step();
        await e.banker.tick();
        await this.afterSleeveTick(s);
        report.sleeves.push({ id: s.id, status: s.status });
      } catch (err) {
        this.audit.record("error", { message: errorText(err) }, s.id);
        report.sleeves.push({ id: s.id, status: s.status, error: errorText(err) });
      }
    }
    await this.retrySeals();
    report.newApprovals = await this.scanApprovals();
    report.executedProposals = await this.settleProposals();
    return report;
  }

  /** React to what the banker did: credit a returned stake, flag a failed exit, ask for the policy to be sealed. */
  private async afterSleeveTick(s: SleeveRecord) {
    const r = s.runner;
    if (r.exitSettled && !s.creditedToTreasury) {
      s.creditedToTreasury = true;
      s.status = "banked";
      s.bankedAt = r.bankedAt ?? this.iso();
      this.state.treasuryStableAtomic = (BigInt(this.state.treasuryStableAtomic) + BigInt(s.stakeAtomic)).toString();
      this.audit.record("stake_banked", { stakeUsd: microToUsdString(BigInt(s.stakeMicroUsd)) }, s.id);
      if (this.mandate().sealAfterBank && !s.sealed && !s.sealRequested) {
        await this.file({ type: "seal_sleeve", sleeveId: s.id }, "system", `Seal ${s.name}: remove withdraw now that its stake is banked`);
      }
    } else if (r.banked && r.settledReported && !r.exitSettled && s.status !== "bank_failed") {
      s.status = "bank_failed";
      this.audit.record("bank_failed", {}, s.id);
    }
  }

  private async attemptSeal(s: SleeveRecord) {
    if (s.sealed || s.status === "frozen") return;
    try {
      const { policy, revision } = await this.deps.api.getPolicy(s.agentId);
      if (!policy || revision === null) return;
      if (policy.actions.includes("withdraw")) {
        const next = await this.deps.api.updatePolicy(s.agentId, sealPolicy(policy), revision);
        s.policyRevision = next.revision;
        this.audit.record("policy_sealed", { revision: next.revision }, s.id);
      }
      s.sealed = true;
    } catch (e) {
      if (e instanceof AgentApiError) {
        this.audit.record("seal_deferred", { code: e.code }, s.id); // the API's edit cooldown; retried on a later tick
        return;
      }
      throw e;
    }
  }

  private async retrySeals() {
    for (const s of this.state.sleeves) if (s.sealRequested && !s.sealed) await this.attemptSeal(s);
  }

  // ===================================================================================================
  // Stopping, resuming, retrying
  // ===================================================================================================

  /**
   * The kill switch. Freezes every sleeve's policy (a pure freeze, which the API lets through its edit
   * cooldown), revokes every grant, and cancels everything queued or held. Acts at once: a panic button
   * cannot wait for a vote. Lifting it is a vote (see `resume`).
   */
  async killSwitch(by: string, reason: string): Promise<KillReport> {
    const report = await this.killNow(by, reason);
    await this.persist();
    return report;
  }

  private async killNow(by: string, reason: string): Promise<KillReport> {
    const api = this.deps.api;
    const report: KillReport = { at: this.iso(), frozen: 0, grantsRevoked: 0, cancelled: 0, approvalsClosed: 0 };
    if (!this.state.killed) this.state.killed = { at: report.at, by, reason };
    this.audit.record("kill_switch", { by, reason });
    await this.persist(); // the stop is on record before any call to the API, so a crash cannot lose it

    for (const s of this.state.sleeves) {
      if (s.status === "frozen") continue;
      try {
        for (const op of [...(await api.listScheduledExecutions(s.agentId)), ...(await api.listHeldExecutions(s.agentId))]) {
          await api.cancelExecution(s.agentId, op.correlation_id);
          report.cancelled++;
        }
        const { policy, revision } = await api.getPolicy(s.agentId);
        if (policy && revision !== null && !policy.frozen) await api.updatePolicy(s.agentId, freezePolicy(policy), revision);
        await api.revokeGrant(s.agentId, s.grantToken);
        report.grantsRevoked++;
        s.resumeStatus = s.status;
        s.status = "frozen";
        report.frozen++;
        this.engine(s).trader.discardHeld();
      } catch (e) {
        this.audit.record("error", { message: `kill switch: ${errorText(e)}` }, s.id);
      }
    }
    for (const a of this.state.approvals) {
      if (a.status !== "pending") continue;
      a.status = "vetoed";
      a.decidedAt = report.at;
      report.approvalsClosed++;
    }
    return report;
  }

  /** Propose lifting the kill switch. Sleeves come back with new grants, never the old ones. */
  async resume(by: string): Promise<Proposal> {
    if (!this.state.killed) throw new CommandCenterError("not_killed", "the kill switch is not on");
    return this.file({ type: "resume" }, by, "Lift the kill switch and resume the sleeves");
  }

  private async resumeSleeve(s: SleeveRecord): Promise<boolean> {
    const api = this.deps.api;
    try {
      const { policy, revision } = await api.getPolicy(s.agentId);
      if (policy?.frozen && revision !== null) await api.updatePolicy(s.agentId, { ...policy, frozen: false }, revision);
      s.grantToken = (await api.issueGrant(s.agentId, `sleeve:${s.id}:resumed`, new Date(this.now().getTime() + this.grantTtlMs))).token;
      this.engines.delete(s.id); // rebuilt around the new grant
      s.status = s.resumeStatus ?? "active";
      delete s.resumeStatus;
      s.resumeRequested = false;
      this.audit.record("sleeve_resumed", {}, s.id);
      return true;
    } catch (e) {
      if (e instanceof AgentApiError && e.code === "policy_change_throttled") {
        s.resumeRequested = true;
        this.audit.record("resume_deferred", { code: e.code }, s.id);
        return false;
      }
      throw e;
    }
  }

  private async retryResumes() {
    for (const s of this.state.sleeves.filter((x) => x.status === "frozen" && x.resumeRequested)) await this.resumeSleeve(s);
    this.liftKillIfDone();
  }

  private liftKillIfDone() {
    if (this.state.killed && !this.state.sleeves.some((s) => s.status === "frozen")) {
      this.audit.record("kill_switch_lifted", {});
      this.state.killed = null;
    }
  }

  /** Propose another attempt at a stake exit the DAO vetoed or the API failed. */
  async retryBank(sleeveId: string, by: string): Promise<Proposal> {
    const s = this.sleeve(sleeveId);
    if (s.status !== "bank_failed") throw new CommandCenterError("not_pending", `${s.name} has no failed exit to retry`);
    return this.file({ type: "retry_bank", sleeveId }, by, `Retry the stake exit for ${s.name}`);
  }

  // ===================================================================================================
  // Executing a passed proposal
  // ===================================================================================================

  private async execute(action: OwnerAction): Promise<void> {
    switch (action.type) {
      case "set_mandate":
        return this.applyMandate(action.mandate);

      case "open_sleeve": {
        const m = this.mandate();
        const api = this.deps.api;
        const tokens = await api.getTokens();
        const stable = tokens.find((t) => t.asset_id === m.stableAsset);
        const stakeAtomic = BigInt(action.stakeAtomic);
        const stakeMicro = atomicToMicroUsd(stakeAtomic, stable, m.stableAsset, this.now());
        const { riskCapAtomic } = await this.checkOpen(action.riskAsset, stakeMicro); // again: the world may have moved since the proposal
        const policy = buildSleevePolicy(m, { stakeAtomic, riskAsset: action.riskAsset, riskCapAtomic, hold: action.hold });
        const { agentId, revision } = await api.provisionAgent(`sleeve-${action.sleeveId}`, policy, { [m.stableAsset]: stakeAtomic.toString() });
        const { token } = await api.issueGrant(agentId, `sleeve:${action.sleeveId}`, new Date(this.now().getTime() + this.grantTtlMs));
        this.state.treasuryStableAtomic = (BigInt(this.state.treasuryStableAtomic) - stakeAtomic).toString();
        this.state.sleeves.push({
          id: action.sleeveId, name: action.name, agentId, grantToken: token, strategy: action.strategy, riskAsset: action.riskAsset,
          stakeAtomic: stakeAtomic.toString(), stakeMicroUsd: stakeMicro.toString(), riskCapAtomic: riskCapAtomic.toString(),
          hold: action.hold, status: "active", openedAt: this.iso(), creditedToTreasury: false, sealed: false, sealRequested: false,
          resumeRequested: false, policyStale: false, policyMandateDigest: this.state.mandateDigest, policyRevision: revision,
          runner: { banked: false },
        });
        this.audit.record("sleeve_opened", { name: action.name, stakeUsd: microToUsdString(stakeMicro), riskAsset: action.riskAsset, strategy: action.strategy.kind, hold: action.hold }, action.sleeveId);
        return;
      }

      case "seal_sleeve": {
        const s = this.sleeve(action.sleeveId);
        s.sealRequested = true;
        return this.attemptSeal(s);
      }

      case "decide_item":
        return this.executeDecision(action.itemId, action.decision);

      case "resume": {
        for (const s of this.state.sleeves.filter((x) => x.status === "frozen")) await this.resumeSleeve(s);
        this.liftKillIfDone();
        return;
      }

      case "retry_bank": {
        const s = this.sleeve(action.sleeveId);
        const ok = await this.engine(s).banker.retry();
        if (!ok) throw new CommandCenterError("not_pending", `${s.name} has no failed exit to retry`);
        s.status = s.creditedToTreasury ? "banked" : "active";
        this.audit.record("bank_retry", { attempt: s.runner.attempt ?? 0 }, s.id);
        return;
      }
    }
  }

  // ===================================================================================================
  // Safety checks and books
  // ===================================================================================================

  /**
   * Try to break a sleeve: every action its policy should refuse. On the mock this is free. Against the live
   * API some probes touch real accounts, so a live run must opt in explicitly.
   */
  async attackTest(sleeveId?: string): Promise<AttackReport[]> {
    const m = this.mandate();
    const targets = sleeveId ? [this.sleeve(sleeveId)] : this.state.sleeves;
    const reports: AttackReport[] = [];
    for (const s of targets) {
      const checks = await runAttackTest({ api: this.deps.api, mandate: m, sleeve: s, now: this.now(), grantTtlMs: this.grantTtlMs });
      const report = { at: this.iso(), sleeveId: s.id, sleeveStatus: s.status, checks, passed: checks.every((c) => c.pass) };
      this.audit.record("attack_test", { passed: report.passed, failed: checks.filter((c) => !c.pass).map((c) => c.id) }, s.id);
      reports.push(report);
    }
    return reports;
  }

  /** Match our own record against what the API reports, sleeve by sleeve. */
  async books(): Promise<Books> {
    const m = this.mandate();
    const tokens = await this.deps.api.getTokens();
    return buildBooks({
      api: this.deps.api,
      mandate: m,
      sleeves: this.state.sleeves,
      tokens,
      now: this.now(),
      treasuryStableAtomic: BigInt(this.state.treasuryStableAtomic),
      audit: this.audit,
    });
  }

  // ===================================================================================================
  // What the API shows
  // ===================================================================================================

  events(afterSeq = 0, limit?: number) {
    return this.audit.list(afterSeq, limit);
  }

  async proposals() {
    return this.deps.governance.list();
  }

  private exitState(r: RunnerState): SleeveView["exit"] {
    if (r.exitSettled) return "settled";
    if (r.banked && r.settledReported) return "failed";
    if (r.banked) return "queued";
    if (r.triggered) return "triggered";
    return "none";
  }

  private async view(s: SleeveRecord, tokens: TokenInfo[]): Promise<SleeveView> {
    const { grantToken: _secret, runner, ...rest } = s;
    void _secret;
    const balances = await this.deps.api.getAgentBalances(s.agentId);
    let equity: bigint | null = null;
    try {
      equity = portfolioValueMicroUsd(balances, tokens, this.now());
    } catch (e) {
      if (!(e instanceof PriceUnavailableError)) throw e;
    }
    const stakeMicro = BigInt(s.stakeMicroUsd);
    const m = this.state.mandate;
    return {
      ...rest,
      stakeUsd: microToUsdString(stakeMicro),
      equityUsd: equity === null ? null : microToUsdString(equity),
      // What the sleeve has made, counting what it already sent back to the treasury.
      pnlUsd: equity === null ? null : microToUsdString(equity + (s.creditedToTreasury ? stakeMicro : 0n) - stakeMicro),
      progressToTrigger:
        equity === null || !m ? null : Number((equity * 10_000n * 1000n) / (stakeMicro * BigInt(m.bankMultipleBps))) / 1000,
      balances,
      exit: this.exitState(runner),
    };
  }

  private approvalView(a: ApprovalRecord): ApprovalView {
    return { ...a, valueUsd: microToUsdString(BigInt(a.valueMicroUsd)), sleeveName: this.state.sleeves.find((s) => s.id === a.sleeveId)?.name ?? a.sleeveId };
  }

  async snapshot(eventLimit = 100): Promise<Snapshot> {
    const tokens = await this.deps.api.getTokens();
    const m = this.state.mandate;
    const tokenOf = (id: string) => tokens.find((t) => t.asset_id === id);
    let stableMicro = 0n;
    let available = 0n;
    if (m) {
      try {
        stableMicro = atomicToMicroUsd(BigInt(this.state.treasuryStableAtomic), tokenOf(m.stableAsset), m.stableAsset, this.now());
      } catch (e) {
        if (!(e instanceof PriceUnavailableError)) throw e;
      }
      const room = usdAmount(m.maxRiskBucketUsd)! - this.atRiskMicro();
      const afterRunway = stableMicro - usdAmount(m.runwayFloorUsd)!;
      available = [room, afterRunway].reduce((a, b) => (a < b ? a : b));
      if (available < 0n) available = 0n;
    }
    const approvals = [...this.state.approvals].map((a) => this.approvalView(a));
    approvals.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
    return {
      mode: "mock",
      now: this.iso(),
      mandate: m,
      mandateDigest: this.state.mandateDigest,
      killed: this.state.killed,
      treasury: {
        stableUsd: microToUsdString(stableMicro),
        runwayFloorUsd: m?.runwayFloorUsd ?? "0",
        availableToAllocateUsd: microToUsdString(available),
        riskBucket: { capUsd: m?.maxRiskBucketUsd ?? "0", atRiskUsd: microToUsdString(this.atRiskMicro()) },
      },
      sleeves: await Promise.all(this.state.sleeves.map((s) => this.view(s, tokens))),
      approvals,
      proposals: await this.deps.governance.list(),
      council: this.deps.governance.council(),
      prices: Object.fromEntries(tokens.map((t) => [t.asset_id, t.price])),
      events: this.audit.list(0, eventLimit),
    };
  }
}
