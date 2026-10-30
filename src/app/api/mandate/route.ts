import { body, handle, ok } from "@/lib/api/http";
import { SetMandateBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

export const GET = handle(async () => {
  const cc = await center();
  const { mandate, mandateDigest } = await cc.snapshot();
  return ok({ mandate, digest: mandateDigest });
});

/** Propose a mandate. It takes effect when the DAO's vote passes; the response is the proposal. */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { mandate, by } = await body(req, SetMandateBody);
  return ok({ proposal: await cc.setMandate(mandate, by) }, 202);
});
