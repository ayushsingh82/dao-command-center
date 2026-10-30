import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { KeyPair } from "near-api-js";
import { LiveConfigProblem, createLiveCommandCenter, loadLiveCenterConfig, type LiveCenterConfig } from "@/lib/command-center/live";
import { SputnikDao } from "@/lib/dao/sputnik";
import { exampleMandate } from "@/lib/mandate/example";
import { FakeDao } from "@/lib/testing/fake-dao";
import { FakeFinder, installFakeMpc } from "@/lib/testing/fake-mpc";

const good = {
  CONFIRM_REAL_FUNDS: "yes", NEAR_RPC_URL: "https://rpc.mainnet.fastnear.com", DAO_ACCOUNT_ID: "treasury.sputnik-dao.near", PROPOSER_ACCOUNT_ID: "alice.near",
  PROPOSER_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(), NEAR_INTENTS_AGENT_API_KEY: `naa_${"A".repeat(43)}`, STABLE_TOKEN_ID: "usdc.near",
};

describe("live configuration", () => {
  it("reads a complete environment, with defaults for the optional parts", () => {
    const c = loadLiveCenterConfig(good);
    assert.deepEqual([c.dao, c.networkId, c.mpcSigner, c.scope, c.oneClick, c.stateFile, c.ledgerFile], ["treasury.sputnik-dao.near", "mainnet", "v1.signer", "main", false, ".data/state.json", ".data/ledger.json"]);
  });

  it("refuses to start without the explicit go-ahead to spend real funds", () => {
    assert.throws(() => loadLiveCenterConfig({ ...good, CONFIRM_REAL_FUNDS: undefined }), (e) => e instanceof LiveConfigProblem && /CONFIRM_REAL_FUNDS/.test(e.message));
    assert.throws(() => loadLiveCenterConfig({ ...good, CONFIRM_REAL_FUNDS: "true" }), LiveConfigProblem, "only the exact word counts");
  });

  it("reports every missing or malformed setting at once and never echoes a secret", () => {
    try {
      loadLiveCenterConfig({ NEAR_RPC_URL: "ftp://x", PROPOSER_PRIVATE_KEY: "not-a-key-SECRETVALUE", NEAR_INTENTS_AGENT_API_KEY: "sk-SECRETVALUE", DAO_ACCOUNT_ID: "Bad Account!" });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof LiveConfigProblem);
      for (const name of ["CONFIRM_REAL_FUNDS", "NEAR_RPC_URL", "DAO_ACCOUNT_ID", "PROPOSER_ACCOUNT_ID", "PROPOSER_PRIVATE_KEY", "NEAR_INTENTS_AGENT_API_KEY", "STABLE_TOKEN_ID"]) assert.match(e.message, new RegExp(name));
      assert.ok(!e.message.includes("SECRETVALUE"));
    }
  });
});

describe("the live command center, assembled", () => {
  async function build(files?: { stateFile: string; ledgerFile: string }) {
    const dir = await mkdtemp(join(tmpdir(), "live-center-"));
    const config: LiveCenterConfig = { ...loadLiveCenterConfig(good), stateFile: files?.stateFile ?? join(dir, "state.json"), ledgerFile: files?.ledgerFile ?? join(dir, "ledger.json") };
    const chain = new FakeDao(config.dao, ["alice.near", "bob.near", "carol.near"]);
    installFakeMpc(chain);
    chain.handlers.set("usdc.near.ft_balance_of", () => "20000000000");
    // The Agent API answers one read, the token list, and anything else fails the test.
    const noNetwork = (async (url: string | URL) => {
      if (new URL(String(url)).pathname === "/v1/tokens") return Response.json({ data: [] });
      throw new Error(`the Agent API should not be called for ${String(url)}`);
    }) as unknown as typeof fetch;
    const make = () => createLiveCommandCenter(config, { reader: chain, proposer: chain.sender("alice.near"), finder: new FakeFinder(chain), agentApiFetch: noNetwork, delegate: async () => ({ hash: new Uint8Array(32), bytes: new Uint8Array(100) }) });
    return { chain, config, make, dao: new SputnikDao(config.dao, chain) };
  }

  it("files a decision as a proposal on the DAO, runs it once the council approves, and remembers it across a restart", async () => {
    const { chain, dao, make, config } = await build();
    const cc = await make();
    const proposal = await cc.setMandate(exampleMandate({ daoAccount: config.dao }), "alice.near");
    assert.equal(proposal.status, "pending");
    assert.deepEqual([chain.proposals.length, chain.proposals[0]!.kind], [1, "Vote"]);

    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    await dao.act(chain.sender("bob.near"), 0, "VoteApprove");
    assert.equal(await cc.settleProposals(), 1);
    assert.notEqual((await cc.snapshot()).mandateDigest, "none", "the approved decision was carried out");
    assert.equal((await dao.proposal(0))!.status, "Approved");
  });

  it("restores its state and does not run an approved proposal twice after a restart", async () => {
    const { chain, dao, make, config } = await build();
    const first = await make();
    await first.setMandate(exampleMandate({ daoAccount: config.dao }), "alice.near");
    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    await dao.act(chain.sender("bob.near"), 0, "VoteApprove");
    assert.equal(await first.settleProposals(), 1);
    const digest = (await first.snapshot()).mandateDigest;

    const second = await make();
    assert.equal((await second.snapshot()).mandateDigest, digest, "the state came back from its file");
    assert.equal(await second.settleProposals(), 0, "the ledger says it was already run");
    assert.equal((await second.audit.ofKind("state_restored")).length, 1);
  });

  it("starts the treasury from the DAO's balance of the stable token", async () => {
    const { make } = await build();
    const cc = await make();
    const state = cc.exportState().state;
    assert.equal(state.treasuryStableAtomic, "20000000000");
  });

  it("will not start against an account that is not a DAO", async () => {
    const { chain, config } = await build();
    chain.policyValue = undefined as never;
    chain.view = (async () => null) as typeof chain.view;
    await assert.rejects(createLiveCommandCenter(config, { reader: chain, proposer: chain.sender("alice.near"), finder: new FakeFinder(chain) }), /not a Sputnik DAO/);
  });
});
