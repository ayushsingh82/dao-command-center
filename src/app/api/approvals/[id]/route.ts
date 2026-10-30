import { body, handle, ok } from "@/lib/api/http";
import { DecideBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/**
 * A member's call on a queue item. It becomes a proposal and the member's vote is cast; the item changes
 * only once enough members agree.
 */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const cc = await center();
  const { id } = await params;
  const { decision, member } = await body(req, DecideBody);
  return ok(await cc.decide(decodeURIComponent(id), decision, member));
});
