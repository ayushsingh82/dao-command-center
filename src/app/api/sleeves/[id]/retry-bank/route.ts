import { body, handle, ok } from "@/lib/api/http";
import { RetryBankBody } from "@/lib/api/schemas";
import { center } from "@/lib/command-center/runtime";

/** Propose another attempt at a stake exit that was vetoed or failed. */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const cc = await center();
  const { id } = await params;
  const { by } = await body(req, RetryBankBody);
  return ok({ proposal: await cc.retryBank(id, by) }, 202);
});
