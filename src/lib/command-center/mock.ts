import { MockAgentApi, MockClock } from "@/lib/agent-api/mock";
import { MockMarket } from "@/lib/agent-api/market";
import { CommandCenter } from "@/lib/command-center/service";
import { MockGovernance } from "@/lib/governance/mock";
import type { StateRepository } from "@/lib/persistence/repository";
import { exampleMandate, SIM_ASSETS } from "@/lib/mandate/example";
import type { Mandate } from "@/lib/mandate/mandate";

export const USDC = 1_000_000n;

export type MockOptions = {
  /** The DAO's stable balance to start with. Default 20,000. */
  treasuryUsdc?: bigint;
  /** The council. Default three members, two to pass. */
  members?: string[];
  threshold?: number;
  /** Pass every proposal on filing. Default true, so a demo does not wait on votes. */
  autoApprove?: boolean;
  /** The first mandate, passed at genesis. Pass `null` to start with none. */
  mandate?: Partial<Mandate> | null;
  /** Simulated start time. */
  startAt?: Date;
  approvalTtlMs?: number;
  /** Save the center's state here after every change. */
  repository?: StateRepository;
};

/**
 * A complete command center on the mock: a controllable clock and price feed, a council, and the mock Agent
 * API. Nothing here touches a network or spends anything. Used by tests, the headless simulation and the
 * development API routes.
 */
export async function createMockCommandCenter(opts: MockOptions = {}) {
  const clock = new MockClock((opts.startAt ?? new Date("2026-11-01T00:00:00Z")).getTime());
  const api = new MockAgentApi([], clock);
  const market = new MockMarket(() => clock.date(), SIM_ASSETS);
  api.useMarket(market);
  const governance = new MockGovernance({
    members: opts.members ?? ["alice.near", "bob.near", "carol.near"],
    threshold: opts.threshold ?? 2,
    autoApprove: opts.autoApprove ?? true,
    now: () => clock.date(),
  });
  const cc = new CommandCenter({
    api,
    governance,
    now: () => clock.date(),
    treasuryStableAtomic: (opts.treasuryUsdc ?? 20_000n) * USDC,
    approvalTtlMs: opts.approvalTtlMs,
    repository: opts.repository,
    sim: {
      advance: (ms) => api.advance(ms),
      setPrice: (assetId, price) => market.setPrice(assetId, price),
      setStale: (assetId, stale) => market.setStale(assetId, stale),
    },
  });

  if (opts.mandate !== null) {
    // The genesis mandate is the council's founding act: it passes at once, whatever the voting mode.
    const wanted = governance.council().autoApprove;
    governance.setAutoApprove(true);
    await cc.setMandate(exampleMandate(opts.mandate), "genesis");
    governance.setAutoApprove(wanted);
  }
  return { cc, api, market, governance, clock };
}

export type MockCommandCenter = Awaited<ReturnType<typeof createMockCommandCenter>>;
