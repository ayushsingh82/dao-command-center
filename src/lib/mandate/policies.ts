import type { Mandate } from "@/lib/mandate/mandate";
import type { Policy } from "@/lib/policy/types";

export type SleevePolicyInput = {
  /** The stake in the stable asset's atomic units; also the per-transaction cap on the stable asset. */
  stakeAtomic: bigint;
  /** The one risk asset this sleeve may hold. */
  riskAsset: string;
  /** Per-transaction cap on the risk asset, in its atomic units. */
  riskCapAtomic: bigint;
  /** Overrides the mandate's `holdAllSleeves` for this sleeve. */
  hold?: boolean;
};

export type PolicyState = {
  /** `withdraw` removed: the stake has been banked and can never leave again. */
  sealed?: boolean;
  frozen?: boolean;
};

/**
 * The policy a sleeve's agent runs under, derived from the mandate: one withdrawal destination (the DAO's
 * safe), the stake as the cap on the stable asset, a generous cap on the one risk asset, the mandate's
 * budgets, rate limit and veto window.
 */
export function buildSleevePolicy(m: Mandate, s: SleevePolicyInput, state: PolicyState = {}): Policy {
  if (s.stakeAtomic <= 0n) throw new Error("stakeAtomic must be positive");
  if (!m.riskAssets.includes(s.riskAsset)) throw new Error(`risk asset ${s.riskAsset} is not allowed by the mandate`);
  return {
    frozen: state.frozen ?? false,
    actions: state.sealed ? ["swap"] : ["swap", "withdraw"],
    confidential: false,
    owner_approval: s.hold ?? m.holdAllSleeves,
    assets: [m.stableAsset, s.riskAsset],
    limits: {
      per_transaction: {
        [m.stableAsset]: s.stakeAtomic.toString(),
        [s.riskAsset]: s.riskCapAtomic.toString(),
      },
    },
    max_actions_per_hour: m.maxActionsPerHour,
    destinations: {
      mode: "only",
      list: [{ action: "withdraw", chain: m.safe.chain, address: m.safe.address, memo: null }],
    },
    budget: {
      daily_usd: m.budgets.dailyUsd,
      weekly_usd: m.budgets.weeklyUsd,
      monthly_usd: m.budgets.monthlyUsd,
    },
    timelock_ms: m.timelockMs,
  };
}

/** The same policy with `withdraw` removed: "the stake leaves once" becomes a policy fact, not a convention. */
export function sealPolicy(policy: Policy): Policy {
  return { ...policy, actions: policy.actions.filter((a) => a !== "withdraw") };
}

/** The same policy, frozen. Applying it is a "pure freeze", which the API lets through its edit cooldown. */
export function freezePolicy(policy: Policy): Policy {
  return { ...policy, frozen: true };
}
