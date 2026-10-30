import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentApiError } from "@/lib/errors";
import { RISK, SAFE, STABLE } from "@/lib/mandate/example";
import { freezePolicy } from "@/lib/mandate/policies";
import { AGENT, makeWorld, USDC } from "@/lib/testing/world";

const refused = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof AgentApiError && e.code === code, `expected ${code}`);

const swap = (amount: bigint, from = STABLE, to = RISK) => ({ origin_asset: from, destination_asset: to, amount: amount.toString() });
const withdraw = (amount: bigint, over: Partial<{ chain: string; recipient: string; asset: string; memo: string | null }> = {}) => ({
  asset: STABLE, amount: amount.toString(), chain: SAFE.chain, recipient: SAFE.address, ...over,
});

describe("mock Agent API: policy layers", () => {
  it("queues a swap behind the timelock, then runs it at the price at release", async () => {
    const w = await makeWorld();
    const op = await w.grant.swap(AGENT, swap(500n * USDC), { idempotencyKey: "s1" });
    assert.equal(op.status, "QUEUED");
    assert.ok(op.execute_after);
    w.market.setPrice(RISK, 2); // the market moves while the swap waits
    w.api.advance(10_000);
    const done = await w.api.getStatus(op.correlation_id);
    assert.equal(done.status, "SUCCESS");
    // 500 USDC at $2 per token, less the 0.30% mock fee: the fill follows the market at release.
    assert.equal(BigInt(done.swap!.amountOut!), (250n * 10n ** 24n * 9_970n) / 10_000n);
  });

  it("refuses an unlisted destination, an unlisted asset, a transfer, and an over-cap withdrawal", async () => {
    const w = await makeWorld();
    await refused(w.grant.withdraw(AGENT, withdraw(10n * USDC, { recipient: "0xATTACKER" }), { idempotencyKey: "a" }), "policy_destination_denied");
    await refused(w.grant.withdraw(AGENT, withdraw(10n * USDC, { chain: "near" }), { idempotencyKey: "b" }), "policy_destination_denied");
    await refused(w.grant.withdraw(AGENT, withdraw(10n * USDC, { memo: "x" }), { idempotencyKey: "c" }), "policy_destination_denied");
    await refused(w.grant.withdraw(AGENT, withdraw(10n * USDC, { asset: "nep141:other" }), { idempotencyKey: "d" }), "policy_asset_denied");
    await refused(w.grant.withdraw(AGENT, withdraw(w.stake + 1n), { idempotencyKey: "e" }), "policy_limit_exceeded");
    await refused(w.grant.transfer(AGENT, { asset: STABLE, amount: "1", recipient: "owner.near" }), "policy_action_denied");
  });

  it("replays the same key and rejects the same key with a different request", async () => {
    const w = await makeWorld();
    const a = await w.grant.withdraw(AGENT, withdraw(100n * USDC), { idempotencyKey: "k" });
    const b = await w.grant.withdraw(AGENT, withdraw(100n * USDC), { idempotencyKey: "k" });
    assert.equal(a.correlation_id, b.correlation_id);
    await refused(w.grant.withdraw(AGENT, withdraw(101n * USDC), { idempotencyKey: "k" }), "idempotency_conflict");
    assert.equal(w.api.operationsOf(AGENT).length, 1);
  });

  it("limits actions per hour", async () => {
    const w = await makeWorld({ mandate: { maxActionsPerHour: 2, timelockMs: 0 } });
    await w.grant.withdraw(AGENT, withdraw(1n), { idempotencyKey: "1" });
    await w.grant.withdraw(AGENT, withdraw(1n), { idempotencyKey: "2" });
    await refused(w.grant.withdraw(AGENT, withdraw(1n), { idempotencyKey: "3" }), "policy_action_limit_exceeded");
    w.api.advance(3_600_001);
    await w.grant.withdraw(AGENT, withdraw(1n), { idempotencyKey: "4" });
  });

  it("refuses a revoked, expired or foreign grant", async () => {
    const w = await makeWorld();
    await w.api.revokeGrant(AGENT, w.token);
    await refused(w.grant.getBalances(AGENT), "agent_grant_required");
    const fresh = await w.api.issueGrant(AGENT, "x", new Date(w.api.clock.now() + 1_000));
    w.api.advance(2_000);
    await refused(w.api.forGrant(fresh.token).getBalances(AGENT), "agent_grant_required");
    await refused(w.api.forGrant("nope").getBalances(AGENT), "agent_grant_required");
  });
});

