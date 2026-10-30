import type { MarketAsset } from "@/lib/agent-api/market";
import type { Mandate } from "@/lib/mandate/mandate";

/** Simulation assets. A live run replaces these with ids from the Agent API's token catalog. */
export const STABLE = "nep141:usdc-sim";
export const RISK = "nep141:wnear-sim";
export const RISK_B = "nep141:weth-sim";
export const SAFE = { chain: "base", address: "0xSAFE000000000000000000000000000000000001" };

export const SIM_ASSETS: MarketAsset[] = [
  { asset_id: STABLE, symbol: "USDC", decimals: 6, blockchain: "near", price: 1 },
  { asset_id: RISK, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 1 },
  { asset_id: RISK_B, symbol: "wETH", decimals: 18, blockchain: "near", price: 2_000 },
];

/** A sensible mandate for the mock: 5,000 USDC of runway, up to 3,000 at risk, 1,500 per sleeve. */
export function exampleMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    version: 1,
    daoAccount: "example.sputnik-dao.near",
    safe: SAFE,
    stableAsset: STABLE,
    riskAssets: [RISK, RISK_B],
    runwayFloorUsd: "5000",
    maxRiskBucketUsd: "3000",
    maxSleeveStakeUsd: "1500",
    bankMultipleBps: 20_000,
    sealAfterBank: true,
    timelockMs: 10_000,
    maxActionsPerHour: 60,
    approvalThresholdUsd: "400",
    budgets: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null },
    slippageBps: 3_000,
    holdAllSleeves: false,
    ...overrides,
  };
}
