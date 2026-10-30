// Read-only check of the live Agent API. Spends nothing and signs nothing: it asks the service who we are,
// whether it is healthy, and whether the assets in the example mandate exist there.
//
//   npm run live:check            (reads NEAR_INTENTS_AGENT_API_KEY from .env)
import { createAgentApi } from "@near-intents-agent-api/sdk";
import { exampleMandate } from "@/lib/mandate/example";

const key = process.env.NEAR_INTENTS_AGENT_API_KEY;
if (!key) {
  console.error("Set NEAR_INTENTS_AGENT_API_KEY (an naa_ key) in .env first.");
  process.exit(2);
}

const api = createAgentApi({ apiKey: key });
let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};

const network = await api.getNetwork();
check("service reachable", true, JSON.stringify(network));

const me = await api.whoami();
check("API key accepted", true, JSON.stringify(me));

const tokens = await api.getTokens();
check("token catalogue", tokens.length > 0, `${tokens.length} assets`);

const m = exampleMandate();
const ids = new Set(tokens.map((t) => t.asset_id));
for (const asset of [m.stableAsset, ...m.riskAssets]) {
  check(`mandate asset exists: ${asset}`, ids.has(asset), ids.has(asset) ? "" : "the example mandate uses simulation ids; set real ones before a live run");
}

process.exit(failed ? 1 : 0);
