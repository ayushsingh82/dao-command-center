import { body, handle, ok } from "@/lib/api/http";
import { ResumeBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/** Propose lifting the kill switch. Sleeves come back on new grants once the vote passes. */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { by } = await body(req, ResumeBody);
  return ok({ proposal: await cc.resume(by) }, 202);
});
