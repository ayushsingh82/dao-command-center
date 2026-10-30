import { body, handle, ok } from "@/lib/api/http";
import { KillBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/** Freeze everything now. No vote: a panic button cannot wait. Lifting it is a vote (`/api/resume`). */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { by, reason } = await body(req, KillBody);
  return ok(await cc.killSwitch(by, reason));
});
