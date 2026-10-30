import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

/** Our record against what the API reports, sleeve by sleeve. */
export const GET = handle(async () => {
  const cc = await center();
  return ok(await cc.books());
});