describe("mock Agent API: owner approval holds", () => {
  it("holds every money action for the owner, and runs it only after release", async () => {
    const w = await makeWorld({ hold: true });
    const op = await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "h1" });
    assert.equal(op.status, "HELD");
    assert.equal(op.held_reason, "owner_approval");
    assert.deepEqual((await w.api.listHeldExecutions(AGENT)).map((o) => o.correlation_id), [op.correlation_id]);
    w.api.advance(60_000);
    assert.equal((await w.api.getStatus(op.correlation_id)).status, "HELD", "time alone never releases a hold");

    const released = await w.api.releaseHold(AGENT, op.correlation_id);
    assert.equal(released.status, "QUEUED", "release still waits out the veto window");
    w.api.advance(10_000);
    assert.equal((await w.api.getStatus(op.correlation_id)).status, "SUCCESS");
    assert.equal((await w.api.listHeldExecutions(AGENT)).length, 0);
  });

  it("rejecting a hold cancels it and moves nothing", async () => {
    const w = await makeWorld({ hold: true });
    const op = await w.grant.withdraw(AGENT, withdraw(100n * USDC), { idempotencyKey: "h2" });
    const rejected = await w.api.rejectHold(AGENT, op.correlation_id);
    assert.equal(rejected.status, "CANCELLED");
    assert.equal(rejected.failure_code, "rejected_by_owner");
    w.api.advance(60_000);
    assert.equal((await w.grant.getBalances(AGENT)).balances[STABLE], w.stake.toString());
  });

  it("only a held request can be released or rejected", async () => {
    const w = await makeWorld();
    const op = await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "q" });
    await refused(w.api.releaseHold(AGENT, op.correlation_id), "execution_not_held");
    await refused(w.api.rejectHold(AGENT, op.correlation_id), "execution_not_held");
  });
});

describe("mock Agent API: veto window", () => {
  it("the owner can cancel a queued request before it releases, and it never runs", async () => {
    const w = await makeWorld();
    const op = await w.grant.swap(AGENT, swap(300n * USDC), { idempotencyKey: "v1" });
    const cancelled = await w.api.cancelExecution(AGENT, op.correlation_id);
    assert.equal(cancelled.status, "CANCELLED");
    w.api.advance(60_000);
    assert.equal((await w.api.getStatus(op.correlation_id)).status, "CANCELLED");
    assert.equal((await w.grant.getBalances(AGENT)).balances[STABLE], w.stake.toString());
  });

  it("a finished request cannot be cancelled", async () => {
    const w = await makeWorld({ mandate: { timelockMs: 0 } });
    const op = await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "v2" });
    assert.equal(op.status, "SUCCESS");
    await refused(w.api.cancelExecution(AGENT, op.correlation_id), "execution_not_cancellable");
  });
});

