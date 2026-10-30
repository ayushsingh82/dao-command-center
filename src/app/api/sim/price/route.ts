import { body, handle, ok } from "@/lib/api/http";
import { PriceBody } from "@/lib/api/schemas";
import { runtime } from "@/lib/command-center/runtime";

/** Mock only: set an asset's price. */
export const POST = handle(async (req: Request) => {
  const w = await runtime();
  const { assetId, price } = await body(req, PriceBody);
  w.market.setPrice(assetId, price);
  return ok({ assetId, price });
});
