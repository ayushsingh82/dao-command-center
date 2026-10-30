import type { AuditEntry } from "@/lib/audit/log";
import type { Council, Proposal } from "@/lib/governance/types";
import type { Mandate } from "@/lib/mandate/mandate";
import type { SwapRequest } from "@/lib/agent-api/types";
import type { RunnerState } from "@/lib/runner/store";
import type { StrategySpec } from "@/lib/strategy/strategy";
import type { SwapReason } from "@/lib/strategy/trader";

/**
 * active      trading inside its policy
 * banked      its stake has returned to the treasury; it keeps trading only the gains
 * bank_failed the stake's exit was vetoed or failed; paused until the DAO decides to retry
 * frozen      the kill switch stopped it
 */
export type SleeveStatus = "active" | "banked" | "bank_failed" | "frozen";

export type SleeveRecord = {
  id: string;
  name: string;
  agentId: string;
  /** The sleeve's grant. A secret: never sent to a browser. */
  grantToken: string;
  strategy: StrategySpec;
  riskAsset: string;
  stakeAtomic: string;
  stakeMicroUsd: string;
  /** The risk asset's per-transaction cap in the policy, atomic units. */
  riskCapAtomic: string;
  hold: boolean;
  status: SleeveStatus;
  /** Where to go back to when the kill switch is lifted. */
  resumeStatus?: Exclude<SleeveStatus, "frozen">;
  openedAt: string;
  bankedAt?: string;
  /** The stake has been credited back to the treasury. */
  creditedToTreasury: boolean;
  /** `withdraw` has been removed from the policy. */
  sealed: boolean;
  /** The DAO approved sealing; the policy edit may still be waiting out the API's edit cooldown. */
  sealRequested: boolean;
  /** The DAO approved resuming; the unfreeze may still be waiting out the cooldown. */
  resumeRequested: boolean;
  /** The policy in force differs from what the mandate now asks for. */
  policyStale: boolean;
  /** The digest of the mandate this sleeve's policy was last built from. */
  policyMandateDigest: string;
  policyRevision: number | null;
  runner: RunnerState;
};

export type ApprovalKind = "trade_request" | "policy_hold" | "veto_window";
export type ApprovalStatus = "pending" | "approved" | "vetoed" | "expired" | "executed" | "dismissed";

export type ApprovalRecord = {
  id: string;
  kind: ApprovalKind;
  sleeveId: string;
  summary: string;
  valueMicroUsd: string;
  createdAt: string;
  /** For a veto window, when the request releases; for a trade request, when the request lapses. */
  expiresAt?: string;
  status: ApprovalStatus;
  decidedAt?: string;
  /** For a trade request: what to send once the DAO approves. */
  trade?: { req: SwapRequest; key: string; reason: SwapReason };
  /** For a hold or veto window: the operation it is about. */
  opId?: string;
};

export type KillRecord = { at: string; by: string; reason: string };

export type CommandCenterState = {
  mandate: Mandate | null;
  mandateDigest: string;
  /** The DAO's stable balance that is not in a sleeve, atomic units. */
  treasuryStableAtomic: string;
  sleeves: SleeveRecord[];
  approvals: ApprovalRecord[];
  killed: KillRecord | null;
};

// ---- what the API shows (no secrets, no bigint) -----------------------------------------------

export type SleeveView = Omit<SleeveRecord, "grantToken" | "runner"> & {
  stakeUsd: string;
  /** Null when a balance cannot be priced right now. */
  equityUsd: string | null;
  pnlUsd: string | null;
  /** Equity as a share of the level at which the stake is banked; 1 means at the trigger. */
  progressToTrigger: number | null;
  balances: Record<string, string>;
  exit: "none" | "triggered" | "queued" | "settled" | "failed";
};

export type ApprovalView = ApprovalRecord & { valueUsd: string; sleeveName: string };

export type Snapshot = {
  mode: "mock";
  now: string;
  mandate: Mandate | null;
  mandateDigest: string;
  killed: KillRecord | null;
  treasury: {
    stableUsd: string;
    runwayFloorUsd: string;
    /** What may still be opened as new sleeves without breaching the mandate, USD. */
    availableToAllocateUsd: string;
    riskBucket: { capUsd: string; atRiskUsd: string };
  };
  sleeves: SleeveView[];
  approvals: ApprovalView[];
  proposals: Proposal[];
  council: Council;
  prices: Record<string, number | null>;
  events: AuditEntry[];
};

export type TickReport = {
  at: string;
  skipped?: "kill_switch" | "no_mandate";
  sleeves: Array<{ id: string; status: SleeveStatus; error?: string }>;
  newApprovals: number;
  executedProposals: number;
};

export type KillReport = {
  at: string;
  frozen: number;
  grantsRevoked: number;
  cancelled: number;
  approvalsClosed: number;
};

export type AttackCheck = { id: string; label: string; expected: string; got: string; pass: boolean };
export type AttackReport = {
  at: string;
  sleeveId: string;
  sleeveStatus: SleeveStatus;
  checks: AttackCheck[];
  passed: boolean;
};

export type BooksSleeve = {
  id: string;
  name: string;
  fundedUsd: string;
  withdrawnToSafeUsd: string;
  equityUsd: string | null;
  pnlUsd: string | null;
  /** What the API reports. */
  reportedBalances: Record<string, string>;
  /** What our own record of operations implies. */
  expectedBalances: Record<string, string>;
  /** Assets where the two differ, by how much (reported minus expected, atomic). */
  unexplained: Record<string, string>;
  /** Operations the API has that our audit trail never recorded. */
  unrecordedOperations: string[];
};

export type Books = {
  at: string;
  treasuryStableUsd: string;
  sleeves: BooksSleeve[];
  reconciled: boolean;
};