describe("mock Agent API: USD budgets", () => {
  const budget = { dailyUsd: "100", weeklyUsd: null, monthlyUsd: null };

  it("refuses a request that would pass the daily budget, and counts it again as the window rolls", async () => {
    const w = await makeWorld({ mandate: { budgets: budget, timelockMs: 0 } });
    await w.grant.swap(AGENT, swap(60n * USDC), { idempotencyKey: "b1" });
    await refused(w.grant.swap(AGENT, swap(60n * USDC), { idempotencyKey: "b2" }), "spend_budget_exceeded");
    await w.grant.swap(AGENT, swap(40n * USDC), { idempotencyKey: "b3" }); // exactly the rest
    await refused(w.grant.swap(AGENT, swap(1n * USDC), { idempotencyKey: "b4" }), "spend_budget_exceeded");
    w.api.advance(24 * 3_600_000 + 1);
    await w.grant.swap(AGENT, swap(60n * USDC), { idempotencyKey: "b5" });
  });

  it("applies weekly and monthly budgets too", async () => {
    const w = await makeWorld({ mandate: { budgets: { dailyUsd: null, weeklyUsd: "150", monthlyUsd: null }, timelockMs: 0 } });
    await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "w1" });
    w.api.advance(2 * 24 * 3_600_000);
    await refused(w.grant.swap(AGENT, swap(60n * USDC), { idempotencyKey: "w2" }), "spend_budget_exceeded");
    w.api.advance(6 * 24 * 3_600_000);
    await w.grant.swap(AGENT, swap(60n * USDC), { idempotencyKey: "w3" });
  });

  it("gives the budget back when the DAO vetoes a request", async () => {
    const w = await makeWorld({ mandate: { budgets: budget } });
    const op = await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "r1" });
    await refused(w.grant.swap(AGENT, swap(1n * USDC), { idempotencyKey: "r2" }), "spend_budget_exceeded");
    await w.api.cancelExecution(AGENT, op.correlation_id);
    await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "r3" });
  });

  it("fails closed when a budget applies but the price is unavailable", async () => {
    const w = await makeWorld({ mandate: { budgets: budget, timelockMs: 0 } });
    w.market.setUnpriced(STABLE, true);
    await refused(w.grant.swap(AGENT, swap(10n * USDC), { idempotencyKey: "p1" }), "spend_price_unavailable");
  });
});

describe("mock Agent API: freeze", () => {
  it("a freeze refuses new requests and stops queued ones from running", async () => {
    const w = await makeWorld();
    const queued = await w.grant.swap(AGENT, swap(100n * USDC), { idempotencyKey: "f1" });
    const { policy, revision } = await w.api.getPolicy(AGENT);
    await w.api.updatePolicy(AGENT, freezePolicy(policy!), revision!);
    await refused(w.grant.swap(AGENT, swap(10n * USDC), { idempotencyKey: "f2" }), "wallet_frozen");
    await refused(w.grant.withdraw(AGENT, withdraw(10n * USDC), { idempotencyKey: "f3" }), "wallet_frozen");
    await refused(w.grant.transfer(AGENT, { asset: STABLE, amount: "1", recipient: "x" }), "wallet_frozen");
    w.api.advance(60_000);
    const stopped = await w.api.getStatus(queued.correlation_id);
    assert.equal(stopped.status, "CANCELLED");
    assert.equal(stopped.failure_code, "wallet_frozen");
    assert.equal((await w.grant.getBalances(AGENT)).balances[STABLE], w.stake.toString());
  });

  it("a pure freeze skips the policy-edit cooldown; any other edit is throttled", async () => {
    const w = await makeWorld();
    let { policy, revision } = await w.api.getPolicy(AGENT);
    const edited = { ...policy!, max_actions_per_hour: 5 };
    ({ revision } = { revision: (await w.api.updatePolicy(AGENT, edited, revision!)).revision });
    await refused(w.api.updatePolicy(AGENT, { ...edited, max_actions_per_hour: 6 }, revision!), "policy_change_throttled");
    await w.api.updatePolicy(AGENT, freezePolicy(edited), revision!); // allowed right away
    ({ policy, revision } = await w.api.getPolicy(AGENT));
    assert.equal(policy!.frozen, true);
  });

  it("refuses an edit made against a stale revision", async () => {
    const w = await makeWorld();
    const { policy } = await w.api.getPolicy(AGENT);
    await refused(w.api.updatePolicy(AGENT, policy!, 99), "policy_revision_conflict");
  });
});
