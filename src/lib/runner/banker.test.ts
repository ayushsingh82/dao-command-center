import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RISK, SAFE, STABLE } from "@/lib/mandate/example";
import { stakeKey } from "@/lib/risk/trigger";
import { StakeBanker } from "@/lib/runner/banker";
import { MemoryStateStore, type RunnerState, type StateStore } from "@/lib/runner/store";
import { AGENT, makeWorld, type World } from "@/lib/testing/world";

const banker = (w: World, store: StateStore = new MemoryStateStore()) =>
  new StakeBanker({
    client: w.api,
    grant: w.grant,
    agentId: AGENT,
    asset: STABLE,
    stakeAtomic: w.stake,
    stakeMicroUsd: w.stake, // a stable asset with 6 decimals: atomic units == micro-USD
    chain: SAFE.chain,
    safeAddress: SAFE.address,
    store,
    multipleBps: 20_000n,
    now: () => w.api.clock.date(),
  });

const withdrawals = (w: World) => w.api.operationsOf(AGENT).filter((o) => !o.swap);

/** A store that fails one chosen save, to model a crash between sending and recording. */
class FlakyStore extends MemoryStateStore {
  private saves = 0;
  constructor(private failOn: number) {
    super();
  }
  override async save(state: RunnerState) {
    if (++this.saves === this.failOn) throw new Error("disk full");
    await super.save(state);
  }
}

describe("StakeBanker", () => {
  it("does nothing below the trigger", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, (w.stake * 3n) / 2n);
    const b = banker(w);
    await b.tick();
    assert.equal(b.log.ofType("trigger").length, 0);
    assert.equal(withdrawals(w).length, 0);
  });

  it("banks exactly the stake at the trigger and reports settlement once", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    const store = new MemoryStateStore();
    const b = banker(w, store);
    await b.tick();
    assert.equal(b.log.ofType("withdraw_queued").length, 1);
    assert.equal((await store.load()).banked, true);
    w.api.advance(10_000);
    await b.tick();
    await b.tick();
    assert.equal(b.log.ofType("withdraw_settled").length, 1);
    assert.equal(w.api.settled.length, 1);
    assert.equal(w.api.settled[0]!.request.amount, w.stake.toString());
    assert.equal(w.api.settled[0]!.request.recipient, SAFE.address);
  });

  it("never banks twice, however long equity keeps rising", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    const b = banker(w);
    for (let i = 0; i < 5; i++) {
      await b.tick();
      w.api.setBalance(AGENT, STABLE, w.stake * BigInt(3 + i));
      w.api.advance(10_000);
    }
    assert.equal(withdrawals(w).length, 1);
  });

  it("a crash between sending and recording replays the same operation, not a second one", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    // Save 1 records the latched trigger; save 2 would record that the exit was sent.
    const store = new FlakyStore(2);
    await assert.rejects(banker(w, store).tick(), /disk full/);
    assert.equal(withdrawals(w).length, 1, "the withdrawal was already sent");
    assert.equal((await store.load()).banked, false, "but the crash lost the record of it");
    const restarted = banker(w, store);
    await restarted.tick();
    assert.equal(withdrawals(w).length, 1, "the same key replayed the original operation");
    assert.equal((await store.load()).withdrawalId, withdrawals(w)[0]!.correlation_id);
  });

  it("halts on an unpriced balance instead of guessing", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    w.market.setStale(STABLE, true);
    const b = banker(w);
    await b.tick();
    assert.equal(b.log.ofType("price_unavailable").length, 1);
    assert.equal(withdrawals(w).length, 0);
  });

  it("waits for cash when the gains are held in the risk asset", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake / 2n);
    w.api.setBalance(AGENT, RISK, 1_600n * 10n ** 24n); // $1,600 at $1: equity 2.1x the stake
    const b = banker(w);
    await b.tick();
    assert.equal(b.log.ofType("trigger").length, 1);
    assert.equal(b.log.ofType("awaiting_cash").length, 1);
    assert.equal(withdrawals(w).length, 0);
  });

  it("is refused, and stays unbanked, when the agent is frozen", async () => {
    const w = await makeWorld({ policy: (p) => ({ ...p, frozen: true }) });
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    const store = new MemoryStateStore();
    const b = banker(w, store);
    await b.tick();
    assert.deepEqual(b.log.ofType("refused").map((e) => e.code), ["wallet_frozen"]);
    assert.equal((await store.load()).banked, false);
  });

  it("after a veto, one deliberate retry sends exactly one new operation", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    const store = new MemoryStateStore();
    const b = banker(w, store);
    await b.tick();
    const first = withdrawals(w)[0]!;
    assert.equal(await b.retry(), false, "nothing to retry while the exit is in flight");

    await w.api.cancelExecution(AGENT, first.correlation_id); // the DAO's veto
    await b.tick();
    assert.equal(b.log.ofType("withdraw_failed").length, 1);

    assert.equal(await b.retry(), true);
    assert.equal(await b.retry(), false, "a retry is used up by the exit it starts");
    await b.tick();
    const all = withdrawals(w);
    assert.equal(all.length, 2);
    assert.equal(all[1]!.idempotencyKey, stakeKey(AGENT, 1));
    assert.notEqual(all[1]!.correlation_id, first.correlation_id);
    await b.tick();
    assert.equal(withdrawals(w).length, 2, "and only one");
  });

  it("does not retry an exit that settled", async () => {
    const w = await makeWorld();
    w.api.setBalance(AGENT, STABLE, w.stake * 2n);
    const b = banker(w);
    await b.tick();
    w.api.advance(10_000);
    await b.tick();
    assert.equal(await b.retry(), false);
  });
});

describe("stake key", () => {
  it("is fixed per agent, with a distinct key for each deliberate retry", () => {
    assert.equal(stakeKey("a"), "principal:a");
    assert.equal(stakeKey("a", 0), stakeKey("a"));
    assert.equal(stakeKey("a", 2), "principal:a:retry-2");
  });
});
