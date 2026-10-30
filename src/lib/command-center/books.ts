import type { AuditLog } from "@/lib/audit/log";
import type { AgentClient } from "@/lib/agent-api/types";
import type { Books, BooksSleeve, SleeveRecord } from "@/lib/command-center/types";
import { PriceUnavailableError } from "@/lib/errors";
import type { Mandate } from "@/lib/mandate/mandate";
import type { TokenInfo } from "@/lib/policy/types";
import { atomicToMicroUsd, microToUsdString, portfolioValueMicroUsd } from "@/lib/risk/pricing";

export type BooksContext = {
  api: AgentClient;
  mandate: Mandate;
  sleeves: SleeveRecord[];
  tokens: TokenInfo[];
  now: Date;
  treasuryStableAtomic: bigint;
  audit: AuditLog;
};

const strings = (m: Map<string, bigint>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));

/**
 * Reconcile each sleeve two ways. First, from the API's execution history: starting from the funding, apply
 * every successful operation and see what the balances should be, then compare with what the API reports.
 * Second, against our own audit trail: any operation the API has that we never recorded is listed. Either
 * mismatch means the books do not close. (Against a live deployment the first comparison also uses the
 * chain's own transfer records; here the API is the only source.)
 */
export async function buildBooks(ctx: BooksContext): Promise<Books> {
  const { api, mandate: m, tokens, now } = ctx;
  const recorded = new Set(
    [...ctx.audit.ofKind("swap_queued"), ...ctx.audit.ofKind("withdraw_queued")].map((e) => String(e.data.correlationId)),
  );
  const stable = tokens.find((t) => t.asset_id === m.stableAsset);
  const sleeves: BooksSleeve[] = [];

  for (const s of ctx.sleeves) {
    const reported = await api.getAgentBalances(s.agentId);
    const ops = await api.listOperations(s.agentId);

    const expected = new Map<string, bigint>([[m.stableAsset, BigInt(s.stakeAtomic)]]);
    const add = (asset: string, delta: bigint) => expected.set(asset, (expected.get(asset) ?? 0n) + delta);
    let withdrawn = 0n;
    for (const op of ops) {
      if (op.status !== "SUCCESS") continue;
      const amount = BigInt(op.request.amount);
      if (op.swap) {
        add(op.swap.request.origin_asset, -amount);
        add(op.swap.request.destination_asset, BigInt(op.swap.amountOut ?? "0"));
      } else {
        add(op.request.asset, -amount);
        if (op.request.asset === m.stableAsset) withdrawn += amount;
      }
    }

    const unexplained: Record<string, string> = {};
    for (const asset of new Set([...Object.keys(reported), ...expected.keys()])) {
      const diff = BigInt(reported[asset] ?? "0") - (expected.get(asset) ?? 0n);
      if (diff !== 0n) unexplained[asset] = diff.toString();
    }

    let equity: bigint | null = null;
    let withdrawnMicro: bigint | null = null;
    try {
      equity = portfolioValueMicroUsd(reported, tokens, now);
      withdrawnMicro = atomicToMicroUsd(withdrawn, stable, m.stableAsset, now);
    } catch (e) {
      if (!(e instanceof PriceUnavailableError)) throw e;
    }

    sleeves.push({
      id: s.id,
      name: s.name,
      fundedUsd: microToUsdString(BigInt(s.stakeMicroUsd)),
      withdrawnToSafeUsd: withdrawnMicro === null ? "unknown" : microToUsdString(withdrawnMicro),
      equityUsd: equity === null ? null : microToUsdString(equity),
      pnlUsd: equity === null || withdrawnMicro === null ? null : microToUsdString(equity + withdrawnMicro - BigInt(s.stakeMicroUsd)),
      reportedBalances: reported,
      expectedBalances: strings(expected),
      unexplained,
      unrecordedOperations: ops.filter((o) => !recorded.has(o.correlation_id)).map((o) => o.correlation_id),
    });
  }

  let treasuryMicro = 0n;
  try {
    treasuryMicro = atomicToMicroUsd(ctx.treasuryStableAtomic, stable, m.stableAsset, now);
  } catch (e) {
    if (!(e instanceof PriceUnavailableError)) throw e;
  }
  return {
    at: now.toISOString(),
    treasuryStableUsd: microToUsdString(treasuryMicro),
    sleeves,
    reconciled: sleeves.every((s) => Object.keys(s.unexplained).length === 0 && s.unrecordedOperations.length === 0),
  };
}
