import {
  SputnikError,
  type DaoAction,
  type DaoPolicy,
  type DaoProposal,
  type DaoRole,
  type FunctionCallAction,
  type NearReader,
  type NearSender,
  type ProposalKind,
  type VotePolicy,
  type WeightOrRatio,
} from "@/lib/dao/types";

/** The label a proposal kind goes by in permissions (`call:VoteApprove`, `vote:AddProposal`, …). */
export function kindLabel(kind: DaoProposal["kind"] | ProposalKind): string {
  if (typeof kind === "string") return kind === "Vote" ? "vote" : kind.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const name = Object.keys(kind)[0] ?? "";
  if (name === "FunctionCall") return "call";
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Whether `permissions` grant `action` on proposals of `kind`, as the contract reads them:
 * `<kind>:<action>`, `<kind>:*`, `*:<action>` or `*:*` (sputnikdao2 `policy.rs`).
 */
export const permits = (permissions: string[], kind: string, action: string) =>
  permissions.some((p) => p === `${kind}:${action}` || p === `${kind}:*` || p === `*:${action}` || p === "*:*");

/** The accounts a role names. `Everyone` and token-weighted roles name none. */
export const groupOf = (role: DaoRole): string[] => (typeof role.kind === "object" && "Group" in role.kind ? role.kind.Group : []);

const everyone = (role: DaoRole) => role.kind === "Everyone";

/** Whether `account` may take `action` on a `kind` proposal under any role it holds. */
export function canAct(policy: DaoPolicy, account: string, kind: string, action: string): boolean {
  return policy.roles.some((r) => (everyone(r) || groupOf(r).includes(account)) && permits(r.permissions, kind, action));
}

/** Votes a role needs to pass a `kind` proposal. A weight is absolute; a ratio is of the role's size, plus one. */
export function votesNeeded(threshold: WeightOrRatio, roleSize: number): number {
  if (Array.isArray(threshold)) {
    const [n, d] = [Number(threshold[0]), Number(threshold[1])];
    return Math.min(Math.floor((roleSize * n) / d) + 1, roleSize);
  }
  return Number(threshold);
}

const votePolicy = (policy: DaoPolicy, role: DaoRole, kind: string): VotePolicy => role.vote_policy[kind] ?? policy.default_vote_policy;

/** The people who can approve `kind` proposals, and the approvals the smallest approving role needs. */
export function councilFor(policy: DaoPolicy, kind: string): { members: string[]; threshold: number } {
  const approvers = policy.roles.filter((r) => groupOf(r).length > 0 && permits(r.permissions, kind, "VoteApprove"));
  const members = [...new Set(approvers.flatMap(groupOf))];
  const needs = approvers.map((r) => votesNeeded(votePolicy(policy, r, kind).threshold, groupOf(r).length));
  return { members, threshold: needs.length ? Math.min(...needs) : 0 };
}

/**
 * Gas attached to the calls. The vote that passes a proposal runs everything the proposal does, so it needs room
 * for it (75 Tgas ran out on a proposal that makes two token calls); unused gas is refunded. Filing and approving
 * share one transaction, which may carry 300 Tgas in all.
 */
const ADD_GAS = "50000000000000";
const ACT_GAS = "200000000000000";

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A Sputnik DAO v2, read through a `NearReader` and written through a `NearSender`. */
export class SputnikDao {
  constructor(
    readonly accountId: string,
    private readonly reader: NearReader,
  ) {}

  async policy(): Promise<DaoPolicy> {
    const policy = await this.reader.view<DaoPolicy>(this.accountId, "get_policy");
    if (!policy) throw new SputnikError("no_such_dao", `${this.accountId} is not a Sputnik DAO (it has no get_policy)`);
    return policy;
  }

  /** The id the next proposal will get. */
  async nextProposalId(finality: "final" | "optimistic" = "optimistic"): Promise<number> {
    // The newest block by default: an id read a block behind is too low, and a combined file-and-vote then fails safely.
    const id = await this.reader.view<number>(this.accountId, "get_last_proposal_id", {}, { finality });
    if (id === null) throw new SputnikError("no_such_dao", `${this.accountId} is not a Sputnik DAO`);
    return Number(id);
  }

  async proposal(id: number, finality: "final" | "optimistic" = "final"): Promise<DaoProposal | null> {
    try {
      return await this.reader.view<DaoProposal>(this.accountId, "get_proposal", { id }, { finality });
    } catch (e) {
      // The contract panics for an id it does not have; the reader reports a missing method, not that.
      if (/no proposal|ERR_NO_PROPOSAL/i.test(text(e))) return null;
      throw e;
    }
  }

  async proposals(fromIndex: number, limit: number): Promise<DaoProposal[]> {
    return (await this.reader.view<DaoProposal[]>(this.accountId, "get_proposals", { from_index: fromIndex, limit })) ?? [];
  }

  /** The newest `limit` proposals, oldest first. */
  async recent(limit: number): Promise<DaoProposal[]> {
    const next = await this.nextProposalId();
    if (next === 0) return [];
    return this.proposals(Math.max(0, next - limit), limit);
  }

  /** The `add_proposal` call. The bond is attached exactly. */
  addProposalAction(description: string, kind: ProposalKind, bond: string): FunctionCallAction {
    return { methodName: "add_proposal", args: { proposal: { description, kind } }, gas: ADD_GAS, deposit: bond };
  }

  /** The `act_proposal` call. Echoing the kind makes the contract check the vote lands on the proposal meant. */
  actAction(id: number, action: DaoAction, kind?: ProposalKind): FunctionCallAction {
    return { methodName: "act_proposal", args: { id, action, ...(kind ? { proposal: kind } : {}) }, gas: ACT_GAS, deposit: "0" };
  }

  private async checkMayFile(account: string, kind: ProposalKind, alsoVote: boolean): Promise<string> {
    const policy = await this.policy();
    const label = kindLabel(kind);
    if (!canAct(policy, account, label, "AddProposal")) throw new SputnikError("not_allowed", `${account} may not file ${label} proposals on ${this.accountId}`);
    if (alsoVote && !canAct(policy, account, label, "VoteApprove")) throw new SputnikError("not_allowed", `${account} may not approve ${label} proposals on ${this.accountId}`);
    return policy.proposal_bond;
  }

  /** File a proposal as `sender`. Returns its id. */
  async file(sender: NearSender, description: string, kind: ProposalKind): Promise<number> {
    const bond = await this.checkMayFile(sender.accountId, kind, false);
    try {
      const sent = await sender.send(this.accountId, [this.addProposalAction(description, kind, bond)]);
      const id = Number(sent.returnValue);
      if (!Number.isInteger(id) || id < 0) throw new SputnikError("bad_response", `add_proposal returned ${JSON.stringify(sent.returnValue)}, not an id`);
      return id;
    } catch (e) {
      if (e instanceof SputnikError) throw e;
      throw new SputnikError("send_failed", `could not file the proposal: ${text(e)}`);
    }
  }

  /**
   * File a proposal and approve it in one transaction, for a member who may do both. `id` is the one the DAO
   * will give it (its `get_last_proposal_id` at filing). The two calls run in one receipt: if `id` is stale the
   * vote fails and nothing is filed, so the vote cannot land on another proposal. With a one-vote threshold the
   * proposal executes at once.
   */
  async fileAndApprove(sender: NearSender, description: string, kind: ProposalKind): Promise<number> {
    const bond = await this.checkMayFile(sender.accountId, kind, true);
    const id = await this.nextProposalId();
    try {
      await sender.send(this.accountId, [this.addProposalAction(description, kind, bond), this.actAction(id, "VoteApprove", kind)]);
      return id;
    } catch (e) {
      throw new SputnikError("send_failed", `could not file and approve the proposal: ${text(e)}`);
    }
  }

  /** Vote on a proposal as `sender`. */
  async act(sender: NearSender, id: number, action: DaoAction): Promise<void> {
    const proposal = await this.proposal(id, "optimistic"); // a vote may follow the filing within seconds
    if (!proposal) throw new SputnikError("no_such_proposal", `${this.accountId} has no proposal ${id}`);
    const policy = await this.policy();
    const label = kindLabel(proposal.kind);
    if (!canAct(policy, sender.accountId, label, action)) throw new SputnikError("not_allowed", `${sender.accountId} may not ${action} ${label} proposals on ${this.accountId}`);
    try {
      await sender.send(this.accountId, [this.actAction(id, action, proposal.kind as ProposalKind)]);
    } catch (e) {
      throw new SputnikError("send_failed", `could not ${action} proposal ${id}: ${text(e)}`);
    }
  }
}
