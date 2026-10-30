import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { encodeBase58, implicitAccount } from "@/lib/dao/keys";
import { fastNearSignatureFinder, rpcReader } from "@/lib/dao/live";
import type { NearOwner } from "@/lib/dao/signer";

type Seen = { url: string; body: any; headers: Record<string, string> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake JSON-RPC node: answers by method, and for `query` by request type. */
function fakeRpc(answers: { status?: unknown; call?: (a: { account_id: string; method_name: string; args: unknown }) => unknown; account?: (id: string) => unknown }) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, body, headers: init.headers as Record<string, string> });
    let out: unknown;
    if (body.method === "status") out = answers.status;
    else if (body.params.request_type === "call_function") out = answers.call!({ account_id: body.params.account_id, method_name: body.params.method_name, args: JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()) });
    else out = answers.account!(body.params.account_id);
    return Response.json({ jsonrpc: "2.0", id: body.id, ...(out as object) });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}
const bytes = (v: unknown) => ({ result: { result: [...Buffer.from(JSON.stringify(v))], logs: [] } });

describe("rpcReader (fake node)", () => {
  it("calls a view with JSON args and parses the JSON result", async () => {
    const { fetchFn, seen } = fakeRpc({ call: ({ method_name, args }) => bytes({ method_name, args }) });
    const reader = rpcReader({ rpcUrl: "https://rpc.test", fetch: fetchFn, headers: { authorization: "Bearer k" } });
    assert.deepEqual(await reader.view("dao.near", "get_proposal", { id: 3 }), { method_name: "get_proposal", args: { id: 3 } });
    assert.equal(seen[0]!.body.params.finality, "final");
    assert.equal(seen[0]!.headers.authorization, "Bearer k");
  });

  it("answers null when the chain says there is nothing to ask, in either of the shapes it says it", async () => {
    const shapes = [
      { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } },
      { error: { name: "HANDLER_ERROR", cause: { name: "NO_CONTRACT_CODE" } } },
      { result: { error: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))" } },
      { result: { error: "contract code does not exist: CodeDoesNotExist" } },
    ];
    for (const shape of shapes) {
      const { fetchFn } = fakeRpc({ call: () => shape });
      assert.equal(await rpcReader({ rpcUrl: "https://rpc.test", fetch: fetchFn }).view("x.near", "get_policy"), null, JSON.stringify(shape));
    }
  });

  it("throws on a contract panic and on an unreachable node: neither is 'nothing there'", async () => {
    const { fetchFn } = fakeRpc({ call: () => ({ result: { error: "wasm execution failed with error: Smart contract panicked: ERR_NO_PROPOSAL" } }) });
    await assert.rejects(rpcReader({ rpcUrl: "https://rpc.test", fetch: fetchFn }).view("dao.near", "get_proposal", { id: 9 }), /ERR_NO_PROPOSAL/);
    const down = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await assert.rejects(rpcReader({ rpcUrl: "https://rpc.test", fetch: down }).blockHeight(), /unreachable/);
    const bad = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(rpcReader({ rpcUrl: "https://rpc.test", fetch: bad }).view("a", "b"), /503/);
  });

  it("reads the block height and whether an account exists", async () => {
    const { fetchFn } = fakeRpc({
      status: { result: { sync_info: { latest_block_height: 4242 } } },
      account: (id) => (id === "here.near" ? { result: { amount: "1" } } : { error: { cause: { name: "UNKNOWN_ACCOUNT" } } }),
    });
    const reader = rpcReader({ rpcUrl: "https://rpc.test", fetch: fetchFn });
    assert.equal(await reader.blockHeight(), 4242);
    assert.equal(await reader.accountExists("here.near"), true);
    assert.equal(await reader.accountExists("gone.near"), false);
  });

  it("treats an empty result as null", async () => {
    const { fetchFn } = fakeRpc({ call: () => ({ result: { result: [], logs: [] } }) });
    assert.equal(await rpcReader({ rpcUrl: "https://rpc.test", fetch: fetchFn }).view("a", "b"), null);
  });
});

