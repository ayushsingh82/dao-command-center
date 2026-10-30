import { body, handle, ok } from "@/lib/api/http";
import { ResetBody } from "@/lib/api/schemas";
import { resetRuntime } from "@/lib/command-center/runtime";

/** Mock only: throw everything away and start again. */
export const POST = handle(async (req: Request) => {
  const text = await req.text();
  const opts = ResetBody.parse(text.trim() ? JSON.parse(text) : undefined);
  const w = await resetRuntime({
    treasuryUsdc: opts.treasuryUsdc === undefined ? undefined : BigInt(opts.treasuryUsdc),
    autoApprove: opts.autoApprove,
    mandate: opts.mandate,
  });
  void body;
  return ok(await w.cc.snapshot());
});
