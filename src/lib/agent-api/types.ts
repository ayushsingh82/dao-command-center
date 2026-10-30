import type { Balances, Policy, TokenInfo, WithdrawRequest } from "@/lib/policy/types";

/**
 * HELD is this app's name for a request waiting on the owner's approval (policy `owner_approval`); the
 * API calls it PENDING_APPROVAL, and the owner clears it with an `approval_vote` intent. The live client
 * maps between the two. UNCERTAIN and NEEDS_REVIEW are reported as PROCESSING: the API says never to
 * resubmit either.
 */
export type OpStatus = "QUEUED" | "HELD" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED";

export type SwapRequest = {
  origin_asset: string;
  destination_asset: string;
  amount: string;
  /** Refuse a fill worse than this (atomic units of the destination asset). */
  min_amount_out?: string;
};

export type Operation = {
  correlation_id: string;
  status: OpStatus;
  failure_code?: string;
  /** Present while QUEUED: when the timelock releases. */
  execute_after?: string;
  /** Present while HELD. */
  held_reason?: "owner_approval";
  request: WithdrawRequest;
  idempotencyKey: string;
  /** Which agent the operation belongs to. */
  agentId?: string;
  /** Present on swaps. `amountOut` is known once the swap has run. */
  swap?: { request: SwapRequest; amountOut?: string };
};

/** Agent-side surface: what a grant holder can do. */
export interface GrantClient {
  getBalances(agentId: string): Promise<{ balances: Balances }>;
  withdraw(agentId: string, req: WithdrawRequest, opts: { idempotencyKey: string }): Promise<Operation>;
  /** Dry-run quote: expected output in the destination asset's atomic units. Moves nothing. */
  quote(agentId: string, req: SwapRequest): Promise<{ amountOut: string }>;
  /** Timelocked like every money action except deposits: it may return QUEUED and run later. */
  swap(agentId: string, req: SwapRequest, opts: { idempotencyKey: string }): Promise<Operation>;
  /** Present so a test can show it refused when the policy omits "transfer". */
  transfer(agentId: string, req: { asset: string; amount: string; recipient: string }): Promise<Operation>;
}

/** Backend/owner surface. For a DAO owner each mutating call is an owner intent, so it is a vote. */
export interface AgentClient {
  getTokens(): Promise<TokenInfo[]>;
  /**
   * Owner action: create an agent with this policy and fund it from the DAO's balance. Returns the agent's id:
   * the live API assigns it, so `name` is only a label (the mock uses it as the id). Live, this is an
   * agent_create plus a deposit and a funding transfer, each a vote for a DAO owner.
   */
  provisionAgent(name: string, policy: Policy, funding: Record<string, string>): Promise<{ agentId: string; revision: number }>;
  /** The owner's own read of an agent's balances. Works after the agent's grants have been revoked. */
  getAgentBalances(agentId: string): Promise<Balances>;
  getPolicy(agentId: string): Promise<{ policy: Policy | null; revision: number | null }>;
  /** Owner-signed policy_update; `expectedRevision` guards against concurrent edits. */
  updatePolicy(agentId: string, policy: Policy, expectedRevision: number): Promise<{ revision: number }>;
  /** Owner-signed grant_issue; returns the bearer token. */
  issueGrant(agentId: string, label: string, expiresAt: Date): Promise<{ token: string }>;
  revokeGrant(agentId: string, token: string): Promise<void>;
  forGrant(token: string): GrantClient;
  getStatus(correlationId: string): Promise<Operation>;
  /** Every operation the agent has had, oldest first: the API's execution history. */
  listOperations(agentId: string): Promise<Operation[]>;
  listScheduledExecutions(agentId: string): Promise<Operation[]>;
  /** Requests waiting on the owner's approval (policy `owner_approval`). */
  listHeldExecutions(agentId: string): Promise<Operation[]>;
  /** Owner-signed execution_cancel (the veto): works on a queued or held request. */
  cancelExecution(agentId: string, correlationId: string): Promise<Operation>;
  /** Owner approval of a held request. */
  releaseHold(agentId: string, correlationId: string): Promise<Operation>;
  /** Owner rejection of a held request. */
  rejectHold(agentId: string, correlationId: string): Promise<Operation>;
}
