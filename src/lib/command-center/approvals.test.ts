import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockCommandCenter } from "@/lib/command-center/mock";
import { CommandCenterError, GovernanceError } from "@/lib/errors";
import { RISK } from "@/lib/mandate/example";
import { openTrend, pending, run, vote } from "@/lib/testing/drive";

/** A world where trades above $400 wait for the DAO, and the council needs two of three votes. */
async function world(over: Parameters<typeof createMockCommandCenter>[0] = {}) {
  const w = await createMockCommandCenter(over);
  return w;
}
const ops = (w: Awaited<ReturnType<typeof world>>, agentId: string) => w.api.operationsOf(agentId).filter((o) => o.swap);

/** The sleeve wants to buy: one flat price to start the average, then a jump. */
const wantsToBuy = [1, 1.5];

describe("a large trade waits for the DAO", () => {
  it("is held back, listed in the queue, and nothing is sent", async () => {
    const w = await world();
    const s = await openTrend(w, "Trend", "1000");
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    assert.ok(item, "the buy shows up as a request");
    assert.equal(item.valueUsd, "1000");
    assert.equal(item.sleeveName, "Trend");
    assert.match(item.summary, /swap 1,000\.00 USDC to wNEAR/);
    assert.equal(ops(w, s.agentId).length, 0, "nothing reached the API");
    assert.equal(w.cc.audit.ofKind("swap_held").length, 1);
    // And it keeps waiting: further ticks do not stack up requests.
    await run(w, [1.6, 1.7]);
    assert.equal((await pending(w, "trade_request")).length, 1);
  });

  it("is sent only when enough members approve, and then tracked to its fill", async () => {
    const w = await world();
    const s = await openTrend(w);
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    w.governance.setAutoApprove(false);

    const first = await w.cc.decide(item!.id, "approve", "alice.near");
    assert.equal(first.proposal.status, "pending");
    assert.equal(first.item.status, "pending");
    assert.equal(ops(w, s.agentId).length, 0, "one vote of two is not enough");

    const second = await w.cc.decide(item!.id, "approve", "bob.near");
    assert.equal(second.proposal.status, "executed");
    assert.equal(second.item.status, "executed");
    assert.equal(ops(w, s.agentId).length, 1, "now it is sent, under the key the trader chose");

    w.api.advance(10_000);
    await w.cc.tick();
    assert.equal(w.cc.audit.ofKind("swap_settled").length, 1);
    const sleeve = (await w.cc.snapshot()).sleeves[0]!;
    assert.ok(BigInt(sleeve.balances[RISK] ?? "0") > 0n);
  });

  it("is discarded when the DAO vetoes it, and the sleeve decides afresh", async () => {
    const w = await world();
    const s = await openTrend(w);
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    w.governance.setAutoApprove(false);
    await vote(w, item!.id, "veto", "alice.near", "bob.near");

    assert.equal((await w.cc.snapshot()).approvals.find((a) => a.id === item!.id)!.status, "vetoed");
    assert.equal(ops(w, s.agentId).length, 0);
    w.governance.setAutoApprove(true);
    await run(w, [1.7]);
    const again = await pending(w, "trade_request");
    assert.equal(again.length, 1, "the trend is still up, so it asks again");
    assert.notEqual(again[0]!.id, item!.id, "as a new request");
  });

  it("needs a council member to decide, and a decided item cannot be decided again", async () => {
    const w = await world();
    await openTrend(w);
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    w.governance.setAutoApprove(false);
    await assert.rejects(w.cc.decide(item!.id, "approve", "mallory.near"), (e: unknown) => e instanceof GovernanceError && e.code === "not_a_member");
    await assert.rejects(w.cc.decide("nope", "approve", "alice.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "unknown_approval");
    await vote(w, item!.id, "approve", "alice.near", "bob.near");
    await assert.rejects(w.cc.decide(item!.id, "approve", "carol.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "not_pending");
  });

  it("lapses if the DAO never decides, and the sleeve may ask again", async () => {
    const w = await world({ approvalTtlMs: 60_000 });
    await openTrend(w);
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    w.api.advance(61_000);
    await w.cc.tick();
    assert.equal((await w.cc.snapshot()).approvals.find((a) => a.id === item!.id)!.status, "expired");
    await run(w, [1.7]);
    assert.equal((await pending(w, "trade_request")).length, 1, "a fresh request replaces the lapsed one");
  });

  it("when two opposite decisions are filed, the first to pass wins and the other fails", async () => {
    const w = await world();
    const s = await openTrend(w);
    await run(w, wantsToBuy);
    const [item] = await pending(w, "trade_request");
    w.governance.setAutoApprove(false);
    await w.cc.decide(item!.id, "approve", "alice.near"); // 1 of 2 for approve
    await w.cc.decide(item!.id, "veto", "bob.near"); // 1 of 2 for veto
    const winner = await w.cc.decide(item!.id, "veto", "carol.near"); // veto reaches 2
    assert.equal(winner.item.status, "vetoed");

    const approve = (await w.governance.list()).find((p) => p.action.type === "decide_item" && p.action.decision === "approve")!;
    const late = await w.cc.vote(approve.id, "bob.near", "approve"); // approve reaches 2, too late
    assert.equal(late.status, "failed");
    assert.match(late.error ?? "", /already vetoed/);
    assert.equal(ops(w, s.agentId).length, 0, "the veto stood");
  });
});

describe("risk-reducing trades never wait", () => {
  it("a large sale back into the stable asset goes straight out, with no vote", async () => {
    const w = await world({ mandate: { approvalThresholdUsd: "400", timelockMs: 3_000 } });
    const s = await openTrend(w);
    await run(w, wantsToBuy);
    const [buy] = await pending(w, "trade_request");
    await w.cc.decide(buy!.id, "approve", "alice.near"); // auto-approve council
    w.api.advance(10_000);
    await w.cc.tick();
    assert.equal(w.cc.audit.ofKind("swap_settled").length, 1);

    await run(w, [1.5, 1.0]); // the trend turns down: the sleeve wants out, a $1,400 sale
    assert.equal((await pending(w, "trade_request")).length, 0, "the sale was not held for the DAO");
    const sells = ops(w, s.agentId).filter((o) => o.swap!.request.origin_asset === RISK);
    assert.equal(sells.length, 1, "it was sent");
  });
});

describe("the veto window", () => {
  it("lists every queued request so the DAO can veto it before it releases", async () => {
    const w = await world();
    const s = await openTrend(w, "Small", "300"); // under the $400 threshold: sent straight away
    await run(w, wantsToBuy);
    assert.equal(ops(w, s.agentId).length, 1);
    const [item] = await pending(w, "veto_window");
    assert.ok(item);
    assert.ok(item.expiresAt, "it shows when the request releases");
    assert.match(item.summary, /swap 300\.00 USDC to wNEAR/);
  });

  it("a veto cancels the request, which never runs", async () => {
    const w = await world();
    const s = await openTrend(w, "Small", "300");
    await run(w, wantsToBuy);
    const [item] = await pending(w, "veto_window");
    w.governance.setAutoApprove(false);
    await vote(w, item!.id, "veto", "alice.near", "bob.near");
    const [op] = ops(w, s.agentId);
    assert.equal(op!.status, "CANCELLED");
    w.api.advance(60_000);
    const sleeve = (await w.cc.snapshot()).sleeves[0]!;
    assert.equal(sleeve.balances[RISK] ?? "0", "0", "nothing was bought");
  });

  it("choosing not to veto lets the request run, and the item clears", async () => {
    const w = await world();
    await openTrend(w, "Small", "300");
    await run(w, wantsToBuy);
    const [item] = await pending(w, "veto_window");
    await w.cc.decide(item!.id, "approve", "alice.near"); // auto-approve council: passes at once
    assert.equal((await w.cc.snapshot()).approvals.find((a) => a.id === item!.id)!.status, "dismissed");
    w.api.advance(10_000);
    await w.cc.tick();
    assert.equal(w.cc.audit.ofKind("swap_settled").length, 1);
  });

  it("an item whose request already ran is marked executed, not left waiting", async () => {
    const w = await world();
    await openTrend(w, "Small", "300");
    await run(w, wantsToBuy);
    const [item] = await pending(w, "veto_window");
    w.api.advance(10_000);
    await w.cc.tick();
    assert.equal((await w.cc.snapshot()).approvals.find((a) => a.id === item!.id)!.status, "executed");
  });
});

describe("a sleeve on owner approval", () => {
  it("holds every money action for the DAO, until released", async () => {
    const w = await world();
    const s = await openTrend(w, "Held", "300", { hold: true });
    await run(w, wantsToBuy);
    const [item] = await pending(w, "policy_hold");
    assert.ok(item);
    assert.equal(ops(w, s.agentId)[0]!.status, "HELD");
    w.api.advance(120_000);
    await w.cc.tick();
    assert.equal(ops(w, s.agentId)[0]!.status, "HELD", "time never releases a hold");

    await w.cc.decide(item!.id, "approve", "alice.near");
    assert.equal(ops(w, s.agentId)[0]!.status, "QUEUED", "released into the veto window");
    w.api.advance(10_000);
    await w.cc.tick();
    assert.equal(ops(w, s.agentId)[0]!.status, "SUCCESS");
  });

  it("rejecting a hold cancels it", async () => {
    const w = await world();
    const s = await openTrend(w, "Held", "300", { hold: true });
    await run(w, wantsToBuy);
    const [item] = await pending(w, "policy_hold");
    await w.cc.decide(item!.id, "veto", "alice.near");
    assert.equal(ops(w, s.agentId)[0]!.status, "CANCELLED");
    assert.equal(ops(w, s.agentId)[0]!.failure_code, "rejected_by_owner");
  });
});
