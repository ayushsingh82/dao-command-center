import { PriceUnavailableError } from "@/lib/errors";
import type { Balances, TokenInfo } from "@/lib/policy/types";

/** USD amounts are carried as micro-USD (1e-6) bigints to avoid float drift. */
export const MICRO = 1_000_000n;

export function usdToMicro(usd: number | string): bigint {
  const [whole = "0", frac = ""] = (typeof usd === "number" ? usd.toFixed(6) : usd).split(".");
  return BigInt(whole) * MICRO + BigInt((frac + "000000").slice(0, 6));
}

/** micro-USD as a plain decimal string, e.g. 1234500000n -> "1234.5". */
export function microToUsdString(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** The token's price, or a PriceUnavailableError if it is missing or past its expiry. */
export function requirePrice(token: TokenInfo | undefined, assetId: string, now: Date): number {
  if (!token || token.price === null) throw new PriceUnavailableError(assetId, "missing");
  if (Date.parse(token.price_expires_at) <= now.getTime()) throw new PriceUnavailableError(assetId, "stale");
  return token.price;
}

/** Value of `amount` atomic units of `token`, in micro-USD. Fails closed on a missing or stale price. */
export function atomicToMicroUsd(amount: bigint, token: TokenInfo | undefined, assetId: string, now: Date): bigint {
  const price = requirePrice(token, assetId, now);
  return (amount * usdToMicro(price)) / 10n ** BigInt(token!.decimals);
}

/** How many atomic units of `token` are worth `micro` micro-USD. Fails closed on a missing or stale price. */
export function microUsdToAtomic(micro: bigint, token: TokenInfo | undefined, assetId: string, now: Date): bigint {
  const price = requirePrice(token, assetId, now);
  return (micro * 10n ** BigInt(token!.decimals)) / usdToMicro(price);
}

/**
 * Portfolio value in micro-USD. Fails closed: any non-zero balance whose price is
 * missing or past `price_expires_at` throws, so a trigger never fires on unpriced equity.
 */
export function portfolioValueMicroUsd(balances: Balances, tokens: TokenInfo[], now: Date = new Date()): bigint {
  const byId = new Map(tokens.map((t) => [t.asset_id, t]));
  let total = 0n;
  for (const [assetId, raw] of Object.entries(balances)) {
    const amount = BigInt(raw);
    if (amount === 0n) continue;
    total += atomicToMicroUsd(amount, byId.get(assetId), assetId, now);
  }
  return total;
}
