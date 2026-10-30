import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenerateIntentResponse, OwnerWallet, SignedData } from "@near-intents-agent-api/sdk";
import { AgentApiError } from "@/lib/errors";
import { exampleMandate, RISK, STABLE } from "@/lib/mandate/example";
import { buildSleevePolicy } from "@/lib/mandate/policies";
import { LiveAgentApi, LiveConfigError, mapStatus, quoteAmountOut, toOperation, type Funder, type LiveOptions, type OwnerSigner } from "@/lib/agent-api/live";

const sdk = () => import("@near-intents-agent-api/sdk");
const KEY = `naa_${"A".repeat(43)}`;
const AGENT = "agent-1";
const OWNER: OwnerWallet = { type: "near", account_id: "dao.sputnik-dao.near", public_key: "ed25519:abc" };

// A request body is whatever the SDK sent; tests read fields off it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Seen = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
type Route = (req: Seen) => { status?: number; json: unknown };

/** A fake network: the real SDK builds the requests, this answers them. Unrouted calls fail the test. */
function fakeApi(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    const route = routes[`${req.method} ${req.path}`];
    if (!route) return new Response(JSON.stringify({ errors: [{ code: "unrouted", title: `${req.method} ${req.path}` }] }), { status: 404 });
    const { status = 200, json } = route(req);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const signed: string[] = [];
const signer: OwnerSigner = {
  async sign(g: GenerateIntentResponse) {
    signed.push(g.type);
    return { signed: "by-owner" } as unknown as SignedData;
  },
};

async function client(routes: Record<string, Route>, extra: Partial<LiveOptions> = {}) {
  const net = fakeApi(routes);
  const live = await LiveAgentApi.connect({ apiKey: KEY, realFunds: true, owner: OWNER, signer, fetch: net.fetchFn, waitMs: 1, ...extra });
  return { live, ...net };
}

const status = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  correlation_id: "c-1",
  agent_id: AGENT,
  status: "SUCCESS",
  failure_code: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  dispatch_committed_at: null,
  grant: null,
  details: {},
  ...extra,
});

/** The routes every owner action needs: prepare, submit and a status that says it worked. */
const ownerRoutes = (type: string, id: string, details: Record<string, unknown> = {}, agentId = AGENT): Record<string, Route> => ({
  "POST /v1/generate-intent": () => ({ status: 201, json: { correlation_id: id, type, agent_id: agentId, status: "PENDING_SIGNATURE", expires_at: "2026-12-01T00:00:00Z", signer: OWNER, intent: { standard: "nep366", payload: {} }, preview: {} } }),
  "POST /v1/submit-intent": () => ({ status: 202, json: status(type, { correlation_id: id, status: "PROCESSING" }) }),
  "GET /v1/status": (req) => ({ json: status(type, { correlation_id: req.query.get("correlation_id") ?? id, agent_id: agentId, details }) }),
});

describe("LiveAgentApi: the guard", () => {
  const base = { apiKey: KEY, owner: OWNER, signer };
  it("will not be built without realFunds: true", async () => {
    await assert.rejects(LiveAgentApi.connect({ ...base, realFunds: false as unknown as true }), LiveConfigError);
  });
  it("will not take a key that is not an API key", async () => {
    await assert.rejects(LiveAgentApi.connect({ ...base, apiKey: "ngt_grant", realFunds: true }), /naa_/);
  });
});

