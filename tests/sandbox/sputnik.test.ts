// Runs the REAL Sputnik DAO v2 contract in a local NEAR sandbox, with a stand-in for NEAR's MPC signer, and drives
// it through the same code the command center uses against a live DAO: the RPC reader, the near-kit sender, the
// Sputnik client, the governance, the owner signer, the delegate-action builder and the funder.
//   ./scripts/build-contracts.sh && npm run test:sandbox
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { GenerateIntentResponse } from "@near-intents-agent-api/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Near, decodeSignedDelegateAction } from "near-kit";
import { Worker, type NearAccount } from "near-workspaces";
import { nearKitDelegateBuilder } from "@/lib/dao/delegate";
import { DaoFunder } from "@/lib/dao/funder";
import { SputnikGovernance } from "@/lib/dao/governance";
import { verifyEd25519 } from "@/lib/dao/keys";
import { MemoryLedger } from "@/lib/dao/ledger";
import { nearKitSender, rpcReader } from "@/lib/dao/live";
import { DaoOwnerSigner, daoOwner, type NearOwner, type SignatureFinder } from "@/lib/dao/signer";
import { SputnikDao, councilFor } from "@/lib/dao/sputnik";
import type { NearSender } from "@/lib/dao/types";
import { GovernanceError } from "@/lib/errors";
import type { OwnerAction } from "@/lib/governance/types";

const SPUTNIK_WASM = "contracts/target/sputnik_dao_v2.wasm";
const SIGNER_WASM = "contracts/target/mock_signer.wasm";
const NEAR = 10n ** 24n;
const GAS = 200_000_000_000_000n;
const resume: OwnerAction = { type: "resume" };

async function deploy(root: NearAccount, name: string, wasm: string, args: Record<string, unknown>, balance: bigint): Promise<NearAccount> {
  const account = await root.createSubAccount(name, { initialBalance: balance });
  await account.deploy(wasm);
  await account.call(account, "new", args, { gas: GAS });
  return account;
}

/**
 * Finds the MPC signature the way a real deployment would, from the transactions that passed the proposal; here the
 * test's own senders record their transaction hashes (FastNear, which does this for a live DAO, is a hosted indexer).
 */
class RecordedTxFinder implements SignatureFinder {
  sent: Array<{ hash: string; sender: string }> = [];
  constructor(private rpcUrl: string) {}

  record(sender: NearSender): NearSender {
    return {
      accountId: sender.accountId,
      send: async (receiver, actions) => {
        const tx = await sender.send(receiver, actions);
        this.sent.push({ hash: tx.hash, sender: sender.accountId });
        return tx;
      },
    };
  }

  async find({ owner, hash }: { dao: string; owner: NearOwner; hash: string; since: number }) {
    for (const { hash: txHash, sender } of this.sent) {
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } }),
      });
      const body = (await res.json()) as { result?: { receipts_outcome?: Array<{ outcome: { status: { SuccessValue?: string } } }> } };
      for (const r of body.result?.receipts_outcome ?? []) {
        const value = r.outcome.status.SuccessValue;
        if (!value) continue;
        try {
          const parsed = JSON.parse(Buffer.from(value, "base64").toString());
          if (parsed?.scheme !== "Ed25519" || !Array.isArray(parsed.signature)) continue;
          const signature = Uint8Array.from(parsed.signature);
          if (verifyEd25519(owner.public_key, Buffer.from(hash, "hex"), signature)) return signature;
        } catch {
          // not a signature
        }
      }
    }
    return null;
  }
}

/**
 * The real Sputnik contract uses host functions that near-workspaces' bundled node is too old for. The newer
 * `near-sandbox` package downloads a current node on first use; point near-workspaces at it.
 */
async function useCurrentNode() {
  const { Sandbox } = await import("near-sandbox");
  await (await Sandbox.start({})).tearDown(); // downloads the binary the first time
  const bin = join(dirname(createRequire(import.meta.url).resolve("near-sandbox")), "..", "..", "bin"); // …/near-sandbox/dist/cjs → …/near-sandbox/bin
  const dir = readdirSync(bin).find((d) => d.startsWith("near-sandbox-"));
  if (!dir) throw new Error("near-sandbox's binary was not found");
  // near-workspaces' own copy of near-sandbox looks for the binary in NEAR_SANDBOX_BINARY_PATH (a directory), and
  // overwrites it unless NEAR_SANDBOX_BIN_PATH is set too.
  process.env.NEAR_SANDBOX_BIN_PATH = join(bin, dir, "near-sandbox");
  process.env.NEAR_SANDBOX_BINARY_PATH = join(bin, dir);
}

