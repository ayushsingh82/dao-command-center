import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RISK, STABLE } from "@/lib/mandate/example";
import { EventLog } from "@/lib/runner/events";
import { MemoryStateStore, type RunnerState } from "@/lib/runner/store";
import { HoldStrategy } from "@/lib/strategy/strategy";
import { Trader, type SwapGate, type SwapIntent } from "@/lib/strategy/trader";
import { TrendStrategy } from "@/lib/strategy/trend";
import { AGENT, makeWorld, USDC, type World } from "@/lib/testing/world";

function trader(w: World, extra: { state?: RunnerState; gate?: SwapGate; slippageBps?: bigint; strategy?: TrendStrategy | HoldStrategy } = {}) {
  const log = new EventLog();
  const store = new MemoryStateStore(extra.state);
  const t = new Trader({
    client: w.api,
    grant: w.grant,
    agentId: AGENT,
    stableAsset: STABLE,
    riskAsset: RISK,
    stakeAtomic: w.stake,
    stakeMicroUsd: w.stake,
    strategy: extra.strategy ?? new TrendStrategy(),
    store,
    log,
    multipleBps: 20_000n,
    maxStableSwap: w.stake,
    slippageBps: extra.slippageBps ?? 3_000n,
    gate: extra.gate,
    now: () => w.api.clock.date(),
  });
  return { t, log, store };
}

const bal = async (w: World, asset: string) => BigInt((await w.grant.getBalances(AGENT)).balances[asset] ?? "0");

describe("Trader: trend", () => {
  it("buys the risk asset when the trend turns up, and the fill lands after the veto window", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w);
    await t.step(); // price 1: no trend yet
    assert.equal(log.ofType("swap_queued").length, 0);
    w.market.setPrice(RISK, 1.5);
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 1);
    assert.equal(log.ofType("swap_queued")[0]!.reason, "trend");
    w.api.advance(10_000);
    await t.step();
    assert.equal(log.ofType("swap_settled").length, 1);
    assert.ok((await bal(w, RISK)) > 0n);
    assert.equal(await bal(w, STABLE), 0n);
  });

  it("goes back to the stable asset when the trend turns down", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w);
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    w.api.advance(10_000);
    await t.step();
    w.market.setPrice(RISK, 1.0);
    await t.step();
    const sells = log.ofType("swap_queued").filter((e) => e.from === RISK);
    assert.equal(sells.length, 1);
    w.api.advance(10_000);
    await t.step();
    assert.equal(await bal(w, RISK), 0n);
    assert.ok((await bal(w, STABLE)) > 0n);
  });

  it("does nothing inside the dead band", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w);
    for (const p of [1, 1.002, 0.999, 1.004, 1.0]) {
      w.market.setPrice(RISK, p);
      await t.step();
    }
    assert.equal(log.ofType("swap_queued").length, 0);
  });

  it("will not act on a stale price", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w);
    w.market.setStale(STABLE, true);
    await t.step();
    assert.equal(log.ofType("price_unavailable").length, 1);
    assert.equal(w.api.operationsOf(AGENT).length, 0);
  });

  it("will not trade on a stale price for the risk asset, even when none is held", async () => {
    // Valuing the balances only checks the assets the sleeve holds, so this price must be checked on its own.
    const w = await makeWorld();
    const { t, log } = trader(w);
    await t.step();
    w.market.setPrice(RISK, 1.5);
    w.market.setStale(RISK, true);
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 0);
    assert.equal(log.ofType("price_unavailable")[0]!.assetId, RISK);
    w.market.setStale(RISK, false);
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 1, "it trades as soon as the price is fresh again");
  });

  it("sets a fill floor from the quote, so a swap that fills far worse fails instead of running", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w, { slippageBps: 100n });
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step(); // quoted at $1.50 per token
    w.market.setPrice(RISK, 3); // by the time it releases the token costs twice as much
    w.api.advance(10_000);
    await t.step();
    assert.equal(log.ofType("swap_failed").length, 1);
    assert.equal(log.ofType("swap_failed")[0]!.failureCode, "min_amount_out_not_met");
    assert.equal(await bal(w, STABLE), w.stake, "nothing moved");
  });

  it("keeps one swap in flight at a time", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w);
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    w.market.setPrice(RISK, 2.5);
    await t.step();
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 1);
  });

  it("a hold strategy buys once and keeps the position", async () => {
    const w = await makeWorld({ mandate: { timelockMs: 0 } });
    const { t, log } = trader(w, { strategy: new HoldStrategy(), slippageBps: 100n });
    await t.step();
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 1);
    assert.equal(await bal(w, STABLE), 0n);
  });
});

