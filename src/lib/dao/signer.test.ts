import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { GenerateIntentResponse } from "@near-intents-agent-api/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AgentApiError } from "@/lib/errors";
import { nep413Hash, verifyEd25519 } from "@/lib/dao/keys";
import { DaoOwnerSigner, completeSigning, daoOwner, signProposalKind, signedHashOf, type SigningProgress } from "@/lib/dao/signer";
import { SputnikDao } from "@/lib/dao/sputnik";
import { FakeDao } from "@/lib/testing/fake-dao";
import { FakeFinder, installFakeMpc } from "@/lib/testing/fake-mpc";

const DAO = "dao.near";
const MEMBERS = ["alice.near", "bob.near", "carol.near"];
const NONCE = Buffer.alloc(32, 7);

const nep413 = (message = '{"type":"grant_issue"}') => ({ standard: "nep413" as const, payload: { message, nonce: NONCE.toString("base64"), recipient: "api.test" } });

function generated(intent: unknown, over: Partial<GenerateIntentResponse> = {}): GenerateIntentResponse {
  return {
    correlation_id: "corr-1", type: "grant_issue", agent_id: "agent-1", status: "PENDING_SIGNATURE", expires_at: "2026-11-01T00:05:00Z",
    signer: {}, intent, preview: {}, ...over,
  } as unknown as GenerateIntentResponse;
}

/** A DAO with a fake MPC signer, a clock the test moves, and a hook that runs at every wait (to cast votes). */
function world(opts: { threshold?: [number, number] | string; oneClick?: boolean; maxWaitMs?: number; onSleep?: (n: number) => Promise<void> | void } = {}) {
  let t = Date.parse("2026-11-01T00:00:00Z");
  const now = () => new Date(t);
  const chain = new FakeDao(DAO, MEMBERS, { threshold: opts.threshold, now });
  const mpc = installFakeMpc(chain);
  const dao = new SputnikDao(DAO, chain);
  const finder = new FakeFinder(chain);
  const progress: SigningProgress[] = [];
  let sleeps = 0;
  const signer = new DaoOwnerSigner({
    dao, sender: chain.sender("alice.near"), reader: chain, finder, owner: mpc.owner, now, oneClick: opts.oneClick, maxWaitMs: opts.maxWaitMs, pollMs: 1_000,
    sleep: async (ms) => {
      t += ms;
      await opts.onSleep?.(++sleeps);
    },
    onProgress: (p) => progress.push(p),
    delegate: async () => {
      const body = Buffer.alloc(120, 3);
      return { hash: createHash("sha256").update(body).digest(), bytes: Buffer.concat([body, Buffer.alloc(64)]) };
    },
  });
  const vote = (member: string, id = 0) => dao.act(chain.sender(member), id, "VoteApprove");
  return { chain, dao, mpc, signer, finder, progress, vote, advance: (ms: number) => void (t += ms) };
}

describe("the DAO's owner account", () => {
  it("is the implicit account of the key the MPC network derives for the DAO", async () => {
    const { chain, mpc } = world();
    const owner = await daoOwner(chain, DAO);
    assert.deepEqual(owner, mpc.owner);
    assert.match(owner.account_id, /^[0-9a-f]{64}$/);
    await assert.rejects(daoOwner(chain, "someone-else.near"), (e) => e instanceof AgentApiError && e.code === "owner_key_unavailable");
  });
});

describe("the sign proposal", () => {
  it("asks v1.signer to sign exactly one hash on the owner path, and nothing else is mistaken for it", () => {
    const hash = "ab".repeat(32);
    assert.equal(signedHashOf(signProposalKind(hash)), hash);
    assert.equal(signedHashOf(signProposalKind(hash, "other-signer.near")), null);
    assert.equal(signedHashOf("Vote"), null);
    const wrongPath = signProposalKind(hash);
    wrongPath.FunctionCall.actions[0]!.args = Buffer.from(JSON.stringify({ request: { path: "elsewhere", payload_v2: { Eddsa: hash }, domain_id: 1 } })).toString("base64");
    assert.equal(signedHashOf(wrongPath), null);
  });
});

