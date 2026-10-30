import { GovernanceError } from "@/lib/errors";
import type { Council, Governance, OwnerAction, Proposal, ProposalStatus, Vote } from "@/lib/governance/types";
import { consentDescription, parseConsent, type Consent } from "@/lib/dao/consent";
import type { ProposalLedger } from "@/lib/dao/ledger";
import { SputnikDao, canAct, councilFor } from "@/lib/dao/sputnik";
import { SputnikError, type DaoPolicy, type DaoProposal, type NearSender } from "@/lib/dao/types";
import { OwnerActionSchema } from "@/lib/governance/schema";

const DAY_MS = 86_400_000;

export type SputnikGovernanceOptions = {
  dao: SputnikDao;
  /** The account that files proposals. It must be allowed to add `vote` proposals; it need not be a voter. */
  proposer: NearSender;
  ledger: ProposalLedger;
  now?: () => Date;
  /** Tells apart command centers that share one DAO. Part of every proposal, checked on every read. */
  scope?: string;
  /**
   * Members whose keys this backend holds, so it can vote for them. For a test DAO or a DAO of one. A real
   * council votes from its own wallets (Trezu), and `vote` then refuses.
   */
  voters?: Record<string, NearSender>;
  /** File and approve in one transaction when the proposer may also vote. With a one-vote threshold it passes at once. */
  approveOnFiling?: boolean;
  /** How many of the DAO's latest proposals to look through. Default 200. */
  window?: number;
  /** An approved consent not acted on within this long is stale and will not run. Default 30 days. */
  maxAgeMs?: number;
};

const chainStatus = (s: DaoProposal["status"]): ProposalStatus => {
  if (s === "Approved") return "approved";
  if (s === "InProgress") return "pending";
  return "rejected"; // Rejected, Removed, Expired, Moved, Failed
};

/**
 * The command center's `Governance`, with a Sputnik DAO as the council. Every decision is a `Vote` proposal on
 * the DAO (see `consent.ts`); the command center acts when the DAO's own voting approves it, and records that
 * it did in a ledger. Votes are cast on chain by the members; this class reads them.
 */
export class SputnikGovernance implements Governance {
  private policy: DaoPolicy;
  private readonly now: () => Date;
  private readonly scope: string;
  private readonly window: number;
  private readonly maxAgeMs: number;

  private constructor(
    private readonly o: SputnikGovernanceOptions,
    policy: DaoPolicy,
  ) {
    this.policy = policy;
    this.now = o.now ?? (() => new Date());
    this.scope = o.scope ?? "";
    this.window = o.window ?? 200;
    this.maxAgeMs = o.maxAgeMs ?? 30 * DAY_MS;
  }

  /** Read the DAO's policy and build the governance around it. */
  static async connect(o: SputnikGovernanceOptions): Promise<SputnikGovernance> {
    return new SputnikGovernance(o, await o.dao.policy());
  }

  /** Read the policy again, after the DAO has changed its council or thresholds. */
  async refresh(): Promise<void> {
    this.policy = await this.o.dao.policy();
  }

