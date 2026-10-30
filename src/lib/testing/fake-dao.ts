import { canAct, councilFor, kindLabel } from "@/lib/dao/sputnik";
import type { DaoAction, DaoPolicy, DaoProposal, FunctionCallAction, NearReader, NearSender, SentTransaction } from "@/lib/dao/types";

export const BOND = "100000000000000000000000"; // 0.1 NEAR

type Call = { receiver: string; method: string; args: Record<string, unknown> };
type Handler = (call: Call) => unknown;

/** What a passed proposal did on chain: the calls it made and what came back. */
export type Execution = { proposalId: number; txHash: string; atBlock: number; receiver: string; method: string; args: Record<string, unknown>; result: unknown };

export function defaultPolicy(members: string[], opts: { threshold?: [number, number] | string; extraRoles?: DaoPolicy["roles"] } = {}): DaoPolicy {
  return {
    roles: [{ name: "council", kind: { Group: members }, permissions: ["*:*"], vote_policy: {} }, ...(opts.extraRoles ?? [])],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: opts.threshold ?? [1, 2] },
    proposal_bond: BOND,
    proposal_period: String(7n * 86_400n * 1_000_000_000n),
  };
}

/**
 * A Sputnik DAO v2 in memory: the bond, who may file and vote, thresholds, the kind echo on a vote, one
 * receipt for several actions, and the calls a passed proposal makes. Follows `sputnikdao2`; the sandbox test
 * runs the real contract. It also stands in for the contracts a proposal calls (`handlers`).
 */
export class FakeDao implements NearReader {
  policyValue: DaoPolicy;
  proposals: DaoProposal[] = [];
  executions: Execution[] = [];
  block = 1_000;
  handlers = new Map<string, Handler>();
  unreachable = false;
  existing = new Set<string>();
  private txn = 0;

  constructor(
    readonly dao: string,
    members: string[],
    opts: { threshold?: [number, number] | string; now?: () => Date; policy?: DaoPolicy } = {},
  ) {
    this.policyValue = opts.policy ?? defaultPolicy(members, { threshold: opts.threshold });
    this.nowFn = opts.now ?? (() => new Date());
  }
  private nowFn: () => Date;

  // ---- NearReader -------------------------------------------------------------------------------

  async view<T>(contractId: string, method: string, input: object = {}): Promise<T | null> {
    const args = input as Record<string, unknown>;
    if (this.unreachable) throw new Error("rpc unreachable");
    if (contractId !== this.dao) {
      const h = this.handlers.get(`${contractId}.${method}`);
      return h ? (h({ receiver: contractId, method, args }) as T) : null;
    }
    switch (method) {
      case "get_policy":
        return structuredClone(this.policyValue) as T;
      case "get_last_proposal_id":
        return this.proposals.length as T;
      case "get_proposal": {
        const p = this.proposals[Number(args.id)];
        if (!p) throw new Error("ERR_NO_PROPOSAL");
        return structuredClone(p) as T;
      }
      case "get_proposals": {
        const from = Number(args.from_index ?? 0);
        return structuredClone(this.proposals.slice(from, from + Number(args.limit ?? 50))) as T;
      }
      default:
        return null;
    }
  }

  async blockHeight() {
    return this.block;
  }

  async accountExists(accountId: string) {
    return this.existing.has(accountId) || accountId === this.dao;
  }

  // ---- a sender signing as one account ----------------------------------------------------------

  sender(accountId: string): NearSender {
    return { accountId, send: (receiverId, actions) => this.send(accountId, receiverId, actions) };
  }

  /** One transaction: all its actions succeed, or the state is put back. */
  private async send(from: string, receiverId: string, actions: FunctionCallAction[]): Promise<SentTransaction> {
    if (this.unreachable) throw new Error("rpc unreachable");
    this.block += 1;
    const hash = `tx${++this.txn}`;
    const snapshot = { proposals: structuredClone(this.proposals), executions: structuredClone(this.executions) };
    let returnValue: unknown = null;
    try {
      for (const a of actions) returnValue = this.apply(from, receiverId, a, hash);
    } catch (e) {
      this.proposals = snapshot.proposals;
      this.executions = snapshot.executions;
      throw e;
    }
    return { hash, returnValue };
  }

  private apply(from: string, receiver: string, a: FunctionCallAction, hash: string): unknown {
    if (receiver !== this.dao) {
      const h = this.handlers.get(`${receiver}.${a.methodName}`);
      if (!h) throw new Error(`${receiver} has no ${a.methodName}`);
      return h({ receiver, method: a.methodName, args: a.args as Record<string, unknown> });
    }
    const args = a.args as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (a.methodName === "add_proposal") {
      if (a.deposit !== this.policyValue.proposal_bond) throw new Error("ERR_MIN_BOND");
      const label = kindLabel(args.proposal.kind);
      if (!canAct(this.policyValue, from, label, "AddProposal")) throw new Error("ERR_PERMISSION_DENIED");
      const id = this.proposals.length;
      this.proposals.push({
        id, proposer: from, description: args.proposal.description, kind: args.proposal.kind, status: "InProgress", votes: {},
        submission_time: String(BigInt(this.nowFn().getTime()) * 1_000_000n),
      });
      return id;
    }
    if (a.methodName === "act_proposal") {
      const p = this.proposals[Number(args.id)];
      if (!p) throw new Error("ERR_NO_PROPOSAL");
      const label = kindLabel(p.kind);
      const action = args.action as DaoAction;
      if (!canAct(this.policyValue, from, label, action)) throw new Error("ERR_PERMISSION_DENIED");
      if (args.proposal !== undefined && JSON.stringify(args.proposal) !== JSON.stringify(p.kind)) throw new Error("ERR_WRONG_KIND");
      if (p.status !== "InProgress") throw new Error("ERR_PROPOSAL_NOT_IN_PROGRESS");
      if (p.votes[from]) throw new Error("ERR_ALREADY_VOTED");
      if (action === "VoteApprove") p.votes[from] = "Approve";
      else if (action === "VoteReject") p.votes[from] = "Reject";
      else if (action === "VoteRemove") p.votes[from] = "Remove";
      this.tally(p, hash);
      return null;
    }
    throw new Error(`unknown method ${a.methodName}`);
  }

  private tally(p: DaoProposal, hash: string) {
    const { members, threshold } = councilFor(this.policyValue, kindLabel(p.kind));
    const count = (v: string) => Object.entries(p.votes).filter(([who, vote]) => vote === v && members.includes(who)).length;
    if (count("Approve") >= threshold) {
      p.status = "Approved";
      this.execute(p, hash);
    } else if (count("Reject") > members.length - threshold) {
      p.status = "Rejected";
    }
  }

  private execute(p: DaoProposal, hash: string) {
    const kind = p.kind as { FunctionCall?: { receiver_id: string; actions: Array<{ method_name: string; args: string }> } };
    if (!kind || typeof kind !== "object" || !kind.FunctionCall) return;
    try {
      for (const a of kind.FunctionCall.actions) {
        const args = JSON.parse(Buffer.from(a.args, "base64").toString()) as Record<string, unknown>;
        const h = this.handlers.get(`${kind.FunctionCall.receiver_id}.${a.method_name}`);
        if (!h) throw new Error("no such contract method");
        this.executions.push({
          proposalId: p.id, txHash: hash, atBlock: this.block, receiver: kind.FunctionCall.receiver_id, method: a.method_name, args,
          result: h({ receiver: kind.FunctionCall.receiver_id, method: a.method_name, args }),
        });
      }
    } catch {
      p.status = "Failed";
    }
  }
}
