import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockCommandCenter } from "@/lib/command-center/mock";
import { exampleMandate, RISK, SAFE, STABLE } from "@/lib/mandate/example";
import { openTrend, pending, run } from "@/lib/testing/drive";
import { pricePath } from "@/lib/testing/prices";

const quiet = { approvalThresholdUsd: "1000000", timelockMs: 3_000 };

describe("books", () => {
  it("close after a full run: what the API reports is what the operations imply", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await openTrend(w);
    await run(w, pricePath().slice(0, 30));
    const books = await w.cc.books();
    assert.equal(books.reconciled, true, JSON.stringify(books.sleeves[0]));
    const [s] = books.sleeves;
    assert.equal(s!.fundedUsd, "1000");
    assert.equal(s!.withdrawnToSafeUsd, "1000", "the banked stake");
    assert.deepEqual(s!.unexplained, {});
    assert.deepEqual(s!.unrecordedOperations, []);
    assert.ok(Number(s!.pnlUsd) > 0, "it made money on the rally");
    assert.equal(books.treasuryStableUsd, "20000");
  });

  it("still close after the kill switch has revoked every grant", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await openTrend(w);
    await run(w, pricePath().slice(0, 12));
    await w.cc.killSwitch("alice.near", "drill");
    assert.equal((await w.cc.books()).reconciled, true);
  });

  it("flag a balance nobody can explain", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    w.api.setBalance(s.agentId, STABLE, 1_000_000_005n); // 5 atoms nobody sent
    const books = await w.cc.books();
    assert.equal(books.reconciled, false);
    assert.deepEqual(books.sleeves[0]!.unexplained, { [STABLE]: "5" });
  });

  it("flag an operation the audit trail never recorded", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    // Someone uses the sleeve's grant directly, outside the runner.
    const sleeveGrant = w.api.forGrant("ngt_mock_1");
    const op = await sleeveGrant.swap(s.agentId, { origin_asset: STABLE, destination_asset: RISK, amount: "1000000" }, { idempotencyKey: "rogue" });
    const books = await w.cc.books();
    assert.equal(books.reconciled, false);
    assert.deepEqual(books.sleeves[0]!.unrecordedOperations, [op.correlation_id]);
  });
});

describe("changing the mandate", () => {
  it("shows what would change before the vote, then updates every sleeve's policy", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    const next = exampleMandate({ ...quiet, timelockMs: 99_000, budgets: { dailyUsd: "500", weeklyUsd: null, monthlyUsd: null } });

    const preview = await w.cc.previewMandate(next);
    assert.deepEqual(preview[0]!.changes.map((c) => c.path), ["budget.daily_usd", "timelock_ms"]);

    await w.cc.setMandate(next, "alice.near");
    const { policy } = await w.api.getPolicy(s.agentId);
    assert.equal(policy!.timelock_ms, 99_000);
    assert.equal(policy!.budget.daily_usd, "500");
    const sleeve = (await w.cc.snapshot()).sleeves[0]!;
    assert.equal(sleeve.policyStale, false);
    assert.equal(sleeve.policyMandateDigest, (await w.cc.snapshot()).mandateDigest);
  });

  it("when the API throttles a second quick edit, the sleeve stays stale and catches up later", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    await w.cc.setMandate(exampleMandate({ ...quiet, timelockMs: 5_000 }), "alice.near");
    await w.cc.setMandate(exampleMandate({ ...quiet, timelockMs: 7_000 }), "alice.near");
    assert.equal((await w.cc.snapshot()).sleeves[0]!.policyStale, true);
    assert.equal((await w.api.getPolicy(s.agentId)).policy!.timelock_ms, 5_000);

    w.api.advance(600_001);
    await w.cc.tick();
    assert.equal((await w.cc.snapshot()).sleeves[0]!.policyStale, false);
    assert.equal((await w.api.getPolicy(s.agentId)).policy!.timelock_ms, 7_000);
  });

  it("a new safe takes over the next exit, in both the policy and the banker", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const s = await openTrend(w);
    await run(w, pricePath().slice(0, 3)); // the engine is running
    const safe = { chain: "base", address: "0xNEWSAFE00000000000000000000000000000002" };
    await w.cc.setMandate(exampleMandate({ ...quiet, safe }), "alice.near");
    await run(w, pricePath().slice(3, 32));
    const [exit] = w.api.settled.filter((o) => o.agentId === s.agentId);
    assert.equal(exit!.request.recipient, safe.address);
    assert.notEqual(exit!.request.recipient, SAFE.address);
  });

  it("a lower trigger applies to sleeves already running", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await openTrend(w);
    await run(w, pricePath().slice(0, 8)); // a running engine, well short of 2x
    assert.equal(w.cc.audit.ofKind("trigger").length, 0);
    await w.cc.setMandate(exampleMandate({ ...quiet, bankMultipleBps: 10_500 }), "alice.near");
    await run(w, pricePath().slice(8, 14));
    assert.equal(w.cc.audit.ofKind("trigger").length, 1);
  });

  it("tags later entries with the new digest and earlier ones with the old", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await openTrend(w);
    const before = (await w.cc.snapshot()).mandateDigest;
    await w.cc.setMandate(exampleMandate({ ...quiet, maxActionsPerHour: 20 }), "alice.near");
    const after = (await w.cc.snapshot()).mandateDigest;
    assert.notEqual(before, after);
    assert.equal(w.cc.audit.ofKind("sleeve_opened")[0]!.mandateDigest, before);
    assert.equal(w.cc.audit.ofKind("mandate_set").at(-1)!.mandateDigest, after);
  });
});