describe("fastNearSignatureFinder (fake FastNear)", () => {
  const sk = ed25519.utils.randomSecretKey();
  const publicKey = `ed25519:${encodeBase58(ed25519.getPublicKey(sk))}`;
  const owner: NearOwner = { type: "near", account_id: implicitAccount(publicKey), public_key: publicKey };
  const hash = "ab".repeat(32);
  const receiptWith = (sig: Uint8Array, scheme = "Ed25519") => ({
    execution_outcome: { outcome: { status: { SuccessValue: Buffer.from(JSON.stringify({ scheme, signature: [...sig] })).toString("base64") } } },
  });

  function fakeFastNear(receipts: unknown[], opts: { pages?: string[][] } = {}) {
    const seen: Seen[] = [];
    const pages = opts.pages ?? [["tx1"]];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url, body, headers: init.headers as Record<string, string> });
      if (String(url).endsWith("/account")) {
        const i = body.resume_token ? Number(body.resume_token) : 0;
        const txs = pages[i] ?? [];
        return Response.json({ account_txs: txs.map((transaction_hash) => ({ transaction_hash })), resume_token: i + 1 < pages.length ? String(i + 1) : undefined });
      }
      return Response.json({ transactions: [{ receipts }] });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  it("finds the DAO's signature in a receipt and checks it against the owner key", async () => {
    const good = ed25519.sign(Buffer.from(hash, "hex"), sk);
    const { fetchFn, seen } = fakeFastNear([receiptWith(good)]);
    const finder = fastNearSignatureFinder({ fetch: fetchFn, apiKey: "k" });
    assert.deepEqual(await finder.find({ dao: "dao.near", owner, hash, since: 77 }), good);
    assert.deepEqual([seen[0]!.body.account_id, seen[0]!.body.is_predecessor, seen[0]!.body.from_tx_block_height], ["dao.near", true, 77]);
    assert.equal(seen[0]!.headers.authorization, "Bearer k");
  });

  it("ignores a signature over another hash, another scheme, junk, and receipts with no value", async () => {
    const other = ed25519.sign(Buffer.alloc(32, 1), sk);
    const { fetchFn } = fakeFastNear([
      receiptWith(other),
      receiptWith(ed25519.sign(Buffer.from(hash, "hex"), sk), "Secp256k1"),
      { execution_outcome: { outcome: { status: { SuccessValue: Buffer.from("not json").toString("base64") } } } },
      { execution_outcome: { outcome: { status: {} } } },
    ]);
    assert.equal(await fastNearSignatureFinder({ fetch: fetchFn }).find({ dao: "dao.near", owner, hash, since: 0 }), null);
  });

  it("does not accept a signature from another key", async () => {
    const stranger = ed25519.sign(Buffer.from(hash, "hex"), ed25519.utils.randomSecretKey());
    const { fetchFn } = fakeFastNear([receiptWith(stranger)]);
    assert.equal(await fastNearSignatureFinder({ fetch: fetchFn }).find({ dao: "dao.near", owner, hash, since: 0 }), null);
  });

  it("reads every page of the DAO's transactions", async () => {
    const good = ed25519.sign(Buffer.from(hash, "hex"), sk);
    const { fetchFn, seen } = fakeFastNear([receiptWith(good)], { pages: [["a"], ["b"], ["c"]] });
    await fastNearSignatureFinder({ fetch: fetchFn }).find({ dao: "dao.near", owner, hash, since: 0 });
    assert.equal(seen.filter((s) => s.url.endsWith("/account")).length, 3);
  });

  it("reports an indexer problem without echoing the key or the transport message", async () => {
    for (const [status, text] of [[401, /authentication/], [429, /rate limit/], [500, /HTTP 500/]] as const) {
      const f = (async () => new Response("secret-detail", { status })) as unknown as typeof fetch;
      await assert.rejects(fastNearSignatureFinder({ fetch: f, apiKey: "KEY-DO-NOT-ECHO" }).find({ dao: "d", owner, hash, since: 0 }), (e: Error) => text.test(e.message) && !/KEY-DO-NOT-ECHO|secret-detail/.test(e.message));
    }
    const down = (async () => {
      throw new TypeError("connect to tx.main.fastnear.com failed: token=abc");
    }) as unknown as typeof fetch;
    await assert.rejects(fastNearSignatureFinder({ fetch: down }).find({ dao: "d", owner, hash, since: 0 }), (e: Error) => /unavailable/.test(e.message) && !/token=abc/.test(e.message));
  });
});