describe("DaoOwnerSigner: a NEP-413 intent", () => {
  it("files a proposal, waits for the council, and returns the intent signed by the DAO's key", async () => {
    const w = world({
      onSleep: async (n) => {
        if (n === 1) await w.vote("alice.near");
        if (n === 2) await w.vote("bob.near");
      },
    });
    const intent = nep413();
    const signed = (await w.signer.sign(generated(intent))) as unknown as { public_key: string; signature: string; standard: string };

    assert.equal(signed.standard, "nep413");
    assert.equal(signed.public_key, w.mpc.publicKey);
    const hash = nep413Hash(intent.payload.message, NONCE, "api.test");
    assert.equal(verifyEd25519(w.mpc.publicKey, hash, Buffer.from(signed.signature, "base64")), true, "the signature really is the DAO key's over the intent's hash");

    const filed = w.chain.proposals[0]!;
    assert.equal(signedHashOf(filed.kind), hash.toString("hex"));
    assert.match(filed.description, /grant_issue/);
    assert.match(filed.description, /agent-1/);
    assert.deepEqual(w.progress.map((p) => p.state), ["waiting", "signed"]);
    assert.equal(w.signer.pending.size, 0);
  });

  it("signs at once when it can file and approve in one transaction", async () => {
    const w = world({ threshold: "1", oneClick: true });
    const signed = await w.signer.sign(generated(nep413()));
    assert.ok((signed as unknown as { signature: string }).signature);
    assert.equal(w.chain.proposals.length, 1);
  });

  it("gives up when the API's window closes, and says the DAO did not sign in time", async () => {
    const w = world();
    const expires = new Date(Date.parse("2026-11-01T00:00:00Z") + 20_000).toISOString();
    await assert.rejects(w.signer.sign(generated(nep413(), { expires_at: expires })), (e) => e instanceof AgentApiError && e.code === "owner_signature_expired");
    assert.equal(w.progress.at(-1)!.state, "expired");
    assert.equal(w.signer.pending.size, 0);
  });

  it("never waits longer than its own limit, whatever the API allows", async () => {
    const w = world({ maxWaitMs: 5_000 });
    const far = new Date(Date.parse("2026-11-01T00:00:00Z") + 86_400_000).toISOString();
    await assert.rejects(w.signer.sign(generated(nep413(), { expires_at: far })), (e) => e instanceof AgentApiError && e.code === "owner_signature_expired");
  });

  it("stops at once when the council rejects", async () => {
    const w = world({
      onSleep: async () => {
        await w.dao.act(w.chain.sender("alice.near"), 0, "VoteReject");
        await w.dao.act(w.chain.sender("bob.near"), 0, "VoteReject");
      },
    });
    await assert.rejects(w.signer.sign(generated(nep413())), (e) => e instanceof AgentApiError && e.code === "owner_signature_refused");
    assert.equal(w.progress.at(-1)!.state, "refused");
  });

  it("does not accept a signature over some other hash, even one the owner key made", async () => {
    const w = world({ threshold: "1" });
    // A passed proposal elsewhere signed a different hash with the same key.
    await w.dao.file(w.chain.sender("alice.near"), "other", signProposalKind("cd".repeat(32)));
    await w.vote("alice.near", 0);
    const early = new Date(Date.parse("2026-11-01T00:00:00Z") + 5_000).toISOString();
    await assert.rejects(w.signer.sign(generated(nep413(), { expires_at: early })), (e) => e instanceof AgentApiError && e.code === "owner_signature_expired");
  });

  it("does not accept a signature made before the request was prepared", async () => {
    const w = world({ threshold: "1" });
    const intent = nep413();
    const hash = nep413Hash(intent.payload.message, NONCE, "api.test").toString("hex");
    await w.dao.file(w.chain.sender("alice.near"), "old", signProposalKind(hash));
    await w.vote("alice.near", 0); // the DAO already signed this hash, earlier
    w.chain.block += 100;
    const early = new Date(Date.parse("2026-11-01T00:00:00Z") + 5_000).toISOString();
    await assert.rejects(w.signer.sign(generated(intent, { expires_at: early })), (e) => e instanceof AgentApiError && e.code === "owner_signature_expired");
  });

  it("reuses an open proposal for the same hash instead of filing a second (a retry after a crash)", async () => {
    const w = world({ threshold: "1" });
    const intent = nep413();
    const hash = nep413Hash(intent.payload.message, NONCE, "api.test").toString("hex");
    await w.dao.file(w.chain.sender("alice.near"), "from before the crash", signProposalKind(hash));
    const early = new Date(Date.parse("2026-11-01T00:00:00Z") + 3_000).toISOString();
    await assert.rejects(w.signer.sign(generated(intent, { expires_at: early })), /owner_signature_expired|did not sign/);
    assert.equal(w.chain.proposals.length, 1, "no second proposal");
    assert.equal(w.progress[0]!.proposalId, 0);
  });

  it("shows members what is waiting while it waits", async () => {
    let seen: SigningProgress | undefined;
    const w = world({
      threshold: "1",
      onSleep: async () => {
        seen = { ...[...w.signer.pending.values()][0]! };
        await w.vote("alice.near");
      },
    });
    await w.signer.sign(generated(nep413()));
    assert.deepEqual([seen?.type, seen?.agentId, seen?.dao, seen?.state], ["grant_issue", "agent-1", DAO, "waiting"]);
    assert.match(seen!.hash, /^[0-9a-f]{64}$/);
  });
});

