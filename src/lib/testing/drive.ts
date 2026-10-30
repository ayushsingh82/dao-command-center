import type { MockCommandCenter } from "@/lib/command-center/mock";
import { RISK } from "@/lib/mandate/example";

export const trend = { kind: "trend" } as const;

/** Move the market one price at a time, let a second pass, and run a tick, for each price. */
export async function run(w: MockCommandCenter, prices: number[], asset = RISK, stepMs = 1_000) {
  for (const p of prices) {
    w.market.setPrice(asset, p);
    w.api.advance(stepMs);
    await w.cc.tick();
  }
}

/** Open a trend sleeve and return its id. The council must be on auto-approve, or the caller votes. */
export async function openTrend(w: MockCommandCenter, name = "Trend", stakeUsd = "1000", over: { hold?: boolean; riskAsset?: string } = {}) {
  await w.cc.openSleeve({ name, stakeUsd, strategy: trend, riskAsset: over.riskAsset ?? RISK, hold: over.hold }, "alice.near");
  const s = (await w.cc.snapshot()).sleeves.at(-1)!;
  return { id: s.id, agentId: s.agentId };
}

export const pending = async (w: MockCommandCenter, kind?: string) =>
  (await w.cc.snapshot()).approvals.filter((a) => a.status === "pending" && (kind === undefined || a.kind === kind));

/** Everything a member's vote can do from here: decide a queue item as a given member. */
export const vote = (w: MockCommandCenter, itemId: string, decision: "approve" | "veto", ...members: string[]) =>
  members.reduce<Promise<unknown>>((p, m) => p.then(() => w.cc.decide(itemId, decision, m)), Promise.resolve());
