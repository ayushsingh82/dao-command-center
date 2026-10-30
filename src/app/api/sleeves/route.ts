import { body, handle, ok } from "@/lib/api/http";
import { OpenSleeveBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

export const GET = handle(async () => {
  const cc = await center();
  return ok({ sleeves: (await cc.snapshot()).sleeves });
});

/** Propose a new sleeve. The mandate is checked now and again when the vote passes. */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { by, ...input } = await body(req, OpenSleeveBody);
  return ok({ proposal: await cc.openSleeve(input, by) }, 202);
});
