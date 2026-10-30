import type { Mandate } from "@/lib/mandate/mandate";
import type { StrategySpec } from "@/lib/strategy/strategy";

/**
 * Everything the DAO is asked to decide. For a DAO owner each of these is a proposal that members vote on
 * (a Sputnik proposal, signed through NEAR's MPC network). The command center never acts on a decision
 * until the proposal has passed.
 */
export type OwnerAction =
  | { type: "set_mandate"; mandate: Mandate }
  | {
      type: "open_sleeve";
      sleeveId: string;
      name: string;
      stakeAtomic: string;
      strategy: StrategySpec;
      riskAsset: string;
      hold: boolean;
    }
  | { type: "seal_sleeve"; sleeveId: string }
  | { type: "decide_item"; itemId: string; decision: "approve" | "veto" }
  | { type: "resume" }
  | { type: "retry_bank"; sleeveId: string };

export type Vote = "approve" | "reject";
export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export type Proposal = {
  id: string;
  action: OwnerAction;
  summary: string;
  proposer: string;
  createdAt: string;
  status: ProposalStatus;
  votes: Record<string, Vote>;
  members: string[];
  /** Approvals needed to pass. */
  threshold: number;
  executedAt?: string;
  error?: string;
};

export type Council = { members: string[]; threshold: number; autoApprove: boolean };

export interface Governance {
  propose(action: OwnerAction, proposer: string, summary: string): Promise<Proposal>;
  vote(id: string, member: string, vote: Vote): Promise<Proposal>;
  get(id: string): Promise<Proposal | undefined>;
  list(): Promise<Proposal[]>;
  /** The command center reports back once it has run a passed proposal. */
  markExecuted(id: string, at: string): Promise<Proposal>;
  markFailed(id: string, error: string, at: string): Promise<Proposal>;
  council(): Council;
}
