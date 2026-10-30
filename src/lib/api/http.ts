import { connection } from "next/server";
import type { z } from "zod";
import { LiveConfigError } from "@/lib/agent-api/live";
import { LiveConfigProblem } from "@/lib/command-center/live";
import { SputnikError } from "@/lib/dao/types";
import { AgentApiError, CommandCenterError, GovernanceError, MandateError, MandateViolationError } from "@/lib/errors";

export class BadRequest extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

export const ok = (data: unknown, status = 200) => Response.json(data, { status });

const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: { code, message, ...extra } }, { status });

/** Read and validate a JSON body. */
export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequest("the request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequest(
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** A body that may be empty. */
export async function optionalBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await req.text();
  if (!text.trim()) {
    // An empty body is fine when every field has a default; otherwise say what is missing.
    const empty = schema.safeParse(undefined);
    if (!empty.success) throw new BadRequest("the request needs a JSON body", empty.error.issues);
    return empty.data;
  }
  return body(new Request(req.url, { method: "POST", body: text }), schema);
}

/** Turn what the domain throws into a status code and a stable error shape. */
export function toResponse(e: unknown): Response {
  if (e instanceof BadRequest) return fail(400, "bad_request", e.message, { issues: e.issues });
  if (e instanceof MandateError) return fail(400, "invalid_mandate", e.message, { problems: e.problems });
  if (e instanceof MandateViolationError) return fail(422, e.code, e.message);
  if (e instanceof GovernanceError) {
    const status = e.code === "not_a_member" || e.code === "not_allowed" ? 403 : e.code === "unknown_proposal" ? 404 : e.code === "chain_unavailable" ? 502 : 409;
    return fail(status, e.code, e.message);
  }
  if (e instanceof CommandCenterError) {
    const status = e.code === "bad_request" ? 400 : e.code.startsWith("unknown_") || e.code === "mock_only" ? 404 : 409;
    return fail(status, e.code, e.message);
  }
  // Settings are named in the message, never their values.
  if (e instanceof LiveConfigProblem || e instanceof LiveConfigError) return fail(503, "not_configured", e.message);
  if (e instanceof SputnikError) return fail(502, "dao_error", e.message, { daoCode: e.code });
  if (e instanceof AgentApiError) return fail(e.code === "owner_signature_expired" ? 504 : 502, "agent_api_error", e.message, { agentApiCode: e.code });
  console.error("[api] unexpected error", e);
  return fail(500, "internal", e instanceof Error ? e.message : "unexpected error");
}

/**
 * Mark the handler as dynamic. This project has Cache Components on, so a GET handler that reads no request
 * data is prerendered once at build time, and `/api/state` would serve that frozen snapshot forever.
 * `connection()` makes it wait for a real request. Outside a running Next server (the unit tests call the
 * handlers directly) it throws a known error, which is the only thing swallowed here.
 */
async function requireRequest(): Promise<void> {
  try {
    await connection();
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("outside a request scope"))) throw e;
  }
}

/** Wrap a handler so it runs per request and every error becomes a clean JSON response. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      await requireRequest();
      return await fn(...args);
    } catch (e) {
      // While Next probes a route at build time, `connection()` ends the probe by rejecting. That belongs to
      // Next, which then renders the route per request; turning it into a 500 would only log noise.
      if (e instanceof Error && e.message.includes("During prerendering")) throw e;
      return toResponse(e);
    }
  };
}