  council(): Council {
    const { members, threshold } = councilFor(this.policy, "vote");
    return { members, threshold, autoApprove: false };
  }

  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SputnikError && e.code === "not_allowed") throw new GovernanceError("not_allowed", e.message);
      if (e instanceof SputnikError || e instanceof Error) throw new GovernanceError("chain_unavailable", e.message);
      throw e;
    }
  }

  private consentOf(p: DaoProposal): Consent | null {
    if (p.kind !== "Vote") return null; // a consent executes nothing; any other kind would do something as well
    return parseConsent(p.description, { dao: this.o.dao.accountId, scope: this.scope });
  }

  private async toProposal(p: DaoProposal, consent: Consent): Promise<Proposal> {
    const council = this.council();
    const filedMs = Number(BigInt(p.submission_time) / 1_000_000n);
    const entry = await this.o.ledger.get(String(p.id));
    const votes: Record<string, Vote> = {};
    for (const [account, v] of Object.entries(p.votes)) votes[account] = v === "Approve" ? "approve" : "reject";

    let status = chainStatus(p.status);
    let error: string | undefined;
    if (status === "approved" && this.now().getTime() - filedMs > this.maxAgeMs) {
      status = "rejected";
      error = "the DAO's approval is too old to act on; file a new proposal";
    }
    if (status === "pending" && this.now().getTime() - filedMs > Number(BigInt(this.policy.proposal_period) / 1_000_000n)) {
      status = "rejected";
      error = "the voting period ended without a decision";
    }
    // What the command center did is recorded here, not on chain. It only applies to an approved proposal.
    if (entry && p.status === "Approved") {
      status = entry.status;
      error = entry.error;
    }
    return {
      id: String(p.id),
      action: consent.action,
      summary: consent.summary,
      proposer: consent.by || p.proposer,
      createdAt: new Date(filedMs).toISOString(),
      status,
      votes,
      members: council.members,
      threshold: council.threshold,
      ...(entry && p.status === "Approved" ? { executedAt: entry.at } : {}),
      ...(error ? { error } : {}),
    };
  }

  async propose(action: OwnerAction, proposer: string, summary: string): Promise<Proposal> {
    const valid = OwnerActionSchema.safeParse(action);
    if (!valid.success) throw new GovernanceError("not_allowed", `not an owner action: ${valid.error.issues.map((i) => i.message).join("; ")}`);
    const description = consentDescription({ dao: this.o.dao.accountId, scope: this.scope, by: proposer, action, summary });
    const mayApprove = canAct(this.policy, this.o.proposer.accountId, "vote", "VoteApprove");
    const id = await this.read(() =>
      this.o.approveOnFiling && mayApprove ? this.o.dao.fileAndApprove(this.o.proposer, description, "Vote") : this.o.dao.file(this.o.proposer, description, "Vote"),
    );
    const filed = await this.get(String(id), "optimistic"); // our own write: it is in the newest block, not yet in a final one
    if (!filed) throw new GovernanceError("chain_unavailable", `proposal ${id} was filed but cannot be read back yet`);
    return filed;
  }

  async get(id: string, finality: "final" | "optimistic" = "final"): Promise<Proposal | undefined> {
    if (!/^\d+$/.test(id)) return undefined;
    const p = await this.read(() => this.o.dao.proposal(Number(id), finality));
    const consent = p && this.consentOf(p);
    return p && consent ? this.toProposal(p, consent) : undefined;
  }

  async list(): Promise<Proposal[]> {
    const proposals = await this.read(() => this.o.dao.recent(this.window));
    const out: Proposal[] = [];
    for (const p of proposals) {
      const consent = this.consentOf(p);
      if (consent) out.push(await this.toProposal(p, consent));
    }
    return out;
  }

  async vote(id: string, member: string, vote: Vote): Promise<Proposal> {
    const p = await this.get(id, "optimistic"); // the contract enforces the vote; this only gives a clearer refusal
    if (!p) throw new GovernanceError("unknown_proposal", `no proposal ${id}`);
    if (p.status !== "pending") throw new GovernanceError("not_pending", `proposal ${id} is ${p.status}`);
    if (!p.members.includes(member)) throw new GovernanceError("not_a_member", `${member} is not on the council`);
    if (p.votes[member]) throw new GovernanceError("already_voted", `${member} already voted on ${id}`);
    const voter = this.o.voters?.[member];
    if (!voter) {
      throw new GovernanceError("external_vote", `${member} votes from their own wallet: approve proposal ${id} on ${this.o.dao.accountId} (for example in Trezu)`);
    }
    await this.read(() => this.o.dao.act(voter, Number(id), vote === "approve" ? "VoteApprove" : "VoteReject"));
    return (await this.get(id, "optimistic"))!;
  }

  private async settle(id: string, entry: { status: "executed" | "failed"; at: string; error?: string }): Promise<Proposal> {
    const p = await this.get(id);
    if (!p) throw new GovernanceError("unknown_proposal", `no proposal ${id}`);
    if (p.status !== "approved") throw new GovernanceError("not_pending", `proposal ${id} is ${p.status}, not approved`);
    await this.o.ledger.put(id, entry);
    return (await this.get(id))!;
  }

  markExecuted(id: string, at: string): Promise<Proposal> {
    return this.settle(id, { status: "executed", at });
  }

  markFailed(id: string, error: string, at: string): Promise<Proposal> {
    return this.settle(id, { status: "failed", at, error });
  }
}
