import type {
  AgentApi,
  ExecutionDetails,
  GenerateIntentRequest,
  GenerateIntentResponse,
  OwnerWallet,
  SignedData,
  StatusResponse,
} from "@near-intents-agent-api/sdk";
import { AgentApiError } from "@/lib/errors";
import type { Balances, Policy, TokenInfo, WithdrawRequest } from "@/lib/policy/types";
import type { AgentClient, GrantClient, OpStatus, Operation } from "./types";

/**
 * Signs an owner intent. For a DAO owner this is the vote: the signature is produced through the DAO's own
 * approval path (an approved proposal that calls the signer contract), not by one person's key. The SDK holds
 * no signers. Return the submission body for `generated.intent`, unchanged.
 */
export interface OwnerSigner {
  sign(generated: GenerateIntentResponse): Promise<SignedData>;
}

/**
 * Moves the DAO's own funds to an agent's deposit address. Funding is not an Agent API action: the money
 * comes from the DAO's treasury, so this is a second thing the DAO must authorise.
 */
export interface Funder {
  fund(target: { agentId: string; asset: string; amount: string; depositAddress: string; memo: string | null; expiresAt: string | null }): Promise<void>;
}

export type LiveOptions = {
  /** The `naa_…` key. Backend only; never log it or send it to a browser. */
  apiKey: string;
  /**
   * The Agent API runs on mainnet with real funds and has no test network. The client refuses to be built
   * unless this is `true`, so spending real money is always a deliberate line in the code.
   */
  realFunds: true;
  /** Who owns the agents this client creates. */
  owner: OwnerWallet;
  signer: OwnerSigner;
  /** Needed only to provision agents that start with money. */
  funder?: Funder;
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Long-poll slice while waiting on an owner intent (the API caps it at 30 s). */
  waitMs?: number;
};

const TERMINAL = new Set<StatusResponse["status"]>(["SUCCESS", "REFUNDED", "FAILED", "UNCERTAIN", "NEEDS_REVIEW"]);
const EXECUTIONS = new Set<StatusResponse["type"]>(["swap", "withdraw", "transfer", "shield", "unshield", "deposit"]);
const HISTORY_PAGE_LIMIT = 100;
const MAX_PAGES = 50;

/**
 * The API's statuses in this app's smaller vocabulary.
 * - `PENDING_APPROVAL` is `HELD`: the policy sent the request to the owner.
 * - `UNCERTAIN` and `NEEDS_REVIEW` stay in flight. The API says never to resubmit either, so neither may look
 *   failed to a caller that would try again under a new key.
 */
export function mapStatus(s: StatusResponse["status"]): OpStatus {
  switch (s) {
    case "SUCCESS":
      return "SUCCESS";
    case "QUEUED":
      return "QUEUED";
    case "PENDING_APPROVAL":
      return "HELD";
    case "REFUNDED":
    case "FAILED":
      return "FAILED";
    default:
      return "PROCESSING"; // PROCESSING, UNCERTAIN, NEEDS_REVIEW, PENDING_SIGNATURE, PENDING_DEPOSIT
  }
}

/**
 * The SDK ships as an ES module only and this project is CommonJS, so it is loaded with a dynamic import.
 * `LiveAgentApi.connect` does that once; everything after it is synchronous to build.
 */
type Sdk = typeof import("@near-intents-agent-api/sdk");

/** Run an SDK call; surface its stable error `code` through the error class the rest of the app handles. */
function translator(sdk: Sdk) {
  return async function translate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof sdk.AgentApiError) throw new AgentApiError(e.code, e.detail ?? e.message, e.status);
      // The call may still have reached the API: callers keep their idempotency key and read the status.
      if (e instanceof sdk.AgentApiRequestError) throw new AgentApiError("transport_error", e.message, 502);
      if (e instanceof sdk.AgentApiResponseTooLargeError) throw new AgentApiError(e.code, e.message, 502);
      throw e;
    }
  };
}

/**
 * The quote object's fields are not pinned down by the API's schema, so read the output amount defensively
 * and return null if it is absent.
 */
