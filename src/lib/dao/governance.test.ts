import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consentDescription, parseConsent } from "@/lib/dao/consent";
import { SputnikGovernance } from "@/lib/dao/governance";
import { MemoryLedger } from "@/lib/dao/ledger";
import { SputnikDao } from "@/lib/dao/sputnik";
import { GovernanceError } from "@/lib/errors";
import { exampleMandate } from "@/lib/mandate/example";
import type { OwnerAction } from "@/lib/governance/types";
import { FakeDao } from "@/lib/testing/fake-dao";

const DAO = "dao.near";
const MEMBERS = ["alice.near", "bob.near", "carol.near"];
const resume: OwnerAction = { type: "resume" };
const mandateAction: OwnerAction = { type: "set_mandate", mandate: exampleMandate() };

async function make(opts: { threshold?: [number, number] | string; voters?: boolean; approveOnFiling?: boolean; now?: () => Date; scope?: string; maxAgeMs?: number; filer?: string } = {}) {
  const chain = new FakeDao(DAO, MEMBERS, { threshold: opts.threshold, now: opts.now });
  const ledger = new MemoryLedger();
  const dao = new SputnikDao(DAO, chain);
  const governance = await SputnikGovernance.connect({
    dao, ledger, proposer: chain.sender(opts.filer ?? "alice.near"), now: opts.now, scope: opts.scope, maxAgeMs: opts.maxAgeMs,
    approveOnFiling: opts.approveOnFiling,
    voters: opts.voters ? Object.fromEntries(MEMBERS.map((m) => [m, chain.sender(m)])) : undefined,
  });
  return { chain, ledger, dao, governance };
}

describe("consent descriptions", () => {
  it("round-trips an action through a description, one line of summary and one of JSON", () => {
    const d = consentDescription({ dao: DAO, by: "alice.near", action: mandateAction, summary: "Set\nthe mandate" });
    assert.equal(d.split("\n").length, 3);
    assert.equal(d.split("\n")[0], "Set the mandate");
    const c = parseConsent(d, { dao: DAO })!;
    assert.deepEqual([c.action, c.by, c.summary], [mandateAction, "alice.near", "Set the mandate"]);
  });

  it("refuses a description for another DAO, another scope, a different digest, or that is not ours", () => {
    const d = consentDescription({ dao: DAO, scope: "a", by: "x", action: resume, summary: "s" });
    assert.ok(parseConsent(d, { dao: DAO, scope: "a" }));
    assert.equal(parseConsent(d, { dao: "other.near", scope: "a" }), null);
    assert.equal(parseConsent(d, { dao: DAO, scope: "b" }), null);
    assert.equal(parseConsent(d, { dao: DAO }), null);
    assert.equal(parseConsent(d.replace('"resume"', '"seal_sleeve"'), { dao: DAO, scope: "a" }), null, "the digest no longer matches");
    assert.equal(parseConsent("just a normal proposal", { dao: DAO }), null);
    assert.equal(parseConsent(`s\ndao-command-center/v1\n{not json`, { dao: DAO }), null);
    assert.equal(parseConsent(d.replace('"resume"', '"explode"'), { dao: DAO, scope: "a" }), null, "an unknown action is not accepted");
  });
});