describe("Trader: working with the stake exit", () => {
  it("at the trigger it sells the whole risk position to raise the stake in cash", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, 0n);
    w.api.setBalance(AGENT, RISK, 2_100n * 10n ** 24n); // $2,100 against a $1,000 stake
    const { t, log, store } = trader(w);
    await t.step();
    const [swap] = log.ofType("swap_queued");
    assert.equal(swap!.reason, "raise_cash");
    assert.equal(swap!.amountIn, (2_100n * 10n ** 24n).toString());
    assert.equal(swap!.to, STABLE);
    assert.equal((await store.load()).banked, false, "the trader never touches the banked flag");
  });

  it("never swaps away the stake while its exit is queued", async () => {
    const w = await makeWorld();
    const { t, log } = trader(w, { state: { banked: true, triggered: true, withdrawalId: "op" } });
    await t.step();
    w.market.setPrice(RISK, 1.5); // the trend wants the risk asset
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 0, "the whole stable balance is reserved for the exit");
  });
});

describe("Trader: holding a swap for the DAO", () => {
  it("a held swap is not sent, and the trader waits for the decision", async () => {
    const w = await makeWorld();
    const seen: SwapIntent[] = [];
    const { t, log } = trader(w, { gate: async (i) => (seen.push(i), "held") });
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.valueMicroUsd, 1_000n * USDC, "valued in micro-USD at the current price");
    assert.equal(seen[0]!.reason, "trend");
    assert.ok(seen[0]!.req.min_amount_out, "the fill floor is already on the request");
    assert.equal(log.ofType("swap_held").length, 1);
    assert.equal(w.api.operationsOf(AGENT).length, 0, "nothing was sent");
    assert.equal(t.isWaitingForApproval, true);
    await t.step();
    await t.step();
    assert.equal(seen.length, 1, "no new decision while one is pending");
  });

  it("after a veto the trader decides again on its next step", async () => {
    const w = await makeWorld();
    let answers: Array<"held" | "send"> = ["held", "send"];
    const { t, log } = trader(w, { gate: async () => answers.shift() ?? "send" });
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    t.discardHeld();
    assert.equal(t.isWaitingForApproval, false);
    await t.step();
    assert.equal(log.ofType("swap_queued").length, 1);
    answers = [];
  });

  it("an approved swap, sent by the command center, is tracked to its fill", async () => {
    const w = await makeWorld();
    let held: SwapIntent | undefined;
    const { t, log } = trader(w, { gate: async (i) => ((held = i), "held") });
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    const op = await w.grant.swap(AGENT, held!.req, { idempotencyKey: held!.key });
    t.adopt(op, held!.req, held!.reason);
    assert.equal(t.isWaitingForApproval, false);
    assert.equal(log.ofType("swap_queued").length, 1);
    w.api.advance(10_000);
    await t.step();
    assert.equal(log.ofType("swap_settled").length, 1);
  });

  it("a swap held by the policy itself (owner approval) stays in flight until released", async () => {
    const w = await makeWorld({ hold: true });
    const { t, log } = trader(w);
    await t.step();
    w.market.setPrice(RISK, 1.5);
    await t.step();
    const [held] = await w.api.listHeldExecutions(AGENT);
    assert.ok(held);
    w.api.advance(60_000);
    await t.step();
    assert.equal(log.ofType("swap_settled").length, 0);
    await w.api.releaseHold(AGENT, held.correlation_id);
    w.api.advance(10_000);
    await t.step();
    assert.equal(log.ofType("swap_settled").length, 1);
  });
});
