import { z } from "zod";
import { MandateSchema, StrategySchema } from "@/lib/mandate/schema";

const member = z.string().min(1, "who is acting?");

export const SetMandateBody = z.object({ mandate: MandateSchema, by: member });
export const PreviewMandateBody = z.object({ mandate: MandateSchema });
export const OpenSleeveBody = z.object({
  name: z.string().min(1),
  stakeUsd: z.string().min(1),
  strategy: StrategySchema,
  riskAsset: z.string().min(1),
  hold: z.boolean().optional(),
  by: member,
});
export const RetryBankBody = z.object({ by: member });
export const DecideBody = z.object({ decision: z.enum(["approve", "veto"]), member });
export const VoteBody = z.object({ member, vote: z.enum(["approve", "reject"]) });
export const KillBody = z.object({ by: member, reason: z.string().min(1).default("manual") });
export const ResumeBody = z.object({ by: member });
export const AttackBody = z.object({ sleeveId: z.string().optional() }).default({});

export const AdvanceBody = z.object({ ms: z.number().int().positive().max(30 * 86_400_000) });
export const PriceBody = z.object({ assetId: z.string().min(1), price: z.number().positive() });
export const StaleBody = z.object({ assetId: z.string().min(1), stale: z.boolean() });
export const GovernanceBody = z.object({ autoApprove: z.boolean() });
export const PlayBody = z.object({
  assetId: z.string().min(1),
  prices: z.array(z.number().positive()).min(1).max(500),
  stepMs: z.number().int().positive().max(3_600_000).default(1_000),
});
export const ResetBody = z
  .object({
    treasuryUsdc: z.number().int().positive().optional(),
    autoApprove: z.boolean().optional(),
    mandate: MandateSchema.partial().nullable().optional(),
  })
  .default({});
