import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

/** Run one pass over every sleeve. Call it on a timer; each call is safe to repeat. */
export const POST = handle(async () => {
  const cc = await center();
  return ok(await cc.tick());
});