/** Wait for a read of the final block to show what the newest block already does. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const missing = !existsSync(SPUTNIK_WASM) || !existsSync(SIGNER_WASM) ? "build the contracts first: ./scripts/build-contracts.sh" : false;

describe("the DAO client against the real Sputnik DAO contract", { skip: missing }, () => {
  let worker: Worker;
  let rpcUrl: string;
  let root: NearAccount, dao: NearAccount, mpc: NearAccount;
  let alice: NearAccount, bob: NearAccount, carol: NearAccount, mallory: NearAccount;
  let ownerKey: { secret: Uint8Array; public: string };
  let ownerAccountId: string;
  let reader: ReturnType<typeof rpcReader>;
  let sputnik: SputnikDao;
  let finder: RecordedTxFinder;
  const sender = (a: NearAccount, key: string) => finder.record(nearKitSender({ rpcUrl, networkId: "sandbox", accountId: a.accountId, privateKey: key as `ed25519:${string}` }));
  let senders: Record<string, NearSender> = {};

  before(async () => {
    await useCurrentNode();
    worker = await Worker.init();
    root = worker.rootAccount;
    rpcUrl = (worker.provider.connection as { url: string }).url;
    const make = (n: string) => root.createSubAccount(n, { initialBalance: 30n * NEAR });
    alice = await make("alice");
    bob = await make("bob");
    carol = await make("carol");
    mallory = await make("mallory");

    // The DAO's owner key, as the MPC network would derive it. Its secret stays with the test.
    const seed = ed25519.utils.randomSecretKey();
    ownerKey = { secret: seed, public: `ed25519:${(await import("@/lib/dao/keys")).encodeBase58(ed25519.getPublicKey(seed))}` };
    ownerAccountId = (await import("@/lib/dao/keys")).implicitAccount(ownerKey.public);

    mpc = await deploy(root, "mpc", SIGNER_WASM, { public_key: ownerKey.public, path: "agent-owner" }, 10n * NEAR);
    dao = await deploy(root, "dao", SPUTNIK_WASM, { config: { name: "dao", purpose: "tests", metadata: "" }, policy: [alice.accountId, bob.accountId, carol.accountId] }, 40n * NEAR);

    reader = rpcReader({ rpcUrl });
    sputnik = new SputnikDao(dao.accountId, reader);
    // Reads are of the final block, which trails the one that deployed the contracts by a few seconds.
    for (let i = 0; i < 60; i++) {
      if (await reader.view(dao.accountId, "get_policy").catch(() => null)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    finder = new RecordedTxFinder(rpcUrl);
    senders = {};
    for (const a of [alice, bob, carol, mallory]) senders[a.accountId] = sender(a, String(await a.getKey()));
  });

  after(async () => {
    await worker?.tearDown();
  });

  it("reads the real DAO's policy and works out its council", async () => {
    const policy = await sputnik.policy();
    assert.equal(typeof policy.proposal_bond, "string");
    assert.deepEqual(councilFor(policy, "vote").members.sort(), [alice, bob, carol].map((a) => a.accountId).sort());
    assert.equal(councilFor(policy, "vote").threshold, 2, "half of three, plus one");
    assert.equal(await sputnik.nextProposalId(), 0);
    assert.equal(await sputnik.proposal(5), null, "the contract's panic for a missing proposal is read as 'no proposal'");
    assert.equal(await reader.accountExists(alice.accountId), true);
    assert.equal(await reader.accountExists("nobody.test.near"), false);
    assert.equal(await reader.view("nobody.test.near", "get_policy"), null);
    assert.ok((await reader.blockHeight()) > 0);
  });

  it("files a consent proposal, collects votes from the members, and the command center's governance sees it pass", async () => {
    const ledger = new MemoryLedger();
    const governance = await SputnikGovernance.connect({
      dao: sputnik, proposer: senders[alice.accountId]!, ledger,
      voters: { [alice.accountId]: senders[alice.accountId]!, [bob.accountId]: senders[bob.accountId]! },
    });
    const p = await governance.propose(resume, alice.accountId, "Resume the sleeves");
    assert.deepEqual([p.status, p.threshold, p.members.length], ["pending", 2, 3]);
    const onChain = await dao.view<{ kind: unknown; description: string }>("get_proposal", { id: Number(p.id) });
    assert.equal(onChain.kind, "Vote", "it executes nothing on chain");
    assert.match(onChain.description, /dao-command-center\/v1/);

    assert.equal((await governance.vote(p.id, alice.accountId, "approve")).status, "pending");
    await assert.rejects(governance.vote(p.id, carol.accountId, "approve"), (e) => e instanceof GovernanceError && e.code === "external_vote", "carol votes from her own wallet");
    const passed = await governance.vote(p.id, bob.accountId, "approve");
    assert.equal(passed.status, "approved");
    assert.deepEqual(Object.keys(passed.votes).sort(), [alice.accountId, bob.accountId].sort());

    // The command center acts on what the final block shows, so wait for it, as its settle loop does.
    await until(() => governance.list(), (l) => l.some((x) => x.status === "approved"), "the approval to be final");
    await governance.markExecuted(p.id, "2026-11-02T00:00:00Z");
    assert.equal((await governance.get(p.id))!.status, "executed");
    assert.deepEqual((await governance.list()).map((x) => x.status), ["executed"]);
  });

  it("lets anyone file a consent, as Sputnik's default policy does, but only the council can pass it", async () => {
    const governance = await SputnikGovernance.connect({ dao: sputnik, proposer: senders[mallory.accountId]!, ledger: new MemoryLedger(), voters: { [mallory.accountId]: senders[mallory.accountId]! } });
    const p = await governance.propose({ type: "seal_sleeve", sleeveId: "s1" }, mallory.accountId, "x");
    assert.equal(p.status, "pending", "it is inert until the council approves");
    await assert.rejects(governance.vote(p.id, mallory.accountId, "approve"), (e) => e instanceof GovernanceError && e.code === "not_a_member");
    // Even straight to the contract: she may not vote.
    await assert.rejects(sputnik.act(senders[mallory.accountId]!, Number(p.id), "VoteApprove"), /may not VoteApprove/);
  });

  it("files and approves in one transaction as a member, and a stale id leaves nothing behind", async () => {
    const before = await sputnik.nextProposalId();
    // A one-person approval is not enough on a 2-of-3 DAO: it files and votes, and stays in progress.
    const id = await sputnik.fileAndApprove(senders[alice.accountId]!, "one click", "Vote");
    const p = (await sputnik.proposal(id, "optimistic"))!;
    assert.deepEqual([id, p.status, p.votes], [before, "InProgress", { [alice.accountId]: "Approve" }]);

    const stale = await sputnik.proposals(0, 1); // read, then someone else files first
    assert.ok(stale.length);
    const real = senders[bob.accountId]!;
    await assert.rejects(real.send(dao.accountId, [sputnik.addProposalAction("raced", "Vote", (await sputnik.policy()).proposal_bond), sputnik.actAction(id + 50, "VoteApprove", "Vote")]), /./);
    assert.equal(await sputnik.nextProposalId(), before + 1, "the failed vote rolled the filing back");
  });

  describe("signing owner intents with the DAO's MPC key", () => {
    const signedIntent = async (kind: "nep413" | "nep366") => {
      const owner = await daoOwner(reader, dao.accountId, mpc.accountId);
      assert.deepEqual([owner.public_key, owner.account_id], [ownerKey.public, ownerAccountId], "the owner is what the signer contract derives");
      const intent =
        kind === "nep413"
          ? { standard: "nep413" as const, payload: { message: '{"type":"grant_issue"}', nonce: Buffer.alloc(32, 5).toString("base64"), recipient: "api.test" } }
          : {
              standard: "nep366" as const,
              payload: { receiverId: mpc.accountId, actions: [{ type: "FunctionCall", params: { methodName: "ping", args: {}, gas: "30000000000000", deposit: "0" } }] },
            };
      const generated = { correlation_id: `c-${kind}`, type: kind === "nep413" ? "grant_issue" : "agent_create", agent_id: "agent-1", status: "PENDING_SIGNATURE", expires_at: new Date(Date.now() + 120_000).toISOString(), signer: {}, intent, preview: {} } as unknown as GenerateIntentResponse;

      const signer = new DaoOwnerSigner({
        dao: sputnik, sender: senders[alice.accountId]!, reader, finder, owner, signerContract: mpc.accountId, pollMs: 200, maxWaitMs: 90_000,
        delegate: nearKitDelegateBuilder({ rpcUrl, networkId: "sandbox" }),
        sleep: async (ms) => {
          await new Promise((r) => setTimeout(r, ms));
          const open = [...signer.pending.values()][0];
          if (!open || voted.has(open.hash)) return;
          voted.add(open.hash);
          // The council votes; the MPC network signs the hash when the proposal passes.
          const signature = ed25519.sign(Buffer.from(open.hash, "hex"), ownerKey.secret);
          await mpc.call(mpc, "register", { hash: open.hash, signature: Buffer.from(signature).toString("base64") }, { gas: GAS });
          await sputnik.act(senders[alice.accountId]!, open.proposalId, "VoteApprove");
          await sputnik.act(senders[bob.accountId]!, open.proposalId, "VoteApprove");
        },
      });
      const voted = new Set<string>();
      return { signer, generated, owner, intent };
    };

    it("a NEP-413 intent: the council approves a proposal and the intent comes back signed by the DAO's key", async () => {
      const { signer, generated, owner } = await signedIntent("nep413");
      const signed = (await signer.sign(generated)) as unknown as { signature: string; public_key: string };
      const { nep413Hash } = await import("@/lib/dao/keys");
      assert.equal(signed.public_key, owner.public_key);
      assert.equal(verifyEd25519(owner.public_key, nep413Hash('{"type":"grant_issue"}', Buffer.alloc(32, 5), "api.test"), Buffer.from(signed.signature, "base64")), true);
    });

    it("a NEP-366 delegate action: the DAO's signature makes it valid on chain, and a changed signature does not", async () => {
      // A delegate action needs the owner's access key on chain: fund the implicit account.
      assert.equal(await reader.accountExists(ownerAccountId), false);
      const { signer: unfunded, generated: g0 } = await signedIntent("nep366");
      await assert.rejects(unfunded.sign(g0), /owner_account_unfunded|send NEAR/);

      await root.transfer(ownerAccountId, 2n * NEAR);
      await until(() => reader.accountExists(ownerAccountId), (v) => v, "the owner account to exist");

      const { signer, generated } = await signedIntent("nep366");
      const signed = (await signer.sign(generated)) as unknown as { signed_delegate: string };
      const bytes = Buffer.from(signed.signed_delegate, "base64");

      // A relayer (the Agent API's sponsor, in production) submits it. The chain checks the DAO's signature.
      const relayerKey = String(await mallory.getKey()) as `ed25519:${string}`;
      const relay = new Near({ network: { rpcUrl, networkId: "sandbox" }, privateKey: relayerKey, defaultSignerId: mallory.accountId });
      const forged = Buffer.from(bytes);
      forged[forged.length - 1] = forged[forged.length - 1]! ^ 0xff;
      await assert.rejects(relay.transaction(mallory.accountId).signedDelegateAction(decodeSignedDelegateAction(forged)).send({ waitUntil: "EXECUTED" }));

      const outcome = await relay.transaction(mallory.accountId).signedDelegateAction(decodeSignedDelegateAction(bytes)).send({ waitUntil: "EXECUTED" });
      assert.ok(!(outcome as unknown as { status: { Failure?: unknown } }).status.Failure, "the DAO-signed delegate action ran as the owner account");
    });

    it("stops when the council rejects the signing proposal", async () => {
      const { signer, generated, owner } = await signedIntent("nep413");
      const rejecting = new DaoOwnerSigner({
        dao: sputnik, sender: senders[alice.accountId]!, reader, finder, owner, signerContract: mpc.accountId, pollMs: 200, maxWaitMs: 60_000, delegate: nearKitDelegateBuilder({ rpcUrl, networkId: "sandbox" }),
        sleep: async (ms) => {
          await new Promise((r) => setTimeout(r, ms));
          const open = [...rejecting.pending.values()][0];
          if (open && open.state === "waiting" && !(await sputnik.proposal(open.proposalId, "optimistic"))!.votes[alice.accountId]) {
            await sputnik.act(senders[alice.accountId]!, open.proposalId, "VoteReject");
            await sputnik.act(senders[bob.accountId]!, open.proposalId, "VoteReject");
          }
        },
      });
      void signer;
      const g = { ...generated, intent: { ...generated.intent, payload: { ...(generated.intent as { payload: object }).payload, message: '{"type":"grant_revoke"}' } } } as GenerateIntentResponse;
      await assert.rejects(rejecting.sign(g), /owner_signature_refused|ended Rejected/);
    });
  });

  it("funds an agent: the DAO's proposal registers the deposit address and transfers", async () => {
    const funded: unknown[] = [];
    const funder = new DaoFunder({
      dao: sputnik, sender: senders[alice.accountId]!, pollMs: 300, maxWaitMs: 60_000,
      onProposal: async () => {},
      sleep: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        const last = (await sputnik.nextProposalId()) - 1;
        const p = (await sputnik.proposal(last, "optimistic"))!;
        if (p.status === "InProgress" && /Fund agent/.test(p.description) && !p.votes[alice.accountId]) {
          await sputnik.act(senders[alice.accountId]!, last, "VoteApprove");
          await sputnik.act(senders[bob.accountId]!, last, "VoteApprove");
          funded.push(last);
        }
      },
    });
    await funder.fund({ agentId: "agent-1", asset: `nep141:${mpc.accountId}`, amount: "1000000", depositAddress: "deposit-address.test.near", memo: null, expiresAt: null });
    assert.equal(funded.length, 1);
    const last = (await sputnik.proposal(funded[0] as number))!;
    assert.equal(last.status, "Approved", "the transfer ran and the proposal was not marked failed");
  });
});