describe("a vetoed stake exit", () => {
  it("pauses the sleeve until the DAO retries, then banks exactly once", async () => {
    const w = await createMockCommandCenter({ mandate: { ...quiet, sealAfterBank: false } });
    const s = await openTrend(w);
    // Run until the stake's exit is queued.
    const path = pricePath();
    let i = 0;
    while (i < path.length && (await w.cc.snapshot()).sleeves[0]!.exit !== "queued") await run(w, [path[i++]!]);
    assert.equal((await w.cc.snapshot()).sleeves[0]!.exit, "queued");

    // The DAO vetoes the exit while it waits out its delay.
    const exit = w.api.operationsOf(s.agentId).find((o) => !o.swap)!;
    const item = (await pending(w, "veto_window")).find((a) => a.summary.includes("withdraw"))!;
    assert.ok(item, "the exit is in the veto window like any other request");
    await w.cc.decide(item.id, "veto", "alice.near");
    assert.equal((await w.api.getStatus(exit.correlation_id)).status, "CANCELLED");

    await w.cc.tick();
    let sleeve = (await w.cc.snapshot()).sleeves[0]!;
    assert.equal(sleeve.status, "bank_failed");
    assert.equal(sleeve.exit, "failed");
    assert.equal((await w.cc.snapshot()).treasury.stableUsd, "19000", "the stake did not come back");

    // A sleeve awaiting the DAO's call does not trade.
    const opsBefore = w.api.operationsOf(s.agentId).length;
    await run(w, [3.9, 4, 3.8]);
    assert.equal(w.api.operationsOf(s.agentId).length, opsBefore);

    await w.cc.retryBank(s.id, "alice.near");
    await run(w, Array.from({ length: 8 }, () => 4));
    sleeve = (await w.cc.snapshot()).sleeves[0]!;
    assert.equal(sleeve.exit, "settled");
    assert.equal(sleeve.status, "banked");
    assert.equal((await w.cc.snapshot()).treasury.stableUsd, "20000", "credited once");
    assert.equal(w.api.settled.filter((o) => o.agentId === s.agentId).length, 1);
    assert.equal(w.api.operationsOf(s.agentId).filter((o) => !o.swap).length, 2, "the vetoed attempt and the retry");
  });

  it("offers no retry for a sleeve whose exit did not fail", async () => {
    const w = await createMockCommandCenter();
    const s = await openTrend(w, "A", "300");
    await assert.rejects(w.cc.retryBank(s.id, "alice.near"), /no failed exit/);
  });
});