describe("LiveAgentApi: the agent's side (through the real SDK, fake network)", () => {
  it("quotes with dry:true and no idempotency key, and reads the output amount", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const { live, seen } = await client({ [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: { dry: true, type: "swap", quote: { quote: { amountOut: "12345" } } } }) });
    assert.deepEqual(await live.forGrant(token).quote(AGENT, { origin_asset: "a", destination_asset: "b", amount: "100" }), { amountOut: "12345" });
    assert.equal(seen[0]!.body.dry, true);
    assert.equal(seen[0]!.headers["idempotency-key"], undefined);
  });

  it("a quote with no output amount is refused, not guessed", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const { live } = await client({ [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: { dry: true, type: "swap", quote: { nothing: 1 } } }) });
    await assert.rejects(live.forGrant(token).quote(AGENT, { origin_asset: "a", destination_asset: "b", amount: "1" }), (e: unknown) => e instanceof AgentApiError && e.code === "quote_unavailable");
  });

  it("swaps under the grant with a minimum output and the caller's key, and reports QUEUED", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const { live, seen } = await client({ [`POST /v1/agents/${AGENT}/swap`]: () => ({ status: 202, json: status("swap", { correlation_id: "c-s", status: "QUEUED" }) }) });
    const op = await live.forGrant(token).swap(AGENT, { origin_asset: "a", destination_asset: "b", amount: "100", min_amount_out: "90" }, { idempotencyKey: "swap:agent-1:1" });
    assert.equal(op.status, "QUEUED");
    assert.equal(op.swap?.request.min_amount_out, "90");
    assert.equal(op.idempotencyKey, "swap:agent-1:1");
    assert.equal(seen[0]!.headers["idempotency-key"], "swap:agent-1:1");
    assert.equal(seen[0]!.headers["x-grant-token"], token);
  });

  it("withdraws under a stable key, and keeps the request it was given", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const { live, seen } = await client({ [`POST /v1/agents/${AGENT}/withdraw`]: () => ({ status: 202, json: status("withdraw", { correlation_id: "c-w", status: "QUEUED" }) }) });
    const req = { asset: STABLE, amount: "1000", chain: "base", recipient: "0xsafe" };
    const op = await live.forGrant(token).withdraw(AGENT, req, { idempotencyKey: "principal:agent-1" });
    assert.deepEqual(op.request, req);
    assert.equal(seen[0]!.headers["idempotency-key"], "principal:agent-1");
    assert.deepEqual(seen[0]!.body, req);
  });

  it("a policy refusal keeps its code and status", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const { live } = await client({
      [`POST /v1/agents/${AGENT}/withdraw`]: () => ({ status: 403, json: { errors: [{ code: "policy_destination_denied", title: "Destination denied", detail: "not in the policy" }], meta: { request_id: "r1" } } }),
    });
    await assert.rejects(
      live.forGrant(token).withdraw(AGENT, { asset: STABLE, amount: "1", chain: "base", recipient: "0xevil" }, { idempotencyKey: "k" }),
      (e) => e instanceof AgentApiError && e.code === "policy_destination_denied" && e.status === 403,
    );
  });

  it("a dropped connection becomes a transport error the caller can retry under the same key", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const live = await LiveAgentApi.connect({
      apiKey: KEY, realFunds: true, owner: OWNER, signer,
      fetch: (async () => {
        throw new TypeError("socket hang up");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(live.forGrant(token).withdraw(AGENT, { asset: STABLE, amount: "1", chain: "base", recipient: "0xsafe" }, { idempotencyKey: "k" }), (e) => e instanceof AgentApiError && e.code === "transport_error");
  });

  it("the agent sees what is free to spend, the owner sees what is held", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const balances = { source: "public", balances: [{ asset_id: STABLE, balance_raw: "1000", available_raw: "400" }, { asset_id: STABLE, balance_raw: "50", available_raw: "50" }] };
    const { live, seen } = await client({ [`GET /v1/agents/${AGENT}/balances`]: () => ({ json: balances }) });
    assert.deepEqual((await live.forGrant(token).getBalances(AGENT)).balances, { [STABLE]: "450" });
    assert.deepEqual(await live.getAgentBalances(AGENT), { [STABLE]: "1050" });
    assert.equal(seen[0]!.query.get("source"), "public");
  });
});

