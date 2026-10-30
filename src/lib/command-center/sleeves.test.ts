import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USDC, createMockCommandCenter } from "@/lib/command-center/mock";
import { CommandCenterError, MandateError, MandateViolationError } from "@/lib/errors";
import { exampleMandate, RISK, RISK_B, SAFE, STABLE } from "@/lib/mandate/example";
import { mandateDigest } from "@/lib/mandate/mandate";

const trend = { kind: "trend" } as const;
const open = (name = "Alpha", stakeUsd = "1000", over: Record<string, unknown> = {}) => ({ name, stakeUsd, strategy: trend, riskAsset: RISK, ...over });
const violation = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof MandateViolationError && e.code === code, `expected ${code}`);

describe("the mandate", () => {
  it("starts empty, and nothing runs until the DAO sets one", async () => {
    const { cc } = await createMockCommandCenter({ mandate: null });
    const snap = await cc.snapshot();
    assert.equal(snap.mandate, null);
    assert.equal(snap.mandateDigest, "none");
    await violation(cc.openSleeve(open(), "alice.near"), "mandate_not_set");
    assert.equal((await cc.tick()).skipped, "no_mandate");
  });

  it("takes effect only when the DAO's vote passes, and records the digest it ran under", async () => {
    const { cc, governance } = await createMockCommandCenter({ mandate: null, autoApprove: false });
    const mandate = exampleMandate();
    const proposal = await cc.setMandate(mandate, "alice.near");
    assert.equal(proposal.status, "pending");
    assert.equal((await cc.snapshot()).mandate, null, "a pending proposal changes nothing");

    await cc.vote(proposal.id, "alice.near", "approve");
    assert.equal((await cc.snapshot()).mandate, null, "one of two votes is not enough");
    const passed = await cc.vote(proposal.id, "bob.near", "approve");
    assert.equal(passed.status, "executed");

    const snap = await cc.snapshot();
    assert.deepEqual(snap.mandate, mandate);
    assert.equal(snap.mandateDigest, mandateDigest(mandate));
    assert.equal(cc.audit.ofKind("mandate_set").at(-1)!.mandateDigest, mandateDigest(mandate), "the entry is tagged with the new mandate");
    assert.equal((await governance.list()).length, 1);
  });

  it("rejects an invalid mandate before anything is filed", async () => {
    const { cc, governance } = await createMockCommandCenter({ mandate: null });
    await assert.rejects(cc.setMandate(exampleMandate({ maxRiskBucketUsd: "0" }), "alice.near"), MandateError);
    assert.equal((await governance.list()).length, 0);
  });

  it("a vote that fails leaves the old mandate in force", async () => {
    const { cc } = await createMockCommandCenter({ autoApprove: false });
    const before = (await cc.snapshot()).mandateDigest;
    const p = await cc.setMandate(exampleMandate({ runwayFloorUsd: "9000" }), "alice.near");
    await cc.vote(p.id, "alice.near", "reject");
    const rejected = await cc.vote(p.id, "bob.near", "reject");
    assert.equal(rejected.status, "rejected");
    assert.equal((await cc.snapshot()).mandateDigest, before);
  });
});

