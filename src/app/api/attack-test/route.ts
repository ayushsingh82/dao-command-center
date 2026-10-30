import { handle, ok, optionalBody } from "@/lib/api/http";
import { AttackBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/** Try to break a sleeve (or all of them). Every probe must be refused. Mock only: live probes touch real accounts. */
export const POST = handle(async (req: Request) => {
  const cc = await center();
  const { sleeveId } = await optionalBody(req, AttackBody);
  return ok({ reports: await cc.attackTest(sleeveId) });
});
