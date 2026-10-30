import { body, handle, ok } from "@/lib/api/http";
import { GovernanceBody } from "@/lib/api/schemas";
import { runtime } from "@/lib/command-center/runtime";

/** Mock only: pass every proposal at once (a demo that should not wait on votes), or require real votes. */
export const POST = handle(async (req: Request) => {
  const w = await runtime();
  const { autoApprove } = await body(req, GovernanceBody);
  w.governance.setAutoApprove(autoApprove);
  return ok({ council: w.governance.council() });
});
