import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

export const GET = handle(async () => {
  const cc = await center();
  return ok({ proposals: await cc.proposals(), council: (await cc.snapshot()).council });
});