export function quoteAmountOut(quote: unknown): string | null {
  const find = (o: unknown, depth = 0): string | null => {
    if (!o || typeof o !== "object" || depth > 2) return null;
    const rec = o as Record<string, unknown>;
    for (const k of ["amountOut", "amount_out", "destination_amount"]) {
      const v = rec[k];
      if ((typeof v === "string" || typeof v === "number") && /^[0-9]+$/.test(String(v))) return String(v);
    }
    for (const v of Object.values(rec)) {
      const r = find(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return find(quote);
}

type ExecutionStatus = Extract<StatusResponse, { details: ExecutionDetails }>;
const isExecution = (s: StatusResponse): s is ExecutionStatus => EXECUTIONS.has(s.type);

/** One execution as this app sees it. The idempotency key is not part of the API's status, so pass it if known. */
export function toOperation(s: StatusResponse, idempotencyKey = ""): Operation {
  const d: ExecutionDetails | Record<string, never> = isExecution(s) ? s.details : {};
  const r = ("request" in d ? d.request : undefined) ?? {};
  const status = mapStatus(s.status);
  const request: WithdrawRequest = {
    asset: r.asset ?? r.origin_asset ?? "",
    amount: r.amount ?? "0",
    chain: r.chain ?? "",
    recipient: r.recipient ?? "",
    ...(r.memo ? { memo: r.memo } : {}),
  };
  const op: Operation = {
    correlation_id: s.correlation_id,
    status,
    request,
    idempotencyKey,
    ...(s.agent_id ? { agentId: s.agent_id } : {}),
    ...(s.failure_code ? { failure_code: s.failure_code } : {}),
    ...(status === "QUEUED" && "execute_after" in d && d.execute_after ? { execute_after: d.execute_after } : {}),
    ...(status === "HELD" ? { held_reason: "owner_approval" as const } : {}),
  };
  if (s.type === "swap") {
    op.swap = {
      request: {
        origin_asset: r.origin_asset ?? "",
        destination_asset: r.destination_asset ?? "",
        amount: r.amount ?? "0",
        ...(r.min_amount_out ? { min_amount_out: r.min_amount_out } : {}),
      },
      ...(s.status === "SUCCESS" && "amount_out" in d && d.amount_out ? { amountOut: d.amount_out } : {}),
    };
  }
  return op;
}

export class LiveConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveConfigError";
  }
}

/**
 * The real NEAR Intents Agent API behind the interfaces the mock implements. Owner actions are
 * generate, sign, submit, wait; agent actions use `forGrant(token)`.
 *
 * It spends real money. It has been exercised only against a fake network that the real SDK talks to; it has
 * never been run against the service. Read `docs/live-agent-api.md` before pointing it at a funded account.
 */
export class LiveAgentApi implements AgentClient {
  private readonly api: AgentApi;
  private readonly waitMs: number;
  private readonly translate: ReturnType<typeof translator>;

  /** Build a client. Checks the options first, so nothing is loaded or sent on a bad configuration. */
  static async connect(opts: LiveOptions): Promise<LiveAgentApi> {
    if ((opts.realFunds as unknown) !== true) throw new LiveConfigError("the Agent API runs on mainnet with real funds; set realFunds: true to use it");
    if (!opts.apiKey.startsWith("naa_")) throw new LiveConfigError("the API key should start with naa_");
    return new LiveAgentApi(opts, await import("@near-intents-agent-api/sdk"));
  }

  private constructor(
    private readonly opts: LiveOptions,
    private readonly sdk: Sdk,
  ) {
    this.api = sdk.createAgentApi({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, fetch: opts.fetch });
    this.waitMs = opts.waitMs ?? 30_000;
    this.translate = translator(sdk);
  }

  /** Follow an operation until the API calls it finished. */
  private async settled(correlationId: string): Promise<StatusResponse> {
    for (;;) {
      const status = await this.api.getStatus(correlationId, { waitMs: this.waitMs });
      if (TERMINAL.has(status.status)) return status;
    }
  }

  /** The four owner steps. Throws the API's failure code unless the intent succeeds. */
  private async ownerAction(request: GenerateIntentRequest, idempotencyKey?: string): Promise<StatusResponse> {
    return this.translate(async () => {
      const generated = await this.api.generateIntent(request, idempotencyKey ? { idempotencyKey } : undefined);
      const signedData = await this.opts.signer.sign(generated);
      await this.api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: signedData });
      const status = await this.settled(generated.correlation_id);
      if (status.status !== "SUCCESS") throw new AgentApiError(status.failure_code ?? status.status, undefined, 409);
      return status;
    });
  }

  async getTokens(): Promise<TokenInfo[]> {
    return this.translate(async () => (await this.api.getTokens()) as unknown as TokenInfo[]);
  }

  async provisionAgent(name: string, policy: Policy, funding: Record<string, string>) {
    const funded = Object.entries(funding).filter(([, amount]) => BigInt(amount) > 0n);
    // Refuse before creating anything: an agent that cannot be funded is an orphan.
    if (funded.length && !this.opts.funder) throw new LiveConfigError("provisioning an agent with funds needs a funder");

    // The key is the name, so asking again after a crash returns the same agent instead of making a second.
    const created = await this.ownerAction(
      { type: "agent_create", name, owner: this.opts.owner, policy: policy as unknown as Extract<GenerateIntentRequest, { type: "agent_create" }>["policy"] },
      `agent_create:${name}`,
    );
    if (created.type !== "agent_create") throw new AgentApiError("unexpected_response", "agent_create returned another operation", 502);
    const agentId = created.details.agent_id;
    const revision = created.details.revision ?? (await this.getPolicy(agentId)).revision ?? 1;

    for (const [asset, amount] of funded) {
      const deposit = await this.translate(() => this.api.deposit(agentId, { origin_asset: asset, amount, confidential: policy.confidential }));
      const d = deposit.details;
      if (!d.deposit_address) throw new AgentApiError("deposit_address_missing", "the API returned no deposit address", 502);
      await this.opts.funder!.fund({ agentId, asset, amount, depositAddress: d.deposit_address, memo: d.memo ?? null, expiresAt: d.expires_at ?? null });
      const done = await this.translate(() => this.settled(deposit.correlation_id));
      if (done.status !== "SUCCESS") throw new AgentApiError(done.failure_code ?? done.status, `funding ${asset} did not complete`, 409);
    }
    return { agentId, revision };
  }

  async getAgentBalances(agentId: string): Promise<Balances> {
    const view = await this.translate(() => this.api.getBalances(agentId, { source: "public" }));
    const balances: Balances = {};
    for (const b of view.balances) balances[b.asset_id] = (BigInt(balances[b.asset_id] ?? "0") + BigInt(b.balance_raw)).toString();
    return balances;
  }

  async getPolicy(agentId: string) {
    const view = await this.translate(() => this.api.getPolicy(agentId));
    return { policy: view.policy as unknown as Policy | null, revision: view.revision };
  }

  async updatePolicy(agentId: string, policy: Policy, expectedRevision: number) {
    const done = await this.ownerAction({
      type: "policy_update",
      agent_id: agentId,
      expected_revision: expectedRevision,
      policy: policy as unknown as Extract<GenerateIntentRequest, { type: "policy_update" }>["policy"],
    });
    const fromStatus = done.type === "policy_update" ? done.details.revision : null;
    return { revision: fromStatus ?? (await this.getPolicy(agentId)).revision ?? expectedRevision + 1 };
  }

  async issueGrant(agentId: string, label: string, expiresAt: Date) {
    const { token, commitment } = this.sdk.createGrantCredential();
    await this.ownerAction({ type: "grant_issue", agent_id: agentId, label, credential: commitment, expires_at: expiresAt.toISOString() });
    return { token };
  }

  async revokeGrant(agentId: string, token: string) {
    const commitment = this.sdk.grantCommitment(token);
    const grants = await this.translate(() => this.api.listGrants(agentId));
    const grant = grants.find((g) => g.owner_message.credential === commitment);
    if (!grant) throw new AgentApiError("grant_not_found", undefined, 404);
    await this.ownerAction({ type: "grant_revoke", agent_id: agentId, grant_id: grant.grant_id });
  }

  forGrant(token: string): GrantClient {
    const grant = this.api.forGrant(token);
    return {
      getBalances: async (agentId) => {
        const view = await this.translate(() => this.api.getBalances(agentId, { source: "public" }));
        const balances: Balances = {};
        // What is free to spend: the balance minus work that is queued or timelocked.
        for (const b of view.balances) balances[b.asset_id] = (BigInt(balances[b.asset_id] ?? "0") + BigInt(b.available_raw)).toString();
        return { balances };
      },
      withdraw: (agentId, req, { idempotencyKey }) =>
        this.translate(async () => {
          const res = await grant.withdraw(
            agentId,
            { asset: req.asset, amount: req.amount, chain: req.chain, recipient: req.recipient, ...(req.memo ? { memo: req.memo } : {}) },
            { idempotencyKey },
          );
          return { ...toOperation(res, idempotencyKey), request: req };
        }),
      quote: (agentId, req) =>
        this.translate(async () => {
          const res = await grant.swap(agentId, { ...req, dry: true });
          const amountOut = quoteAmountOut(res.quote);
          if (amountOut === null) throw new AgentApiError("quote_unavailable", "quote carried no output amount", 502);
          return { amountOut };
        }),
      swap: (agentId, req, { idempotencyKey }) =>
        this.translate(async () => {
          const res = await grant.swap(agentId, req, { idempotencyKey });
          return { ...toOperation(res, idempotencyKey), request: { asset: req.origin_asset, amount: req.amount, chain: "", recipient: "" }, swap: { request: req } };
        }),
      transfer: (agentId, req) =>
        this.translate(async () => {
          const res = await grant.transfer(agentId, req);
          return { ...toOperation(res, res.idempotencyKey), request: { ...req, chain: "near" } };
        }),
    };
  }

  async getStatus(correlationId: string) {
    return toOperation(await this.translate(() => this.api.getStatus(correlationId)));
  }

  async listOperations(agentId: string): Promise<Operation[]> {
    const out: StatusResponse[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.translate(() => this.api.getHistory(agentId, { limit: HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }));
      out.push(...res.data);
      if (!res.next_cursor) {
        // History order is not promised, so sort by when the API recorded each operation. Deposits are
        // funding, not agent actions; the books start from the funded amount.
        return out
          .filter((s) => EXECUTIONS.has(s.type) && s.type !== "deposit")
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((s) => toOperation(s));
      }
      cursor = res.next_cursor;
    }
    // A history this long cannot be reconciled from a truncated read; say so rather than return part of it.
    throw new AgentApiError("history_too_long", `more than ${MAX_PAGES * HISTORY_PAGE_LIMIT} operations`, 502);
  }

  async listScheduledExecutions(agentId: string): Promise<Operation[]> {
    const page = await this.translate(() => this.api.listScheduledExecutions(agentId));
    const ops: Operation[] = [];
    for (const e of page.data) {
      const status = await this.translate(() => this.api.getStatus(e.correlation_id));
      ops.push({ ...toOperation(status), status: "QUEUED", execute_after: e.execute_after });
    }
    return ops;
  }

  async listHeldExecutions(agentId: string): Promise<Operation[]> {
    return (await this.listOperations(agentId)).filter((o) => o.status === "HELD");
  }

  async cancelExecution(agentId: string, correlationId: string) {
    await this.ownerAction({ type: "execution_cancel", agent_id: agentId, correlation_id: correlationId });
    return this.getStatus(correlationId);
  }

  releaseHold(agentId: string, correlationId: string) {
    return this.vote(agentId, correlationId, "approve");
  }

  rejectHold(agentId: string, correlationId: string) {
    return this.vote(agentId, correlationId, "reject");
  }

  /** The owner's vote on a held request: an `approval_vote` intent against the request's approval. */
  private async vote(agentId: string, correlationId: string, verdict: "approve" | "reject") {
    const held = await this.translate(() => this.api.getStatus(correlationId));
    const approvalId = isExecution(held) ? held.details.approval_id : null;
    if (held.status !== "PENDING_APPROVAL" || !approvalId) throw new AgentApiError("not_held", `${correlationId} is not waiting for approval`, 409);
    await this.ownerAction({ type: "approval_vote", agent_id: agentId, approval_id: approvalId, verdict });
    return this.getStatus(correlationId);
  }
}
