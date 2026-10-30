import { z } from "zod";
import type { OwnerAction } from "@/lib/governance/types";
import { MandateSchema, StrategySchema } from "@/lib/mandate/schema";

/** The wire shape of an owner action. A DAO's consent is read back from the chain, so it is validated. */
export const OwnerActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_mandate"), mandate: MandateSchema }),
  z.object({
    type: z.literal("open_sleeve"),
    sleeveId: z.string().min(1),
    name: z.string().min(1),
    stakeAtomic: z.string().regex(/^\d+$/),
    strategy: StrategySchema,
    riskAsset: z.string().min(1),
    hold: z.boolean(),
  }),
  z.object({ type: z.literal("seal_sleeve"), sleeveId: z.string().min(1) }),
  z.object({ type: z.literal("decide_item"), itemId: z.string().min(1), decision: z.enum(["approve", "veto"]) }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("retry_bank"), sleeveId: z.string().min(1) }),
]) satisfies z.ZodType<OwnerAction>;
