import assert from "node:assert/strict";
import { it } from "node:test";
import { runStory } from "@/lib/command-center/story";

it("the whole story holds: votes, queue, banking, sealing, drawdown, kill switch, resume, closed books", async () => {
  const lines: string[] = [];
  const r = await runStory((l) => lines.push(l));

  assert.equal(r.stakeBanked, true);
  assert.equal(r.sealed, true, "banking led to a passed proposal to seal the policy");
  assert.equal(r.treasuryAfterBankUsd, "19700", "the 1,000 USD stake came back; the 300 USD hold sleeve is still out");
  assert.equal(r.treasuryAtEndUsd, "19700", "and the drawdown cost the treasury nothing");
  assert.ok(r.tradesApprovedByDao >= 1, "the DAO decided at least one large trade");
  assert.equal(r.vetoes, 1);

  assert.ok(r.attackBeforeKill.total >= 14);
  assert.equal(r.attackBeforeKill.passed, r.attackBeforeKill.total, "every probe refused on live sleeves");
  assert.equal(r.attackWhileFrozen.passed, r.attackWhileFrozen.total, "and while frozen");
  assert.equal(r.frozenSleeves, 2);
  assert.equal(r.tickWhileKilled, "kill_switch");
  assert.equal(r.resumed, true);
  assert.equal(r.booksReconciled, true);
  assert.ok(r.auditEntries > 50);
  assert.ok(lines.length >= 8, "it narrates what happened");
});