describe("SputnikGovernance", () => {
  it("files a Vote proposal on the DAO and shows it pending, with the council from the DAO's policy", async () => {
    const { governance, chain } = await make();
    const p = await governance.propose(mandateAction, "alice.near", "Set the mandate");
    assert.deepEqual([p.id, p.status, p.threshold, p.proposer, p.summary], ["0", "pending", 2, "alice.near", "Set the mandate"]);
    assert.deepEqual(p.members, MEMBERS);
    assert.deepEqual(p.action, mandateAction);
    assert.equal(chain.proposals[0]!.kind, "Vote", "it executes nothing on chain");
    assert.deepEqual(governance.council(), { members: MEMBERS, threshold: 2, autoApprove: false });
  });

  it("will not vote for a member whose key it does not hold", async () => {
    const { governance } = await make();
    const p = await governance.propose(resume, "alice.near", "Resume");
    await assert.rejects(governance.vote(p.id, "bob.near", "approve"), (e) => e instanceof GovernanceError && e.code === "external_vote" && /own wallet/.test(e.message));
  });

  it("passes when enough members vote, from their own side, and reads it back", async () => {
    const { governance, dao, chain } = await make();
    const p = await governance.propose(resume, "alice.near", "Resume");
    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    assert.equal((await governance.get(p.id))!.status, "pending");
    await dao.act(chain.sender("bob.near"), 0, "VoteApprove");
    const after = (await governance.get(p.id))!;
    assert.deepEqual([after.status, after.votes], ["approved", { "alice.near": "approve", "bob.near": "approve" }]);
  });

  it("votes for members it holds keys for, and checks the usual rules first", async () => {
    const { governance } = await make({ voters: true });
    const p = await governance.propose(resume, "alice.near", "Resume");
    assert.equal((await governance.vote(p.id, "alice.near", "approve")).status, "pending");
    await assert.rejects(governance.vote(p.id, "alice.near", "approve"), (e) => e instanceof GovernanceError && e.code === "already_voted");
    await assert.rejects(governance.vote(p.id, "mallory.near", "approve"), (e) => e instanceof GovernanceError && e.code === "not_a_member");
    await assert.rejects(governance.vote("77", "bob.near", "approve"), (e) => e instanceof GovernanceError && e.code === "unknown_proposal");
    assert.equal((await governance.vote(p.id, "bob.near", "approve")).status, "approved");
    await assert.rejects(governance.vote(p.id, "carol.near", "approve"), (e) => e instanceof GovernanceError && e.code === "not_pending");
  });

  it("rejects when enough members reject", async () => {
    const { governance } = await make({ voters: true });
    const p = await governance.propose(resume, "alice.near", "Resume");
    await governance.vote(p.id, "alice.near", "reject");
    assert.equal((await governance.vote(p.id, "bob.near", "reject")).status, "rejected");
  });

  it("files and approves in one step when the proposer may vote and the threshold is one", async () => {
    const { governance } = await make({ threshold: "1", approveOnFiling: true });
    assert.equal((await governance.propose(resume, "alice.near", "Resume")).status, "approved");
  });

  it("refuses a proposer the DAO does not let file", async () => {
    const { governance, chain } = await make({ filer: "mallory.near" });
    await assert.rejects(governance.propose(resume, "mallory.near", "x"), (e) => e instanceof GovernanceError && e.code === "not_allowed");
    assert.equal(chain.proposals.length, 0);
  });

  it("refuses to file something that is not an owner action", async () => {
    const { governance } = await make();
    await assert.rejects(governance.propose({ type: "explode" } as never, "alice.near", "x"), (e) => e instanceof GovernanceError && e.code === "not_allowed");
  });

  it("records that an approved proposal was run, so it is not run again, and keeps that across a new instance", async () => {
    const { governance, ledger, dao, chain } = await make({ threshold: "1" });
    const p = await governance.propose(resume, "alice.near", "Resume");
    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    assert.deepEqual((await governance.list()).map((x) => x.status), ["approved"]);
    const done = await governance.markExecuted(p.id, "2026-11-02T00:00:00Z");
    assert.deepEqual([done.status, done.executedAt], ["executed", "2026-11-02T00:00:00Z"]);
    assert.deepEqual((await governance.list()).filter((x) => x.status === "approved"), []);

    const restarted = await SputnikGovernance.connect({ dao, ledger, proposer: chain.sender("alice.near") });
    assert.equal((await restarted.get(p.id))!.status, "executed");
    await assert.rejects(restarted.markExecuted(p.id, "later"), (e) => e instanceof GovernanceError && e.code === "not_pending");
  });

  it("records a failure with its reason", async () => {
    const { governance, dao, chain } = await make({ threshold: "1" });
    const p = await governance.propose(resume, "alice.near", "Resume");
    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    const failed = await governance.markFailed(p.id, "the API said no", "t");
    assert.deepEqual([failed.status, failed.error], ["failed", "the API said no"]);
  });

  it("cannot mark a proposal that is not approved", async () => {
    const { governance } = await make();
    const p = await governance.propose(resume, "alice.near", "Resume");
    await assert.rejects(governance.markExecuted(p.id, "t"), (e) => e instanceof GovernanceError && e.code === "not_pending");
  });

  it("ignores every proposal on the DAO that is not its own consent", async () => {
    const { governance, chain, dao } = await make({ scope: "main", threshold: "1" });
    const sender = chain.sender("alice.near");
    await dao.file(sender, "a normal proposal", "Vote");
    await dao.file(sender, consentDescription({ dao: DAO, scope: "other", by: "x", action: resume, summary: "other scope" }), "Vote");
    await dao.file(sender, consentDescription({ dao: "other.near", scope: "main", by: "x", action: resume, summary: "other dao" }), "Vote");
    // The right description on a proposal that would also do something: not a consent.
    await dao.file(sender, consentDescription({ dao: DAO, scope: "main", by: "x", action: resume, summary: "wrong kind" }), {
      Transfer: { token_id: "", receiver_id: "mallory.near", amount: "1000" },
    });
    assert.deepEqual(await governance.list(), []);
    assert.equal(await governance.get("0"), undefined);
    assert.equal(await governance.get("3"), undefined);
    assert.equal(await governance.get("nope"), undefined);
    const mine = await governance.propose(resume, "alice.near", "mine");
    assert.deepEqual((await governance.list()).map((p) => p.id), [mine.id]);
  });

  it("does not act on an approval that is too old, or a vote that ran out of time", async () => {
    let now = new Date("2026-11-01T00:00:00Z");
    const { governance, dao, chain } = await make({ threshold: "1", now: () => now, maxAgeMs: 10 * 86_400_000 });
    const a = await governance.propose(resume, "alice.near", "approved long ago");
    await dao.act(chain.sender("alice.near"), 0, "VoteApprove");
    const b = await governance.propose({ type: "retry_bank", sleeveId: "s1" }, "alice.near", "never decided");
    now = new Date("2026-11-12T00:00:00Z");
    const stale = (await governance.get(a.id))!;
    assert.deepEqual([stale.status, /too old/.test(stale.error ?? "")], ["rejected", true]);
    const expired = (await governance.get(b.id))!;
    assert.deepEqual([expired.status, /voting period/.test(expired.error ?? "")], ["rejected", true]);
  });

  it("calls a chain it cannot read what it is, never an empty answer", async () => {
    const { governance, chain } = await make();
    chain.unreachable = true;
    await assert.rejects(governance.list(), (e) => e instanceof GovernanceError && e.code === "chain_unavailable");
    await assert.rejects(governance.propose(resume, "alice.near", "x"), (e) => e instanceof GovernanceError && e.code === "chain_unavailable");
  });

  it("picks up a changed council when told to refresh", async () => {
    const { governance, chain } = await make();
    chain.policyValue.roles[0]!.kind = { Group: [...MEMBERS, "dave.near"] };
    assert.equal(governance.council().members.length, 3);
    await governance.refresh();
    assert.equal(governance.council().members.length, 4);
  });
});
