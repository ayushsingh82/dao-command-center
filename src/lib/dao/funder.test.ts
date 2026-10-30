import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentApiError } from "@/lib/errors";
import { DaoFunder, fundingKind, nearTransferKind } from "@/lib/dao/funder";
import { SputnikDao } from "@/lib/dao/sputnik";
import { FakeDao } from "@/lib/testing/fake-dao";

const DAO = "dao.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const target = { agentId: "agent-1", asset: `nep141:${USDC}`, amount: "1000000", depositAddress: "deposit-addr", memo: null, expiresAt: null };

function setup(opts: { threshold?: string; oneClick?: boolean; onSleep?: (n: number, chain: FakeDao) => Promise<void> | void; maxWaitMs?: number } = {}) {
  let t = Date.parse("2026-11-01T00:00:00Z");
  const now = () => new Date(t);
  const chain = new FakeDao(DAO, ["alice.near", "bob.near"], { threshold: opts.threshold ?? "2", now });
  const calls: Array<{ receiver: string; method: string; args: Record<string, unknown> }> = [];
  for (const m of ["storage_deposit", "ft_transfer"]) chain.handlers.set(`${USDC}.${m}`, (c) => (calls.push(c), null));
  const dao = new SputnikDao(DAO, chain);
  let n = 0;
  const funder = new DaoFunder({
    dao, sender: chain.sender("alice.near"), now, oneClick: opts.oneClick, pollMs: 1_000, maxWaitMs: opts.maxWaitMs,
    sleep: async (ms) => {
      t += ms;
      await opts.onSleep?.(++n, chain);
    },
  });
  return { chain, dao, funder, calls };
}

describe("DaoFunder", () => {
  it("builds a proposal that registers the deposit address and then transfers", () => {
    const kind = fundingKind(USDC, "deposit-addr", "5");
    assert.equal(kind.FunctionCall.receiver_id, USDC);
    const [register, transfer] = kind.FunctionCall.actions.map((a) => ({ method: a.method_name, args: JSON.parse(Buffer.from(a.args, "base64").toString()), deposit: a.deposit }));
    assert.deepEqual(register, { method: "storage_deposit", args: { account_id: "deposit-addr", registration_only: true }, deposit: "1250000000000000000000" });
    assert.deepEqual(transfer, { method: "ft_transfer", args: { receiver_id: "deposit-addr", amount: "5" }, deposit: "1" });
  });

  it("files a funding proposal, waits for the council, and the transfer runs", async () => {
    const s = setup({
      onSleep: async (n, chain) => {
        if (n === 1) await s.dao.act(chain.sender("alice.near"), 0, "VoteApprove");
        if (n === 2) await s.dao.act(chain.sender("bob.near"), 0, "VoteApprove");
      },
    });
    await s.funder.fund(target);
    assert.deepEqual(s.calls.map((c) => c.method), ["storage_deposit", "ft_transfer"]);
    assert.deepEqual(s.calls[1]!.args, { receiver_id: "deposit-addr", amount: "1000000" });
    assert.match(s.chain.proposals[0]!.description, /agent-1/);
  });

  it("files and approves in one step with a one-vote threshold", async () => {
    const s = setup({ threshold: "1", oneClick: true });
    await s.funder.fund(target);
    assert.equal(s.calls.length, 2);
  });

  it("stops if the council rejects", async () => {
    const s = setup({
      onSleep: async (n, chain) => {
        if (n === 1) await s.dao.act(chain.sender("alice.near"), 0, "VoteReject"); // with two of two needed, one rejection ends it
      },
    });
    await assert.rejects(s.funder.fund(target), (e) => e instanceof AgentApiError && e.code === "funding_refused");
    assert.equal(s.calls.length, 0);
  });

  it("gives up when the deposit expires, and says so", async () => {
    const s = setup();
    await assert.rejects(s.funder.fund({ ...target, expiresAt: "2026-11-01T00:00:10Z" }), (e) => e instanceof AgentApiError && e.code === "funding_expired");
  });

  it("notices when the approved transfer then failed on the token", async () => {
    const s = setup({ threshold: "1", oneClick: true });
    s.chain.handlers.delete(`${USDC}.ft_transfer`); // the token refuses
    await assert.rejects(s.funder.fund(target), (e) => e instanceof AgentApiError && e.code === "funding_refused");
  });

  it("refuses what a plain transfer cannot do, before filing anything", async () => {
    const s = setup();
    await assert.rejects(s.funder.fund({ ...target, memo: "tag" }), (e) => e instanceof AgentApiError && e.code === "funding_memo_unsupported");
    await assert.rejects(s.funder.fund({ ...target, asset: "nep245:x:y" }), (e) => e instanceof AgentApiError && e.code === "funding_asset_unsupported");
    assert.equal(s.chain.proposals.length, 0);
  });

  it("names the proposal that sends NEAR to the owner account", () => {
    assert.deepEqual(nearTransferKind("owner", "10"), { Transfer: { token_id: "", receiver_id: "owner", amount: "10" } });
  });
});
