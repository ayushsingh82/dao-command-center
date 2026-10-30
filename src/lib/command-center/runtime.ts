import { createLiveCommandCenter, loadLiveCenterConfig } from "@/lib/command-center/live";
import { createMockCommandCenter, type MockCommandCenter, type MockOptions } from "@/lib/command-center/mock";
import type { CommandCenter } from "@/lib/command-center/service";
import { CommandCenterError } from "@/lib/errors";

/**
 * One command center for the whole server process, on the mock. Held on `globalThis` so Next's development
 * reloads do not create a second one. State lives in memory: restarting the server starts again.
 * A live deployment replaces this with a command center built on the real Agent API and Sputnik DAO.
 */
const KEY = Symbol.for("dao-command-center.runtime");
const LIVE_KEY = Symbol.for("dao-command-center.live");
type Holder = typeof globalThis & { [KEY]?: Promise<MockCommandCenter>; [LIVE_KEY]?: Promise<CommandCenter> };

const isLive = () => process.env.COMMAND_CENTER_MODE === "live";

/** The mock command center with its simulation controls. In live mode there are none, and this says so. */
export function runtime(): Promise<MockCommandCenter> {
  if (isLive()) return Promise.reject(new CommandCenterError("mock_only", "simulation controls exist only on the mock; this server is in live mode"));
  const g = globalThis as Holder;
  g[KEY] ??= createMockCommandCenter();
  return g[KEY];
}

/**
 * The command center the routes use: the mock by default, or, with `COMMAND_CENTER_MODE=live`, one on a real DAO
 * and the real Agent API. Live mode refuses to start unless every setting is present, and spends real funds.
 * A failed start is not remembered, so fixing the settings and asking again works.
 */
export async function center(): Promise<CommandCenter> {
  if (!isLive()) return (await runtime()).cc;
  const g = globalThis as Holder;
  g[LIVE_KEY] ??= createLiveCommandCenter(loadLiveCenterConfig(process.env)).catch((e) => {
    g[LIVE_KEY] = undefined;
    throw e;
  });
  return g[LIVE_KEY];
}

/** Throw the current state away and start over (mock only). */
export function resetRuntime(opts: MockOptions = {}): Promise<MockCommandCenter> {
  const g = globalThis as Holder;
  g[KEY] = createMockCommandCenter(opts);
  return g[KEY];
}
