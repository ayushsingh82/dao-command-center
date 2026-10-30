import { createHash } from "node:crypto";
import { MandateError } from "@/lib/errors";
import { usdToMicro } from "@/lib/risk/pricing";

/**
 * The DAO's treasury rules, signed once. Everything the command center does is checked against the mandate
 * in force, and every audit entry records its digest.
 *
 * USD amounts are decimal strings ("2500", "0.5") so they never pass through floating point.
 */
export type Mandate = {
  version: 1;
  /** The DAO that owns the agents, for example `example.sputnik-dao.near`. */
  daoAccount: string;
  /** Where a sleeve's stake returns when it is banked. The only withdrawal destination a sleeve may use. */
  safe: { chain: string; address: string };
  /** The asset stakes are denominated in and banked in (for example USDC). */
  stableAsset: string;
  /** Assets a sleeve may hold besides the stable asset. */
  riskAssets: string[];
  /** Stays in the treasury. Opening a sleeve may never push the treasury's stable balance below this. */
  runwayFloorUsd: string;
  /** The most that may be at risk in sleeves at once (stakes not yet banked). */
  maxRiskBucketUsd: string;
  /** The largest stake for one sleeve. */
  maxSleeveStakeUsd: string;
  /** Equity / stake at which a sleeve banks its stake, in basis points (20_000 = 2x). */
  bankMultipleBps: number;
  /** After banking, remove `withdraw` from the sleeve's policy so the stake can never leave twice. */
  sealAfterBank: boolean;
  /** The delay before any money action runs: the DAO's veto window. */
  timelockMs: number;
  maxActionsPerHour: number;
  /** A trade worth more than this waits in the approvals queue instead of being sent. */
  approvalThresholdUsd: string;
  /** Rolling USD budgets applied to every sleeve's policy. `null` means no budget. */
  budgets: { dailyUsd: string | null; weeklyUsd: string | null; monthlyUsd: string | null };
  /** Worst accepted fill versus the quote, in basis points. */
  slippageBps: number;
  /** Put every sleeve on owner approval: each of its money actions waits for the DAO. */
  holdAllSleeves: boolean;
};

const DECIMAL = /^\d+(\.\d{1,6})?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function usd(value: string): bigint | null {
  return DECIMAL.test(value) ? usdToMicro(value) : null;
}

/** Every rule the mandate must satisfy, as a list of problems. Empty means valid. */
export function mandateProblems(m: Mandate): string[] {
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  need(m.version === 1, "version must be 1");
  need(m.daoAccount.trim().length > 0, "daoAccount is required");
  need(m.safe.chain.trim().length > 0 && m.safe.address.trim().length > 0, "safe chain and address are required");
  need(m.stableAsset.trim().length > 0, "stableAsset is required");
  need(new Set(m.riskAssets).size === m.riskAssets.length, "riskAssets must be unique");
  need(!m.riskAssets.includes(m.stableAsset), "riskAssets must not include the stable asset");
  need(m.riskAssets.every((a) => a.trim().length > 0), "riskAssets must not contain empty ids");

  const floor = usd(m.runwayFloorUsd);
  const bucket = usd(m.maxRiskBucketUsd);
  const stake = usd(m.maxSleeveStakeUsd);
  const threshold = usd(m.approvalThresholdUsd);
  need(floor !== null, "runwayFloorUsd must be a USD amount with at most 6 decimals");
  need(bucket !== null && bucket > 0n, "maxRiskBucketUsd must be a positive USD amount");
  need(stake !== null && stake > 0n, "maxSleeveStakeUsd must be a positive USD amount");
  need(threshold !== null, "approvalThresholdUsd must be a USD amount with at most 6 decimals");
  if (bucket !== null && stake !== null) need(stake <= bucket, "maxSleeveStakeUsd must not exceed maxRiskBucketUsd");

  for (const [name, value] of Object.entries(m.budgets)) {
    if (value !== null) need(usd(value) !== null && usd(value)! > 0n, `budgets.${name} must be null or a positive USD amount`);
  }
  need(Number.isInteger(m.bankMultipleBps) && m.bankMultipleBps > 10_000 && m.bankMultipleBps <= 1_000_000, "bankMultipleBps must be an integer above 10000 and at most 1000000");
  need(Number.isInteger(m.timelockMs) && m.timelockMs >= 0 && m.timelockMs <= 30 * DAY_MS, "timelockMs must be between 0 and 30 days");
  need(Number.isInteger(m.maxActionsPerHour) && m.maxActionsPerHour >= 1 && m.maxActionsPerHour <= 1_000, "maxActionsPerHour must be between 1 and 1000");
  need(Number.isInteger(m.slippageBps) && m.slippageBps >= 0 && m.slippageBps <= 5_000, "slippageBps must be between 0 and 5000");
  return problems;
}

/** Throws a MandateError listing every problem. */
export function validateMandate(m: Mandate): Mandate {
  const problems = mandateProblems(m);
  if (problems.length) throw new MandateError(problems);
  return m;
}

/** JSON with keys sorted at every level, so the same mandate always serializes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 of the canonical mandate. Anyone holding the mandate can recompute it. */
export function mandateDigest(m: Mandate): string {
  return createHash("sha256").update(canonicalJson(m)).digest("hex");
}

export const usdAmount = usd;