describe("DaoOwnerSigner: a NEP-366 delegate action", () => {
  const payload = { receiverId: "intents.near", actions: [{ type: "FunctionCall", params: { methodName: "add_public_key", args: {}, gas: "1", deposit: "0" } }] };
  const nep366 = { standard: "nep366" as const, payload };

  it("signs the delegate action's hash and puts the DAO's signature in the last 64 bytes of the exact bytes", async () => {
    const w = world({ threshold: "1", oneClick: true });
    const signed = (await w.signer.sign(generated(nep366, { type: "agent_create" }))) as unknown as { signed_delegate: string; standard: string };
    const bytes = Buffer.from(signed.signed_delegate, "base64");
    assert.equal(bytes.length, 184);
    const body = Buffer.alloc(120, 3);
    assert.deepEqual(bytes.subarray(0, 120), body, "everything before the signature is untouched");
    assert.equal(verifyEd25519(w.mpc.publicKey, createHash("sha256").update(body).digest(), bytes.subarray(120)), true);
  });

  it("refuses to start until the owner account is funded, and files nothing", async () => {
    const w = world();
    w.chain.existing.delete(w.mpc.owner.account_id);
    await assert.rejects(w.signer.sign(generated(nep366)), (e) => e instanceof AgentApiError && e.code === "owner_account_unfunded");
    assert.equal(w.chain.proposals.length, 0);
  });

  it("rejects an intent a NEAR key cannot sign", async () => {
    const w = world();
    await assert.rejects(w.signer.sign(generated({ standard: "eip712", payload: {} })), (e) => e instanceof AgentApiError && e.code === "owner_standard_unsupported");
  });
});

describe("completing a signature", () => {
  it("leaves a NEP-413 intent's fields and adds the key and signature", () => {
    const sk = ed25519.utils.randomSecretKey();
    const owner = { type: "near" as const, account_id: "x", public_key: "ed25519:k" };
    const out = completeSigning({ owner, intent: nep413(), hash: "00", since: 0 }, ed25519.sign(Buffer.alloc(32), sk)) as unknown as Record<string, unknown>;
    assert.deepEqual([out.standard, out.public_key, typeof out.signature], ["nep413", "ed25519:k", "string"]);
  });
});
