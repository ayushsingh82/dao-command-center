import { z } from "zod";
import type { Mandate } from "@/lib/mandate/mandate";
import type { StrategySpec } from "@/lib/strategy/strategy";

const usd = z.string().regex(/^\d+(\.\d{1,6})?$/, "a USD amount, for example \"2500\" or \"0.5\"");

/** The shape of a mandate on the wire. Business rules (limits, ordering) are checked by `validateMandate`. */
export const MandateSchema = z.object({
  version: z.literal(1),
  daoAccount: z.string().min(1),
  safe: z.object({ chain: z.string().min(1), address: z.string().min(1) }),
  stableAsset: z.string().min(1),
  riskAssets: z.array(z.string().min(1)),
  runwayFloorUsd: usd,
  maxRiskBucketUsd: usd,
  maxSleeveStakeUsd: usd,
  bankMultipleBps: z.number().int(),
  sealAfterBank: z.boolean(),
  timelockMs: z.number().int(),
  maxActionsPerHour: z.number().int(),
  approvalThresholdUsd: usd,
  budgets: z.object({ dailyUsd: usd.nullable(), weeklyUsd: usd.nullable(), monthlyUsd: usd.nullable() }),
  slippageBps: z.number().int(),
  holdAllSleeves: z.boolean(),
}) satisfies z.ZodType<Mandate>;

export const StrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trend"), alpha: z.number().gt(0).lte(1).optional(), band: z.number().min(0).lt(1).optional() }),
  z.object({ kind: z.literal("hold") }),
]) satisfies z.ZodType<StrategySpec>;
