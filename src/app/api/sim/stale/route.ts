import { body, handle, ok } from "@/lib/api/http";
import { StaleBody } from "@/lib/api/schemas";
import { runtime } from "@/lib/command-center/runtime";

/** Mock only: simulate a price-feed outage for one asset. */
export const POST = handle(async (req: Request) => {
  const w = await runtime();
  const { assetId, stale } = await body(req, StaleBody);
  w.market.setStale(assetId, stale);
  return ok({ assetId, stale });
});