describe("LiveAgentApi: the owner's side", () => {
  it("revokes a grant by the commitment of its token", async () => {
    const { token } = (await sdk()).createGrantCredential();
    const commitment = (await sdk()).grantCommitment(token);
    const { live, seen } = await client({
      [`GET /v1/agents/${AGENT}/grants`]: () => ({ json: { data: [{ grant_id: "g-other", owner_message: { credential: "x" } }, { grant_id: "g-1", owner_message: { credential: commitment } }] } }),
      ...ownerRoutes("grant_revoke", "c-r"),
    });
    await live.revokeGrant(AGENT, token);
    assert.equal(seen.find((s) => s.path === "/v1/generate-intent")!.body.grant_id, "g-1");
  });

  it("refuses to revoke a grant it cannot find", async () => {
    const { live } = await client({ [`GET /v1/agents/${AGENT}/grants`]: () => ({ json: { data: [] } }) });
    await assert.rejects(live.revokeGrant(AGENT, "ngt_missing"), (e) => e instanceof AgentApiError && e.code === "grant_not_found");
  });

  it("issues a grant by sending only its commitment, and gives back the token", async () => {
    const { live, seen } = await client(ownerRoutes("grant_issue", "c-g"));
    const { token } = await live.issueGrant(AGENT, "sleeve:s1", new Date("2026-12-01T00:00:00Z"));
    const sent = seen.find((s) => s.path === "/v1/generate-intent")!.body;
    assert.equal(sent.credential, (await sdk()).grantCommitment(token));
    assert.ok(!JSON.stringify(seen.map((s) => s.body)).includes(token), "the token itself never leaves");
  });

  it("updates a policy with the expected revision and returns the new one", async () => {
    const { live, seen } = await client(ownerRoutes("policy_update", "c-p", { revision: 4 }));
    const policy = buildSleevePolicy(exampleMandate(), { stakeAtomic: 1_000_000n, riskAsset: RISK, riskCapAtomic: 10n });
    assert.deepEqual(await live.updatePolicy(AGENT, policy, 3), { revision: 4 });
    assert.equal(seen.find((s) => s.path === "/v1/generate-intent")!.body.expected_revision, 3);
  });

  it("cancelling an execution is an owner intent, and reports the operation after", async () => {
    const { live, seen } = await client({ ...ownerRoutes("execution_cancel", "c-x") });
    const op = await live.cancelExecution(AGENT, "c-9");
    assert.equal(seen.find((s) => s.path === "/v1/generate-intent")!.body.correlation_id, "c-9");
    assert.equal(op.correlation_id, "c-9");
  });

  it("a failed owner intent throws the API's failure code", async () => {
    const routes = ownerRoutes("policy_update", "c-f");
    routes["GET /v1/status"] = () => ({ json: status("policy_update", { status: "FAILED", failure_code: "policy_revision_conflict", correlation_id: "c-f" }) });
    const { live } = await client(routes);
    const policy = buildSleevePolicy(exampleMandate(), { stakeAtomic: 1n, riskAsset: RISK, riskCapAtomic: 1n });
    await assert.rejects(live.updatePolicy(AGENT, policy, 1), (e) => e instanceof AgentApiError && e.code === "policy_revision_conflict");
  });
});

