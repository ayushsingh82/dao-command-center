import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffPolicies } from "@/lib/mandate/diff";
import { exampleMandate, RISK, RISK_B, SAFE, STABLE } from "@/lib/mandate/example";
import { buildSleevePolicy, freezePolicy, sealPolicy } from "@/lib/mandate/policies";

const input = { stakeAtomic: 1_000_000_000n, riskAsset: RISK, riskCapAtomic: 10n ** 30n };

describe("sleeve policy", () => {
  it("pins withdrawals to the DAO's safe and caps the stable asset at the stake", () => {
    const p = buildSleevePolicy(exampleMandate(), input);
    assert.deepEqual(p.destinations, { mode: "only", list: [{ action: "withdraw", chain: SAFE.chain, address: SAFE.address, memo: null }] });
    assert.equal(p.limits.per_transaction?.[STABLE], "1000000000");
    assert.equal(p.limits.per_transaction?.[RISK], (10n ** 30n).toString());
    assert.deepEqual(p.assets, [STABLE, RISK]);
    assert.deepEqual(p.actions, ["swap", "withdraw"]);
    assert.equal(p.frozen, false);
    assert.equal(p.owner_approval, false);
  });

  it("carries the mandate's veto window, rate limit and budgets", () => {
    const p = buildSleevePolicy(
      exampleMandate({ timelockMs: 3_600_000, maxActionsPerHour: 12, budgets: { dailyUsd: "100", weeklyUsd: "400", monthlyUsd: null } }),
      input,
    );
    assert.equal(p.timelock_ms, 3_600_000);
    assert.equal(p.max_actions_per_hour, 12);
    assert.deepEqual(p.budget, { daily_usd: "100", weekly_usd: "400", monthly_usd: null });
  });

  it("refuses a risk asset the mandate does not allow, and a zero stake", () => {
    assert.throws(() => buildSleevePolicy(exampleMandate({ riskAssets: [RISK_B] }), input), /not allowed/);
    assert.throws(() => buildSleevePolicy(exampleMandate(), { ...input, stakeAtomic: 0n }), /positive/);
  });

  it("puts a sleeve on owner approval when the mandate or the sleeve says so", () => {
    assert.equal(buildSleevePolicy(exampleMandate({ holdAllSleeves: true }), input).owner_approval, true);
    assert.equal(buildSleevePolicy(exampleMandate(), { ...input, hold: true }).owner_approval, true);
    assert.equal(buildSleevePolicy(exampleMandate({ holdAllSleeves: true }), { ...input, hold: false }).owner_approval, false);
  });

  it("sealing removes withdraw and nothing else; freezing sets frozen and nothing else", () => {
    const p = buildSleevePolicy(exampleMandate(), input);
    const sealed = sealPolicy(p);
    assert.deepEqual(sealed.actions, ["swap"]);
    assert.deepEqual({ ...sealed, actions: p.actions }, p);
    const frozen = freezePolicy(p);
    assert.equal(frozen.frozen, true);
    assert.deepEqual({ ...frozen, frozen: false }, p);
    assert.deepEqual(buildSleevePolicy(exampleMandate(), input, { sealed: true }), sealed);
    assert.deepEqual(buildSleevePolicy(exampleMandate(), input, { frozen: true }), frozen);
  });
});

describe("policy diff", () => {
  const base = buildSleevePolicy(exampleMandate(), input);

  it("shows nothing for identical policies", () => {
    assert.deepEqual(diffPolicies(base, structuredClone(base)), []);
  });

  it("shows exactly what changed, by path", () => {
    const next = buildSleevePolicy(exampleMandate({ timelockMs: 99, budgets: { dailyUsd: "50", weeklyUsd: null, monthlyUsd: null } }), input);
    assert.deepEqual(diffPolicies(base, next), [
      { path: "budget.daily_usd", before: null, after: "50" },
      { path: "timelock_ms", before: 10_000, after: 99 },
    ]);
  });

  it("shows removing withdraw as a change to the actions list", () => {
    const changes = diffPolicies(base, sealPolicy(base));
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.path, "actions");
  });

  it("against no policy, every field is an addition", () => {
    const changes = diffPolicies(null, base);
    assert.ok(changes.length > 5);
    assert.ok(changes.every((c) => c.before === undefined));
  });
});
