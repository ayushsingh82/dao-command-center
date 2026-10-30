import { runStory } from "@/lib/command-center/story";

// The whole product on the mock, with real council votes. Moves no funds and touches no network.
console.log("DAO Command Center: headless simulation (mock Agent API, mock council)\n");
const result = await runStory((line) => console.log(`- ${line}`));
console.log("\nResult");
console.log(JSON.stringify(result, null, 2));

const problems: string[] = [];
if (!result.stakeBanked) problems.push("the stake was not banked");
if (!result.sealed) problems.push("the policy was not sealed after banking");
if (result.treasuryAtEndUsd !== "19700") problems.push(`the treasury ended at ${result.treasuryAtEndUsd}, not 19700 (20000 less the 300 USD sleeve still out)`);
if (result.attackBeforeKill.passed !== result.attackBeforeKill.total) problems.push("an attack probe was not refused");
if (result.attackWhileFrozen.passed !== result.attackWhileFrozen.total) problems.push("a probe got through while frozen");
if (!result.resumed) problems.push("the kill switch was not lifted");
if (!result.booksReconciled) problems.push("the books do not close");
if (problems.length) {
  console.error(`\nFAILED: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
