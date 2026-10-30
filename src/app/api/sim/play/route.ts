import { body, handle, ok } from "@/lib/api/http";
import { PlayBody } from "@/lib/api/schemas";
import { runtime } from "@/lib/command-center/runtime";

/** Mock only: walk a price path, one price per step, ticking after each. Returns the state at the end. */
export const POST = handle(async (req: Request) => {
  const w = await runtime();
  const { assetId, prices, stepMs } = await body(req, PlayBody);
  let ticks = 0;
  for (const price of prices) {
    w.market.setPrice(assetId, price);
    w.api.advance(stepMs);
    await w.cc.tick();
    ticks++;
  }
  return ok({ ticks, snapshot: await w.cc.snapshot() });
});
