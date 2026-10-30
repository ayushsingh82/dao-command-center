import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/mandate/mandate";

export { canonicalJson };
export const sha256Hex = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
