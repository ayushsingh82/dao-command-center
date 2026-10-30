import { body, handle, ok } from "@/lib/api/http";
import { PreviewMandateBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/** What a mandate would change in each sleeve's policy. Changes nothing. For the page the DAO votes on. */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { mandate } = await body(req, PreviewMandateBody);
  return ok({ sleeves: await cc.previewMandate(mandate) });
});