describe("opening sleeves", () => {
  it("funds the sleeve from the treasury, and its policy follows the mandate", async () => {
    const { cc, api } = await createMockCommandCenter();
    const p = await cc.openSleeve(open("Alpha", "1000"), "alice.near");
    assert.equal(p.status, "executed");

    const snap = await cc.snapshot();
    assert.equal(snap.sleeves.length, 1);
    assert.equal(snap.treasury.stableUsd, "19000");
    assert.equal(snap.treasury.riskBucket.atRiskUsd, "1000");
    assert.equal(snap.treasury.availableToAllocateUsd, "2000", "bucket cap 3,000 less the 1,000 now at risk");

    const [sleeve] = snap.sleeves;
    assert.equal(sleeve!.status, "active");
    assert.equal(sleeve!.stakeUsd, "1000");
    assert.equal(sleeve!.equityUsd, "1000");
    assert.equal(sleeve!.exit, "none");

    const { policy } = await api.getPolicy(sleeve!.agentId);
    assert.deepEqual(policy!.destinations.list, [{ action: "withdraw", chain: SAFE.chain, address: SAFE.address, memo: null }]);
    assert.equal(policy!.limits.per_transaction?.[STABLE], (1000n * USDC).toString());
    assert.equal(policy!.timelock_ms, 10_000);
  });

  it("keeps the grant out of what the API shows", async () => {
    const { cc } = await createMockCommandCenter();
    await cc.openSleeve(open(), "alice.near");
    const json = JSON.stringify(await cc.snapshot());
    assert.doesNotMatch(json, /ngt_mock/);
    assert.doesNotMatch(json, /grantToken/);
  });

  it("refuses a sleeve bigger than the mandate allows", async () => {
    const { cc } = await createMockCommandCenter();
    await violation(cc.openSleeve(open("Big", "1501"), "alice.near"), "stake_exceeds_sleeve_cap");
  });

  it("refuses to overfill the risk bucket", async () => {
    const { cc } = await createMockCommandCenter();
    await cc.openSleeve(open("A", "1500"), "alice.near");
    await cc.openSleeve(open("B", "1500"), "alice.near");
    await violation(cc.openSleeve(open("C", "1"), "alice.near"), "risk_bucket_exceeded");
    assert.equal((await cc.snapshot()).sleeves.length, 2);
  });

  it("never lets the treasury drop below its runway", async () => {
    const { cc } = await createMockCommandCenter({ treasuryUsdc: 6_000n }); // floor is 5,000
    await violation(cc.openSleeve(open("A", "1500"), "alice.near"), "runway_floor_breached");
    await cc.openSleeve(open("B", "1000"), "alice.near"); // leaves exactly 5,000
    assert.equal((await cc.snapshot()).treasury.stableUsd, "5000");
    await violation(cc.openSleeve(open("C", "1"), "alice.near"), "runway_floor_breached");
  });

  it("refuses an asset the mandate does not list, and bad input", async () => {
    const { cc } = await createMockCommandCenter({ mandate: { riskAssets: [RISK] } });
    await violation(cc.openSleeve(open("A", "100", { riskAsset: RISK_B }), "alice.near"), "asset_not_allowed");
    await assert.rejects(cc.openSleeve(open("A", "-5"), "alice.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "bad_request");
    await assert.rejects(cc.openSleeve(open("  ", "5"), "alice.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "bad_request");
  });

  it("waits for the DAO's vote, and re-checks the mandate when the vote passes", async () => {
    const { cc } = await createMockCommandCenter({ autoApprove: false });
    const filed = await cc.openSleeve(open("A", "1000"), "alice.near");
    assert.equal(filed.status, "pending");
    assert.equal((await cc.snapshot()).sleeves.length, 0, "nothing opens before the vote");

    // The DAO tightens the mandate while the sleeve proposal is still open.
    const tighter = await cc.setMandate(exampleMandate({ maxSleeveStakeUsd: "500", maxRiskBucketUsd: "500" }), "bob.near");
    await cc.vote(tighter.id, "alice.near", "approve");
    await cc.vote(tighter.id, "bob.near", "approve");

    await cc.vote(filed.id, "alice.near", "approve");
    const result = await cc.vote(filed.id, "bob.near", "approve");
    assert.equal(result.status, "failed", "the vote passed but the new mandate no longer allows it");
    assert.match(result.error ?? "", /at most 500 USD/);
    assert.equal((await cc.snapshot()).sleeves.length, 0);
  });

  it("will not open a sleeve while the kill switch is on", async () => {
    const { cc } = await createMockCommandCenter();
    await cc.killSwitch("alice.near", "drill");
    await assert.rejects(cc.openSleeve(open(), "alice.near"), (e: unknown) => e instanceof CommandCenterError && e.code === "killed");
  });

  it("tags every audit entry with the mandate in force", async () => {
    const { cc } = await createMockCommandCenter();
    await cc.openSleeve(open(), "alice.near");
    const digest = mandateDigest(exampleMandate());
    const opened = cc.audit.ofKind("sleeve_opened");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.mandateDigest, digest);
    assert.equal(opened[0]!.sleeveId, "s1");
  });
});
