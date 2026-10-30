/** What a Sputnik DAO v2 contract returns and accepts, and the two things this code needs from NEAR. */

export type WeightOrRatio = string | number | [number | string, number | string];

export type VotePolicy = { weight_kind?: string; quorum?: string; threshold: WeightOrRatio };

export type DaoRole = {
  name: string;
  /** `"Everyone"`, a named `{Group: [accounts]}`, or token holders `{Member: "balance"}`. */
  kind: "Everyone" | { Group: string[] } | { Member: string } | string;
  /** `<proposal kind>:<action>`, with `*` as a wildcard on either side. */
  permissions: string[];
  /** Per proposal kind, overriding the default. */
  vote_policy: Record<string, VotePolicy>;
};

export type DaoPolicy = {
  roles: DaoRole[];
  default_vote_policy: VotePolicy;
  /** Attached to every `add_proposal`, exactly (yoctoNEAR). */
  proposal_bond: string;
  /** Nanoseconds a proposal stays votable. */
  proposal_period: string;
};

export type FunctionCallKind = {
  FunctionCall: { receiver_id: string; actions: Array<{ method_name: string; args: string; deposit: string; gas: string }> };
};

/** The proposal kinds this code files. (The contract has more.) */
export type ProposalKind = "Vote" | FunctionCallKind | { Transfer: { token_id: string; receiver_id: string; amount: string; msg?: string | null } };

export type DaoVote = "Approve" | "Reject" | "Remove";
export type DaoProposalStatus = "InProgress" | "Approved" | "Rejected" | "Removed" | "Expired" | "Moved" | "Failed";

export type DaoProposal = {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind | Record<string, unknown> | string;
  status: DaoProposalStatus;
  votes: Record<string, DaoVote>;
  /** Nanoseconds since the epoch, as a string. */
  submission_time: string;
};

export type DaoAction = "VoteApprove" | "VoteReject" | "VoteRemove" | "RemoveProposal" | "Finalize";

export type FunctionCallAction = { methodName: string; args: object; gas: string; deposit: string };

/**
 * `final` is safe to act on but lags the newest block by a couple of seconds; `optimistic` is the newest block.
 * Read your own write back with `optimistic`; decide what to do about money with `final`.
 */
export type ViewOptions = { finality?: "final" | "optimistic" };

/** Read access to NEAR. */
export interface NearReader {
  /**
   * A view call. `null` when the chain says the account, contract or method does not exist; any other failure
   * (the RPC is unreachable) throws, because it is no answer at all.
   */
  view<T>(contractId: string, method: string, args?: object, opts?: ViewOptions): Promise<T | null>;
  blockHeight(): Promise<number>;
  accountExists(accountId: string): Promise<boolean>;
}

export type SentTransaction = {
  hash: string;
  /** The last action's return value, parsed from JSON, when it has one. */
  returnValue: unknown;
};

/** Signs and sends transactions as one account. The account's key lives behind this interface. */
export interface NearSender {
  readonly accountId: string;
  /** All `actions` go in one transaction, so they succeed or fail together. Waits until it has executed. */
  send(receiverId: string, actions: FunctionCallAction[]): Promise<SentTransaction>;
}

export class SputnikError extends Error {
  constructor(
    public readonly code: "not_allowed" | "no_such_dao" | "no_such_proposal" | "send_failed" | "bad_response",
    message: string,
  ) {
    super(message);
    this.name = "SputnikError";
  }
}
