import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockCommandCenter } from "@/lib/command-center/mock";
import { AgentApiError, CommandCenterError } from "@/lib/errors";
import { exampleMandate, RISK, STABLE } from "@/lib/mandate/example";
import { openTrend, pending, run } from "@/lib/testing/drive";
import { pricePath } from "@/lib/testing/prices";

const quiet = { approvalThresholdUsd: "1000000", timelockMs: 3_000 };
const wants = [1, 1.5];

describe("the kill switch", () => {
  it("freezes every sleeve, revokes every grant, cancels everything waiting, and closes the queue", async () => {
    const w = await createMockCommandCenter();
    const small = await openTrend(w, "Small", "300"); // its buy goes straight to the veto window
    const large = await openTrend(w, "Large", "1000"); // its buy waits for the DAO
    await run(w, wants);
    assert.equal((await pending(w, "veto_window")).length, 1);
    assert.equal((await pending(w, "trade_request")).length, 1);

    const report = await w.cc.killSwitch("alice.near", "suspicious activity");
    assert.equal(report.frozen, 2);
    assert.equal(report.grantsRevoked, 2);
    assert.equal(report.cancelled, 1, "the queued swap");
    assert.ok(report.approvalsClosed >= 2);

    const snap = await w.cc.snapshot();
    assert.equal(snap.killed?.by, "alice.near");
    assert.equal(snap.killed?.reason, "suspicious activity");
    assert.deepEqual(snap.sleeves.map((s) => s.status), ["frozen", "frozen"]);
    assert.equal(snap.approvals.filter((a) => a.status === "pending").length, 0);
    assert.equal(w.api.operationsOf(small.agentId)[0]!.status, "CANCELLED");
    assert.equal(w.api.operationsOf(large.agentId).length, 0);
    // Nothing moved: every stake is still where it was.
    assert.equal(snap.sleeves.find((s) => s.id === small.id)!.balances[STABLE], "300000000");
  });

  it("acts at once, without a vote, even when the council votes on everything else", async () => {
    const w = await createMockCommandCenter({ autoApprove: false });
    // The sleeve needs votes to open; the kill switch does not.
    const proposal = await w.cc.openSleeve({ name: "A", stakeUsd: "500", strategy: { kind: "trend" }, riskAsset: RISK }, "alice.near");
    await w.cc.vote(proposal.id, "alice.near", "approve");
    await w.cc.vote(proposal.id, "bob.near", "approve");
    const before = (await w.governance.list()).length;
    const report = await w.cc.killSwitch("carol.near", "drill");
    assert.equal(report.frozen, 1);
    assert.equal((await w.governance.list()).length, before, "no proposal was needed");
  });

  it("stops the sleeves trading, whatever the market does", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    await w.cc.killSwitch("alice.near", "drill");
    const before = (await w.cc.snapshot()).sleeves[0]!.balances;
    await run(w, pricePath().slice(0, 20));
    const report = await w.cc.tick();
    assert.equal(report.skipped, "kill_switch");
    assert.deepEqual((await w.cc.snapshot()).sleeves[0]!.balances, before);
    assert.equal(w.api.operationsOf(s.agentId).length, 0);
  });

  it("is safe to press twice", async () => {
    const w = await createMockCommandCenter();
    await openTrend(w, "A", "300");
    await w.cc.killSwitch("alice.near", "first");
    const again = await w.cc.killSwitch("bob.near", "second");
    assert.equal(again.frozen, 0);
    assert.equal((await w.cc.snapshot()).killed?.reason, "first", "the first press is the one on record");
  });

  it("works with no sleeves at all", async () => {
    const w = await createMockCommandCenter();
    await w.cc.killSwitch("alice.near", "drill");
    assert.ok((await w.cc.snapshot()).killed);
    await w.cc.resume("alice.near");
    assert.equal((await w.cc.snapshot()).killed, null);
  });

  it("a frozen sleeve refuses everything, even to a brand-new grant", async () => {
    const w = await createMockCommandCenter();
    await openTrend(w, "A", "300");
    await w.cc.killSwitch("alice.near", "drill");
    const [report] = await w.cc.attackTest();
    assert.equal(report!.sleeveStatus, "frozen");
    assert.equal(report!.passed, true, JSON.stringify(report!.checks.filter((c) => !c.pass)));
    assert.deepEqual(
      report!.checks.map((c) => c.got),
      ["agent_grant_required", "agent_grant_required", "wallet_frozen", "wallet_frozen", "wallet_frozen"],
    );
  });
});

