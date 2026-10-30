import { handle, ok } from "@/lib/api/http";
import { center } from "@/lib/command-center/runtime";

/** The audit trail. `?after=<seq>` returns only newer entries; `?limit=<n>` keeps the last n. */
export const GET = handle(async (req: Request) => {
  const cc = await center();
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) || undefined : undefined;
  return ok({ events: cc.events(after, limit) });
});
