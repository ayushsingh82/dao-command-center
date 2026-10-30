import { GovernanceError } from "@/lib/errors";
import type { Council, Governance, OwnerAction, Proposal, Vote } from "@/lib/governance/types";

export type MockGovernanceOptions = {
  members: string[];
  /** Approvals needed to pass. */
  threshold: number;
  /** Pass every proposal at once. For a demo that should not wait on votes. */
  autoApprove?: boolean;
  now?: () => Date;
};

/**
 * A stand-in for a Sputnik DAO council. It follows the same shape: a proposal is filed, members vote, and
 * it passes once enough approve (or fails once enough reject that it can no longer pass). A live version
 * files real proposals and reads their status from the chain.
 */
export class MockGovernance implements Governance {
  private proposals = new Map<string, Proposal>();
  private seq = 0;
  private readonly members: string[];
  private readonly threshold: number;
  private autoApprove: boolean;
  private readonly now: () => Date;

  constructor(opts: MockGovernanceOptions) {
    if (opts.threshold < 1 || opts.threshold > opts.members.length) throw new Error("threshold must be between 1 and the number of members");
    this.members = [...opts.members];
    this.threshold = opts.threshold;
    this.autoApprove = opts.autoApprove ?? false;
    this.now = opts.now ?? (() => new Date());
  }

  setAutoApprove(on: boolean) {
    this.autoApprove = on;
  }

  council(): Council {
    return { members: [...this.members], threshold: this.threshold, autoApprove: this.autoApprove };
  }

  async propose(action: OwnerAction, proposer: string, summary: string) {
    const p: Proposal = {
      id: `prop-${++this.seq}`,
      action,
      summary,
      proposer,
      createdAt: this.now().toISOString(),
      status: this.autoApprove ? "approved" : "pending",
      votes: {},
      members: [...this.members],
      threshold: this.threshold,
    };
    this.proposals.set(p.id, p);
    return structuredClone(p);
  }

  async vote(id: string, member: string, vote: Vote) {
    const p = this.proposals.get(id);
    if (!p) throw new GovernanceError("unknown_proposal", `no proposal ${id}`);
    if (p.status !== "pending") throw new GovernanceError("not_pending", `proposal ${id} is ${p.status}`);
    if (!this.members.includes(member)) throw new GovernanceError("not_a_member", `${member} is not on the council`);
    if (p.votes[member]) throw new GovernanceError("already_voted", `${member} already voted on ${id}`);
    p.votes[member] = vote;
    const approvals = Object.values(p.votes).filter((v) => v === "approve").length;
    const rejections = Object.values(p.votes).filter((v) => v === "reject").length;
    if (approvals >= this.threshold) p.status = "approved";
    else if (rejections > this.members.length - this.threshold) p.status = "rejected";
    return structuredClone(p);
  }

  async get(id: string) {
    const p = this.proposals.get(id);
    return p ? structuredClone(p) : undefined;
  }

  async list() {
    return [...this.proposals.values()].map((p) => structuredClone(p));
  }

  async markExecuted(id: string, at: string) {
    const p = this.require(id);
    p.status = "executed";
    p.executedAt = at;
    return structuredClone(p);
  }

  async markFailed(id: string, error: string, at: string) {
    const p = this.require(id);
    p.status = "failed";
    p.error = error;
    p.executedAt = at;
    return structuredClone(p);
  }

  private require(id: string) {
    const p = this.proposals.get(id);
    if (!p) throw new GovernanceError("unknown_proposal", `no proposal ${id}`);
    return p;
  }
}
