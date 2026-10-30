import { body, handle, ok } from "@/lib/api/http";
import { VoteBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const cc = await center();
  const { id } = await params;
  const { member, vote } = await body(req, VoteBody);
  return ok({ proposal: await cc.vote(id, member, vote) });
});
