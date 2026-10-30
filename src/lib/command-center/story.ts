import { createMockCommandCenter, type MockCommandCenter } from "@/lib/command-center/mock";
import { RISK, RISK_B } from "@/lib/mandate/example";
import { pricePath } from "@/lib/testing/prices";

export type StoryResult = {
  treasuryAfterBankUsd: string;
  treasuryAtEndUsd: string;
  stakeBanked: boolean;
  sealed: boolean;
  tradesApprovedByDao: number;
  vetoes: number;
  attackBeforeKill: { passed: number; total: number };
  attackWhileFrozen: { passed: number; total: number };
  frozenSleeves: number;
  tickWhileKilled: string | undefined;
  resumed: boolean;
  booksReconciled: boolean;
  auditEntries: number;
};

const ALICE = "alice.near";
const BOB = "bob.near";
const CAROL = "carol.near";

/** Two members approve every proposal still waiting. The council needs two of three. */
async function councilPasses(w: MockCommandCenter) {
  for (const p of await w.governance.list()) {
    if (p.status !== "pending") continue;
    for (const member of [ALICE, BOB]) {
      if ((await w.governance.get(p.id))!.status !== "pending") break;
      await w.cc.vote(p.id, member, "approve");
    }
  }
}

/**
 * The whole product in one run, on the mock, with real votes: set a mandate, open two sleeves, trade a
 * rally, decide queue items, bank a stake, survive a drawdown, hit the kill switch, attack, resume, and
 * close the books. Used by `npm run simulate` and by a test that checks the invariants.
 */
export async function runStory(say: (line: string) => void = () => {}): Promise<StoryResult> {
  // Votes decide everything except the founding mandate. Trades over $400 wait for the DAO.
  const w = await createMockCommandCenter({ autoApprove: false, mandate: { timelockMs: 3_000 } });
  const { cc, market, api } = w;
  market.setPrice(RISK_B, 2_000);

  const first = await cc.snapshot();
  say(`The DAO sets its mandate (digest ${first.mandateDigest.slice(0, 12)}…): ${first.treasury.runwayFloorUsd} USD of runway stays put, at most ${first.treasury.riskBucket.capUsd} USD at risk, trades over ${first.mandate!.approvalThresholdUsd} USD need the DAO.`);

  await cc.openSleeve({ name: "Trend NEAR", stakeUsd: "1000", strategy: { kind: "trend" }, riskAsset: RISK }, ALICE);
  await cc.openSleeve({ name: "Hold ETH", stakeUsd: "300", strategy: { kind: "hold" }, riskAsset: RISK_B }, BOB);
  await councilPasses(w);
  const opened = await cc.snapshot();
  say(`Two sleeves open on a vote: ${opened.sleeves.map((s) => `${s.name} (${s.stakeUsd} USD)`).join(", ")}. Treasury now holds ${opened.treasury.stableUsd} USD.`);

  let tradesApprovedByDao = 0;
  let vetoes = 0;
  let treasuryAfterBankUsd = "";
  let vetoDone = false;

  const path = pricePath();
  for (const [i, price] of path.entries()) {
    market.setPrice(RISK, price);
    api.advance(1_000);
    await cc.tick();
    await councilPasses(w);

    const snap = await cc.snapshot();
    for (const item of snap.approvals.filter((a) => a.status === "pending")) {
      if (item.kind === "trade_request") {
        say(`Step ${i + 1}: the DAO is asked to approve — ${item.summary} (${item.valueUsd} USD).`);
        await cc.decide(item.id, "approve", ALICE);
        await cc.decide(item.id, "approve", BOB);
        tradesApprovedByDao++;
      } else if (item.kind === "veto_window" && !vetoDone && item.summary.startsWith("Hold ETH")) {
        say(`Step ${i + 1}: the DAO vetoes — ${item.summary}.`);
        await cc.decide(item.id, "veto", CAROL);
        await cc.decide(item.id, "veto", ALICE);
        vetoes++;
        vetoDone = true;
      }
    }
    if (!treasuryAfterBankUsd && snap.sleeves.some((s) => s.exit === "settled")) {
      treasuryAfterBankUsd = snap.treasury.stableUsd;
      say(`Step ${i + 1}: Trend NEAR's stake is banked. The treasury holds ${treasuryAfterBankUsd} USD again; the sleeve now plays with gains only.`);
    }
  }
  await councilPasses(w);

  const afterRun = await cc.snapshot();
  const trend = afterRun.sleeves.find((s) => s.name === "Trend NEAR")!;
  say(`The market rallied 4x then fell 40%. Trend NEAR is ${trend.status}, sealed=${trend.sealed}, equity ${trend.equityUsd} USD; the treasury still holds ${afterRun.treasury.stableUsd} USD.`);

  const before = await cc.attackTest();
  const countChecks = (rs: typeof before) => ({ passed: rs.flatMap((r) => r.checks).filter((c) => c.pass).length, total: rs.flatMap((r) => r.checks).length });
  const attackBeforeKill = countChecks(before);
  say(`Attack test on every sleeve: ${attackBeforeKill.passed} of ${attackBeforeKill.total} probes refused.`);

  const kill = await cc.killSwitch(CAROL, "drill");
  const tickWhileKilled = (await cc.tick()).skipped;
  say(`Kill switch: ${kill.frozen} sleeves frozen, ${kill.grantsRevoked} grants revoked, ${kill.cancelled} waiting requests cancelled. A tick now does nothing (${tickWhileKilled}).`);
  const attackWhileFrozen = countChecks(await cc.attackTest());
  say(`Attack test while frozen: ${attackWhileFrozen.passed} of ${attackWhileFrozen.total} refused, even for a freshly issued grant.`);

  await cc.resume(ALICE);
  await councilPasses(w);
  if ((await cc.snapshot()).killed) {
    // The API lets a freeze through at once but spaces ordinary policy edits ten minutes apart, and the
    // policy was sealed a little while ago. The unfreeze waits, then lifts by itself.
    say("The DAO votes to lift the kill switch, but the API will not accept the unfreeze until its policy-edit cooldown ends.");
    api.advance(600_001);
    await cc.tick();
  }
  const resumed = (await cc.snapshot()).killed === null;
  say(resumed ? "The kill switch is lifted; the sleeves return on new grants." : "The kill switch is still on.");

  const books = await cc.books();
  say(`Books ${books.reconciled ? "close" : "do NOT close"}: ${books.sleeves.map((s) => `${s.name} funded ${s.fundedUsd}, back to safe ${s.withdrawnToSafeUsd}, P&L ${s.pnlUsd}`).join("; ")}.`);

  const final = await cc.snapshot();
  return {
    treasuryAfterBankUsd,
    treasuryAtEndUsd: final.treasury.stableUsd,
    stakeBanked: final.sleeves.some((s) => s.exit === "settled"),
    sealed: final.sleeves.find((s) => s.name === "Trend NEAR")!.sealed,
    tradesApprovedByDao,
    vetoes,
    attackBeforeKill,
    attackWhileFrozen,
    frozenSleeves: kill.frozen,
    tickWhileKilled,
    resumed,
    booksReconciled: books.reconciled,
    auditEntries: cc.audit.length,
  };
}