describe("LiveAgentApi: provisioning", () => {
  const policy = buildSleevePolicy(exampleMandate(), { stakeAtomic: 1_000_000n, riskAsset: RISK, riskCapAtomic: 10n });

  it("creates the agent under a key made from its name, funds it through the funder, and returns the API's id", async () => {
    const funded: unknown[] = [];
    const funder: Funder = { fund: async (t) => void funded.push(t) };
    const routes: Record<string, Route> = {
      ...ownerRoutes("agent_create", "c-c", { agent_id: "agent-xyz", revision: 1 }, "agent-xyz"),
      "POST /v1/agents/agent-xyz/deposit": () => ({ status: 202, json: status("deposit", { correlation_id: "c-d", agent_id: "agent-xyz", status: "PENDING_DEPOSIT", details: { deposit_address: "addr-1", memo: null } }) }),
    };
    const base = routes["GET /v1/status"]!;
    routes["GET /v1/status"] = (req) => (req.query.get("correlation_id") === "c-d" ? { json: status("deposit", { correlation_id: "c-d", agent_id: "agent-xyz" }) } : base(req));
    const { live, seen } = await client(routes, { funder });
    assert.deepEqual(await live.provisionAgent("sleeve-s1", policy, { [STABLE]: "1000000" }), { agentId: "agent-xyz", revision: 1 });
    assert.equal(seen.find((s) => s.path === "/v1/generate-intent")!.headers["idempotency-key"], "agent_create:sleeve-s1");
    assert.deepEqual(funded, [{ agentId: "agent-xyz", asset: STABLE, amount: "1000000", depositAddress: "addr-1", memo: null, expiresAt: null }]);
    assert.deepEqual(seen.find((s) => s.path.endsWith("/deposit"))!.body, { origin_asset: STABLE, amount: "1000000", confidential: false });
  });

  it("refuses before creating anything when it has money to send and no funder", async () => {
    const { live, seen } = await client({});
    await assert.rejects(live.provisionAgent("sleeve-s1", policy, { [STABLE]: "1000000" }), LiveConfigError);
    assert.equal(seen.length, 0, "nothing was sent");
  });

  it("an unfunded agent needs no funder", async () => {
    const { live } = await client(ownerRoutes("agent_create", "c-c", { agent_id: "agent-0", revision: 2 }, "agent-0"));
    assert.deepEqual(await live.provisionAgent("sleeve-s0", policy, {}), { agentId: "agent-0", revision: 2 });
  });
});