describe("lifting the kill switch", () => {
  it("is a vote, and brings sleeves back on new grants only", async () => {
    const w = await createMockCommandCenter();
    const s = await openTrend(w, "A", "300");
    await w.cc.killSwitch("alice.near", "drill");
    w.governance.setAutoApprove(false);

    const proposal = await w.cc.resume("alice.near");
    assert.equal(proposal.status, "pending");
    assert.ok((await w.cc.snapshot()).killed, "still stopped until the vote passes");
    await w.cc.vote(proposal.id, "alice.near", "approve");
    const done = await w.cc.vote(proposal.id, "bob.near", "approve");
    assert.equal(done.status, "executed");

    const snap = await w.cc.snapshot();
    assert.equal(snap.killed, null);
    assert.equal(snap.sleeves[0]!.status, "active");
    // The grant the sleeve had before the kill switch (the first one the mock issued) stays dead.
    await assert.rejects(w.api.forGrant("ngt_mock_1").getBalances(s.agentId), (e: unknown) => e instanceof AgentApiError && e.code === "agent_grant_required");
    w.governance.setAutoApprove(true);
    await run(w, wants);
    assert.ok(w.api.operationsOf(s.agentId).length > 0, "it trades again");
    const [report] = await w.cc.attackTest();
    assert.equal(report!.sleeveStatus, "active");
    assert.equal(report!.passed, true, JSON.stringify(report!.checks.filter((c) => !c.pass)));
  });

  it("cannot be asked for when it is not on", async () => {
    const w = await createMockCommandCenter();
    await assert.rejects(w.cc.resume("alice.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "not_killed");
  });

  it("waits out the API's policy-edit cooldown, then lifts by itself", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await openTrend(w, "A", "1000");
    // An ordinary policy edit, so the unfreeze that follows is throttled.
    await w.cc.setMandate(exampleMandate({ ...quiet, maxActionsPerHour: 30 }), "alice.near");
    await w.cc.killSwitch("alice.near", "drill"); // a pure freeze skips the cooldown
    await w.cc.resume("alice.near");

    let snap = await w.cc.snapshot();
    assert.equal(snap.sleeves[0]!.status, "frozen", "the unfreeze is throttled");
    assert.ok(snap.killed);
    assert.equal(snap.sleeves[0]!.resumeRequested, true);

    w.api.advance(600_001);
    await w.cc.tick();
    snap = await w.cc.snapshot();
    assert.equal(snap.sleeves[0]!.status, "active");
    assert.equal(snap.killed, null);
  });
});

describe("the attack test", () => {
  it("every probe is refused on a working sleeve, and it moves nothing", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    const [report] = await w.cc.attackTest();
    assert.equal(report!.passed, true, JSON.stringify(report!.checks.filter((c) => !c.pass)));
    const got = Object.fromEntries(report!.checks.map((c) => [c.id, c.got]));
    assert.equal(got["other-address"], "policy_destination_denied");
    assert.equal(got["other-chain"], "policy_destination_denied");
    assert.equal(got["memo"], "policy_destination_denied");
    assert.equal(got["other-asset"], "policy_asset_denied");
    assert.equal(got["over-cap"], "policy_limit_exceeded");
    assert.equal(got["swap-other-asset"], "policy_asset_denied");
    assert.equal(got["swap-over-cap"], "policy_limit_exceeded");
    assert.equal(got["revoked-grant"], "agent_grant_required");
    assert.equal(w.api.operationsOf(s.agentId).length, 0, "no probe created an operation");
    assert.equal((await w.cc.snapshot()).sleeves[0]!.equityUsd, "1000");
  });

  it("proves a replayed stake exit returns the original and sends nothing new", async () => {
    const w = await createMockCommandCenter({ mandate: { ...quiet, sealAfterBank: false } });
    const s = await openTrend(w);
    await run(w, pricePath().slice(0, 30));
    const withdrawalsBefore = w.api.operationsOf(s.agentId).filter((o) => !o.swap).length;
    const [report] = await w.cc.attackTest();
    assert.equal(report!.checks.find((c) => c.id === "replay")?.got, "replay");
    assert.equal(w.api.operationsOf(s.agentId).filter((o) => !o.swap).length, withdrawalsBefore);
    assert.equal(report!.passed, true, JSON.stringify(report!.checks.filter((c) => !c.pass)));
  });

  it("can test one sleeve or all, and records the result in the audit trail", async () => {
    const w = await createMockCommandCenter();
    await openTrend(w, "A", "300");
    await openTrend(w, "B", "300");
    assert.equal((await w.cc.attackTest()).length, 2);
    assert.equal((await w.cc.attackTest("s1")).length, 1);
    await assert.rejects(w.cc.attackTest("nope"), (e: unknown) => e instanceof CommandCenterError && e.code === "unknown_sleeve");
    assert.equal(w.cc.audit.ofKind("attack_test").length, 3);
  });
});
