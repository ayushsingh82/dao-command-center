import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USDC, createMockCommandCenter, type MockCommandCenter } from "@/lib/command-center/mock";
import { RISK, RISK_B, SAFE, STABLE } from "@/lib/mandate/example";
import { pricePath } from "@/lib/testing/prices";

const trend = { kind: "trend" } as const;
// No trade is large enough to need the DAO here; approvals have their own tests.
const quiet = { approvalThresholdUsd: "1000000", timelockMs: 3_000 };

/** Move the market one price at a time, let a second pass, and run a tick. */
async function run(w: MockCommandCenter, prices: number[], asset = RISK) {
  for (const p of prices) {
    w.market.setPrice(asset, p);
    w.api.advance(1_000);
    await w.cc.tick();
  }
}

const treasuryUsd = async (w: MockCommandCenter) => Number((await w.cc.snapshot()).treasury.stableUsd);

describe("a sleeve's life", () => {
  it("trades a rally, banks its stake once, seals its policy, and the drawdown cannot touch the stake", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    assert.equal(await treasuryUsd(w), 19_000);

    const path = pricePath();
    const rally = path.slice(0, 24);
    await run(w, rally);
    // Give the exit and the seal time to finish.
    await run(w, path.slice(24, 30));

    let snap = await w.cc.snapshot();
    let sleeve = snap.sleeves[0]!;
    assert.equal(sleeve.exit, "settled");
    assert.equal(sleeve.status, "banked");
    assert.equal(sleeve.sealed, true, "banking triggered a proposal to seal the policy, which passed");
    assert.equal(await treasuryUsd(w), 20_000, "the full stake is back in the treasury");

    // Exactly one withdrawal, of exactly the stake, to the DAO's safe.
    const exits = w.api.settled.filter((o) => o.agentId === sleeve.agentId);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]!.request.amount, (1000n * USDC).toString());
    assert.equal(exits[0]!.request.recipient, SAFE.address);

    const banked = w.cc.audit.ofKind("stake_banked");
    assert.equal(banked.length, 1);
    assert.equal(w.cc.audit.ofKind("trigger").length, 1);

    // The rest of the path: a 40% drawdown and a flat tail. Only gains can be lost.
    await run(w, path.slice(30));
    snap = await w.cc.snapshot();
    sleeve = snap.sleeves[0]!;
    assert.equal(await treasuryUsd(w), 20_000, "the treasury did not lose a cent to the drawdown");
    assert.equal(w.api.settled.filter((o) => o.agentId === sleeve.agentId).length, 1, "and the stake never left twice");
    assert.ok(Number(sleeve.equityUsd) >= 0);
  });

  it("the sealed policy makes a second exit impossible, not just unlikely", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    await run(w, pricePath().slice(0, 30));
    const [report] = await w.cc.attackTest();
    assert.equal(report!.passed, true, JSON.stringify(report!.checks.filter((c) => !c.pass)));
    const sealedChecks = report!.checks.filter((c) => c.expected === "policy_action_denied");
    assert.ok(sealedChecks.length >= 5, "every withdrawal probe is refused as an action once sealed");
  });

  it("banks at the mandate's multiple, not before", async () => {
    const w = await createMockCommandCenter({ mandate: { ...quiet, bankMultipleBps: 22_000 } }); // 2.2x
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    await run(w, pricePath().slice(0, 14)); // the trend strategy enters late, so equity is still well under 2.2x
    assert.equal(w.cc.audit.ofKind("trigger").length, 0);
    await run(w, pricePath().slice(14, 24));
    assert.equal(w.cc.audit.ofKind("trigger").length, 1);
  });

  it("a sleeve that never rallies never banks, and keeps its stake at risk against the bucket", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await w.cc.openSleeve({ name: "Flat", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    await run(w, Array.from({ length: 20 }, () => 1));
    const snap = await w.cc.snapshot();
    assert.equal(snap.sleeves[0]!.exit, "none");
    assert.equal(snap.treasury.riskBucket.atRiskUsd, "1000");
  });

  it("banking frees room in the risk bucket for a new sleeve", async () => {
    const w = await createMockCommandCenter({ mandate: { ...quiet, maxRiskBucketUsd: "1500" } });
    await w.cc.openSleeve({ name: "A", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    await assert.rejects(w.cc.openSleeve({ name: "B", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near"));
    await run(w, pricePath().slice(0, 30));
    assert.equal((await w.cc.snapshot()).sleeves[0]!.status, "banked");
    await w.cc.openSleeve({ name: "B", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    assert.equal((await w.cc.snapshot()).sleeves.length, 2);
  });

  it("runs two sleeves side by side without one touching the other", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    await w.cc.openSleeve({ name: "Hold ETH", stakeUsd: "500", strategy: { kind: "hold" }, riskAsset: RISK_B }, "alice.near");
    w.market.setPrice(RISK_B, 2_000);
    await run(w, pricePath().slice(0, 30));
    const snap = await w.cc.snapshot();
    const [a, b] = snap.sleeves;
    assert.equal(a!.exit, "settled");
    assert.equal(b!.exit, "none", "the hold sleeve never reached its trigger");
    assert.notEqual(a!.agentId, b!.agentId);
    // The hold sleeve's balance is only its own: all in ETH, nothing of the trend sleeve's.
    assert.equal(b!.balances[STABLE] ?? "0", "0");
    assert.ok(BigInt(b!.balances[RISK_B] ?? "0") > 0n);
  });

  it("does nothing on a stale price, and carries on when the price returns", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    w.market.setStale(RISK, true);
    await run(w, [1.5, 1.6, 1.7]);
    assert.equal(w.api.operationsOf("sleeve-s1").length, 0);
    assert.ok(w.cc.audit.ofKind("price_unavailable").length > 0);
    assert.equal((await w.cc.snapshot()).sleeves[0]!.equityUsd, "1000", "its stable balance is still priced");
    w.market.setStale(RISK, false);
    await run(w, [1.6, 1.8, 2.0]);
    assert.ok(w.api.operationsOf("sleeve-s1").length > 0);
  });
});
