import type { TokenInfo } from "@/lib/policy/types";
import { MICRO } from "@/lib/risk/pricing";

/** 1234500000n with 6 decimals -> "1,234.50". */
export function fmtAtomic(amount: bigint, decimals: number, dp = 2): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, dp);
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${dp ? `.${frac.padEnd(dp, "0")}` : ""}`;
}

/** micro-USD -> "1,234.50". */
export function fmtUsd(micro: bigint, dp = 2): string {
  return fmtAtomic(micro, 6, dp);
}

/** "1,000.00 USDC", falling back to the raw id when the token is unknown. */
export function fmtAsset(amount: bigint, assetId: string, tokens: TokenInfo[], dp = 2): string {
  const t = tokens.find((x) => x.asset_id === assetId);
  return t ? `${fmtAtomic(amount, t.decimals, dp)} ${t.symbol}` : `${amount} ${assetId}`;
}

export const symbolOf = (assetId: string, tokens: TokenInfo[]) => tokens.find((t) => t.asset_id === assetId)?.symbol ?? assetId;

export { MICRO };