describe("LiveAgentApi: history, queue and held requests", () => {
  const swap = (id: string, at: string, extra: Record<string, unknown> = {}) =>
    status("swap", { correlation_id: id, created_at: at, details: { request: { origin_asset: STABLE, destination_asset: RISK, amount: "100" }, ...(extra.details as object) }, ...extra, ...(extra.details ? { details: { request: { origin_asset: STABLE, destination_asset: RISK, amount: "100" }, ...(extra.details as object) } } : {}) });

  it("reads every page of history, oldest first, leaving out deposits and owner intents", async () => {
    const pages: Record<string, { data: unknown[]; next_cursor: string | null }> = {
      first: { data: [swap("c-2", "2026-11-02T00:00:00Z"), status("deposit", { correlation_id: "c-dep" })], next_cursor: "p2" },
      p2: { data: [swap("c-1", "2026-11-01T00:00:00Z"), status("policy_update", { correlation_id: "c-pol" })], next_cursor: null },
    };
    const { live, seen } = await client({ [`GET /v1/agents/${AGENT}/history`]: (req) => ({ json: pages[req.query.get("cursor") ?? "first"] }) });
    assert.deepEqual((await live.listOperations(AGENT)).map((o) => o.correlation_id), ["c-1", "c-2"]);
    assert.equal(seen.length, 2);
  });

  it("carries a settled swap's output amount, so the books can close", async () => {
    const { live } = await client({ [`GET /v1/agents/${AGENT}/history`]: () => ({ json: { data: [swap("c-1", "2026-11-01T00:00:00Z", { details: { amount_out: "77" } })], next_cursor: null } }) });
    const [op] = await live.listOperations(AGENT);
    assert.equal(op!.swap?.amountOut, "77");
    assert.equal(op!.swap?.request.origin_asset, STABLE);
  });

  it("lists the queue with each request's release time", async () => {
    const { live } = await client({
      [`GET /v1/agents/${AGENT}/executions/scheduled`]: () => ({ json: { data: [{ correlation_id: "c-q", execute_after: "2026-11-01T01:00:00Z", state: "waiting", action: "swap" }], next_cursor: null } }),
      "GET /v1/status": () => ({ json: swap("c-q", "2026-11-01T00:00:00Z", { status: "QUEUED" }) }),
    });
    const [op] = await live.listScheduledExecutions(AGENT);
    assert.equal(op!.status, "QUEUED");
    assert.equal(op!.execute_after, "2026-11-01T01:00:00Z");
    assert.equal(op!.swap?.request.destination_asset, RISK);
  });

  it("finds requests waiting on the owner, and votes on them with the approval id", async () => {
    const held = swap("c-h", "2026-11-01T00:00:00Z", { status: "PENDING_APPROVAL", details: { approval_id: "ap-1" } });
    const routes: Record<string, Route> = {
      [`GET /v1/agents/${AGENT}/history`]: () => ({ json: { data: [held, swap("c-ok", "2026-11-01T00:00:00Z")], next_cursor: null } }),
      ...ownerRoutes("approval_vote", "c-v"),
      "POST /v1/generate-intent": () => ({ status: 201, json: { correlation_id: "c-v", type: "approval_vote", agent_id: AGENT, status: "PENDING_SIGNATURE", expires_at: "2026-12-01T00:00:00Z", signer: OWNER, intent: { standard: "nep366", payload: {} }, preview: {} } }),
    };
    const owner = routes["GET /v1/status"]!;
    routes["GET /v1/status"] = (req) => (req.query.get("correlation_id") === "c-h" ? { json: held } : owner(req));
    const { live, seen } = await client(routes);
    const heldOps = await live.listHeldExecutions(AGENT);
    assert.deepEqual(heldOps.map((o) => [o.correlation_id, o.status, o.held_reason]), [["c-h", "HELD", "owner_approval"]]);
    await live.releaseHold(AGENT, "c-h");
    await live.rejectHold(AGENT, "c-h");
    const votes = seen.filter((s) => s.path === "/v1/generate-intent").map((s) => s.body);
    assert.deepEqual(votes.map((v) => [v.type, v.approval_id, v.verdict]), [["approval_vote", "ap-1", "approve"], ["approval_vote", "ap-1", "reject"]]);
  });

  it("will not vote on a request that is not waiting", async () => {
    const { live, seen } = await client({ "GET /v1/status": () => ({ json: swap("c-ok", "2026-11-01T00:00:00Z") }) });
    await assert.rejects(live.releaseHold(AGENT, "c-ok"), (e) => e instanceof AgentApiError && e.code === "not_held");
    assert.ok(!seen.some((s) => s.path === "/v1/generate-intent"));
  });
});

describe("status and quote mapping", () => {
  it("maps every API status; uncertain and needs-review never look failed", () => {
    const table: Array<[Parameters<typeof mapStatus>[0], string]> = [
      ["SUCCESS", "SUCCESS"], ["QUEUED", "QUEUED"], ["PENDING_APPROVAL", "HELD"], ["FAILED", "FAILED"], ["REFUNDED", "FAILED"],
      ["PROCESSING", "PROCESSING"], ["UNCERTAIN", "PROCESSING"], ["NEEDS_REVIEW", "PROCESSING"], ["PENDING_SIGNATURE", "PROCESSING"], ["PENDING_DEPOSIT", "PROCESSING"],
    ];
    for (const [api, ours] of table) assert.equal(mapStatus(api), ours, api);
  });

  it("reads a quote's amount from the shapes seen, and nothing else", () => {
    assert.equal(quoteAmountOut({ amountOut: "5" }), "5");
    assert.equal(quoteAmountOut({ amount_out: 7 }), "7");
    assert.equal(quoteAmountOut({ quote: { amountOut: "9" } }), "9");
    assert.equal(quoteAmountOut({ amountOut: "1.5" }), null);
    assert.equal(quoteAmountOut(null), null);
  });

  it("an owner intent has no request to show, and still converts", () => {
    const op = toOperation(status("policy_update") as never);
    assert.equal(op.request.amount, "0");
    assert.equal(op.status, "SUCCESS");
  });
});
