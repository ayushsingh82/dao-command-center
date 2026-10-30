import { MockAgentApi, MockClock } from "@/lib/agent-api/mock";
import { MockMarket } from "@/lib/agent-api/market";
import { exampleMandate, RISK, SIM_ASSETS, STABLE } from "@/lib/mandate/example";
import type { Mandate } from "@/lib/mandate/mandate";
import { buildSleevePolicy } from "@/lib/mandate/policies";
import type { Policy } from "@/lib/policy/types";

export const AGENT = "agent-sleeve-1";
export const USDC = 1_000_000n; // one USDC in atomic units (6 decimals)

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** One funded sleeve agent on the mock, with a price feed and a live grant. For tests. */
export async function makeWorld(
  opts: { mandate?: Partial<Mandate>; stakeUsdc?: bigint; policy?: (p: Policy) => Policy; hold?: boolean } = {},
) {
  const clock = new MockClock(Date.parse("2026-11-01T00:00:00Z"));
  const api = new MockAgentApi([], clock);
  const market = new MockMarket(() => api.clock.date(), SIM_ASSETS);
  api.useMarket(market);
  const mandate = exampleMandate(opts.mandate);
  const stake = (opts.stakeUsdc ?? 1_000n) * USDC;
  const base = buildSleevePolicy(mandate, { stakeAtomic: stake, riskAsset: RISK, riskCapAtomic: 10n ** 30n, hold: opts.hold });
  api.createAgent(AGENT, { [STABLE]: stake }, opts.policy ? opts.policy(base) : base);
  const { token } = await api.issueGrant(AGENT, "test", new Date(clock.now() + 90 * 86_400_000));
  return { api, market, mandate, stake, token, grant: api.forGrant(token), agentId: AGENT, policy: base };
}
