import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

/** Everything a screen needs in one read: mandate, treasury, sleeves, approvals, proposals, prices, recent events. */
export const GET = handle(async () => {
  const cc = await center();
  return ok(await cc.snapshot());
});
