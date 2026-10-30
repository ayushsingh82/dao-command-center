import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MandateError } from "@/lib/errors";
import { exampleMandate, RISK, STABLE } from "@/lib/mandate/example";
import { canonicalJson, mandateDigest, mandateProblems, validateMandate, type Mandate } from "@/lib/mandate/mandate";

const problemsOf = (over: Partial<Mandate>) => mandateProblems(exampleMandate(over));

describe("mandate validation", () => {
  it("accepts the example mandate", () => {
    assert.deepEqual(mandateProblems(exampleMandate()), []);
    assert.doesNotThrow(() => validateMandate(exampleMandate()));
  });

  it("lists every problem at once", () => {
    const bad = exampleMandate({ daoAccount: "", maxRiskBucketUsd: "0", bankMultipleBps: 10_000, timelockMs: -1 });
    try {
      validateMandate(bad);
      assert.fail("should throw");
    } catch (e) {
      assert.ok(e instanceof MandateError);
      assert.ok(e.problems.length >= 4);
    }
  });

  it("rejects bad money amounts and impossible limits", () => {
    assert.ok(problemsOf({ runwayFloorUsd: "-1" }).length);
    assert.ok(problemsOf({ runwayFloorUsd: "1.1234567" }).length, "more than 6 decimals");
    assert.ok(problemsOf({ maxSleeveStakeUsd: "4000" }).length, "a sleeve may not exceed the whole bucket");
    assert.ok(problemsOf({ approvalThresholdUsd: "abc" }).length);
    assert.ok(problemsOf({ budgets: { dailyUsd: "0", weeklyUsd: null, monthlyUsd: null } }).length, "a budget must be positive or null");
  });

  it("rejects a trigger that is not above 1x, and out-of-range delays and rates", () => {
    assert.ok(problemsOf({ bankMultipleBps: 10_000 }).length);
    assert.ok(problemsOf({ bankMultipleBps: 10_001 }).length === 0);
    assert.ok(problemsOf({ timelockMs: 31 * 24 * 3_600_000 }).length);
    assert.ok(problemsOf({ maxActionsPerHour: 0 }).length);
    assert.ok(problemsOf({ slippageBps: 5_001 }).length);
  });

  it("rejects duplicate or overlapping assets", () => {
    assert.ok(problemsOf({ riskAssets: [RISK, RISK] }).length);
    assert.ok(problemsOf({ riskAssets: [STABLE] }).length, "the stable asset is not a risk asset");
  });
});

describe("mandate digest", () => {
  it("is stable and does not depend on key order", () => {
    const a = exampleMandate();
    const reordered = JSON.parse(JSON.stringify(a), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)) as Mandate;
    assert.equal(mandateDigest(a), mandateDigest(reordered));
    assert.match(mandateDigest(a), /^[0-9a-f]{64}$/);
  });

  it("changes when any rule changes", () => {
    const base = mandateDigest(exampleMandate());
    assert.notEqual(base, mandateDigest(exampleMandate({ runwayFloorUsd: "5001" })));
    assert.notEqual(base, mandateDigest(exampleMandate({ safe: { chain: "base", address: "0xOTHER" } })));
    assert.notEqual(base, mandateDigest(exampleMandate({ budgets: { dailyUsd: "100", weeklyUsd: null, monthlyUsd: null } })));
  });

  it("canonical JSON sorts keys and drops undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } }), '{"a":{"d":2,"e":[3,{"y":2,"z":1}]},"b":1}');
  });
});
