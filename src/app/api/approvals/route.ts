import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

/** The approvals queue. `?status=pending` keeps only items still waiting for the DAO. */
export const GET = handle(async (req: Request) => {
  const cc = await center();
  const status = new URL(req.url).searchParams.get("status");
  const all = (await cc.snapshot()).approvals;
  return ok({ approvals: status ? all.filter((a) => a.status === status) : all });
});
