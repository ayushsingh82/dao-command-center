import { body, handle, ok } from "@/lib/api/http";
import { AdvanceBody } from "@/lib/api/schemas";
import { runtime } from "@/lib/command-center/runtime";

/** Mock only: move simulated time forward, releasing anything whose delay is up. */
export const POST = handle(async (req: Request) => {
  const w = await runtime();
  const { ms } = await body(req, AdvanceBody);
  w.api.advance(ms);
  return ok({ now: w.clock.date().toISOString() });
});
