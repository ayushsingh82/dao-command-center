import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CommandCenter } from "@/lib/command-center/service";
import { createMockCommandCenter, USDC, type MockCommandCenter } from "@/lib/command-center/mock";
import { RISK } from "@/lib/mandate/example";
import { FileRepository, MemoryRepository, PersistenceError, parsePersisted } from "@/lib/persistence/repository";
import { pricePath } from "@/lib/testing/prices";

const quiet = { approvalThresholdUsd: "1000000", timelockMs: 3_000 };
const trend = { kind: "trend" } as const;

/** A second command center on the same mock API and council: what a restarted server would build. */
function restarted(w: MockCommandCenter, repository: MemoryRepository | FileRepository) {
  return new CommandCenter({
    api: w.api,
    governance: w.governance,
    now: () => w.clock.date(),
    treasuryStableAtomic: 20_000n * USDC,
    repository,
    sim: { advance: (ms) => w.api.advance(ms), setPrice: (a, p) => w.market.setPrice(a, p), setStale: (a, s) => w.market.setStale(a, s) },
  });
}

async function run(w: MockCommandCenter, cc: CommandCenter, prices: number[]) {
  for (const p of prices) {
    w.market.setPrice(RISK, p);
    w.api.advance(1_000);
    await cc.tick();
  }
}

describe("saving and restoring the command center", () => {
  it("saves after changes and a restarted center carries on where the first stopped", async () => {
    const repository = new MemoryRepository();
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    await w.cc.openSleeve({ name: "Trend", stakeUsd: "1000", strategy: trend, riskAsset: RISK }, "alice.near");
    const path = pricePath();
    await run(w, w.cc, path.slice(0, 10));
    assert.ok(repository.saves > 0);

    const cc2 = restarted(w, repository);
    assert.equal(await cc2.restore(), true);
    const before = await w.cc.snapshot();
    const after = await cc2.snapshot();
    assert.equal(after.mandateDigest, before.mandateDigest);
    assert.equal(after.treasury.stableUsd, before.treasury.stableUsd);
    assert.deepEqual(after.sleeves.map((s) => [s.id, s.status, s.agentId]), before.sleeves.map((s) => [s.id, s.status, s.agentId]));
    assert.equal(cc2.audit.ofKind("state_restored").length, 1);

    // The restarted center finishes the job: the stake is banked once, and the treasury is whole.
    await run(w, cc2, path.slice(10, 30));
    const done = await cc2.snapshot();
    assert.equal(done.sleeves[0]!.status, "banked");
    assert.equal(done.treasury.stableUsd, "20000");
    assert.equal(w.api.settled.filter((o) => o.agentId === done.sleeves[0]!.agentId).length, 1, "the stake left exactly once");
  });

  it("never reuses a sleeve id after a restart", async () => {
    const repository = new MemoryRepository();
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    await w.cc.openSleeve({ name: "A", stakeUsd: "500", strategy: trend, riskAsset: RISK }, "alice.near");
    const cc2 = restarted(w, repository);
    await cc2.restore();
    await cc2.openSleeve({ name: "B", stakeUsd: "500", strategy: trend, riskAsset: RISK }, "alice.near");
    const ids = (await cc2.snapshot()).sleeves.map((s) => s.id);
    assert.equal(new Set(ids).size, 2);
  });

  it("keeps the kill switch on across a restart", async () => {
    const repository = new MemoryRepository();
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    await w.cc.openSleeve({ name: "A", stakeUsd: "500", strategy: trend, riskAsset: RISK }, "alice.near");
    await w.cc.killSwitch("bob.near", "test");
    const cc2 = restarted(w, repository);
    await cc2.restore();
    const snap = await cc2.snapshot();
    assert.equal(snap.killed?.by, "bob.near");
    assert.equal(snap.sleeves[0]!.status, "frozen");
    await assert.rejects(cc2.openSleeve({ name: "B", stakeUsd: "100", strategy: trend, riskAsset: RISK }, "alice.near"), /kill switch/);
  });

  it("restores nothing from an empty repository, and only into a fresh center", async () => {
    const repository = new MemoryRepository();
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    assert.equal(await restarted(w, new MemoryRepository()).restore(), false);
    await assert.rejects(w.cc.restore(), PersistenceError);
  });

  it("records a failed save in the audit trail and says so", async () => {
    const repository = new MemoryRepository();
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    repository.save = async () => {
      throw new Error("disk full");
    };
    await assert.rejects(w.cc.tick(), /disk full/);
    assert.equal(w.cc.audit.ofKind("persist_failed").length, 1);
  });
});

describe("the file repository", () => {
  it("writes a private file, reads it back, and leaves no temporary file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dao-state-"));
    const file = join(dir, "nested", "state.json");
    const repository = new FileRepository(file);
    const w = await createMockCommandCenter({ mandate: quiet, repository });
    await w.cc.openSleeve({ name: "A", stakeUsd: "500", strategy: trend, riskAsset: RISK }, "alice.near");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const back = await repository.load();
    assert.equal(back?.state.sleeves.length, 1);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(dir, "nested")), ["state.json"]);
  });

  it("returns null for a missing file and refuses a corrupt or foreign one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dao-state-"));
    const file = join(dir, "state.json");
    const repository = new FileRepository(file);
    assert.equal(await repository.load(), null);
    await writeFile(file, "{not json");
    await assert.rejects(repository.load(), PersistenceError);
    await writeFile(file, JSON.stringify({ version: 99 }));
    await assert.rejects(repository.load(), /version 99/);
    assert.ok((await readFile(file, "utf8")).includes("99"), "a refused file is left alone");
  });

  it("rejects a broken audit trail or sleeve counter", async () => {
    const w = await createMockCommandCenter({ mandate: quiet });
    const good = w.cc.exportState();
    assert.doesNotThrow(() => parsePersisted(structuredClone(good)));
    const gap = structuredClone(good);
    gap.audit.splice(0, 1);
    assert.throws(() => parsePersisted(gap), /audit trail is broken/);
    const seq = structuredClone(good);
    seq.seq = -1;
    assert.throws(() => parsePersisted(seq), /sleeve counter/);
  });
});
