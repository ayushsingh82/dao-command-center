import type { TokenInfo } from "@/lib/policy/types";

export type MarketAsset = { asset_id: string; symbol: string; decimals: number; blockchain: string; price: number };

/**
 * A controllable price feed for the mock. Every read returns fresh timestamps, unless an asset has been
 * marked stale or unpriced, so a test can prove nothing acts on a bad price.
 */
export class MockMarket {
  private assets = new Map<string, MarketAsset>();
  private stale = new Set<string>();
  private unpriced = new Set<string>();

  constructor(
    private now: () => Date,
    assets: MarketAsset[],
    private ttlMs = 600_000,
  ) {
    for (const a of assets) this.assets.set(a.asset_id, { ...a });
  }

  setPrice(assetId: string, price: number) {
    const a = this.assets.get(assetId);
    if (!a) throw new Error(`unknown asset ${assetId}`);
    a.price = price;
  }

  price(assetId: string) {
    return this.assets.get(assetId)?.price ?? null;
  }

  /** Simulate a feed outage for one asset: its price is expired / missing until cleared. */
  setStale(assetId: string, stale: boolean) {
    if (stale) this.stale.add(assetId);
    else this.stale.delete(assetId);
  }

  setUnpriced(assetId: string, unpriced: boolean) {
    if (unpriced) this.unpriced.add(assetId);
    else this.unpriced.delete(assetId);
  }

  tokens(): TokenInfo[] {
    const now = this.now();
    return [...this.assets.values()].map((a) => ({
      asset_id: a.asset_id,
      symbol: a.symbol,
      decimals: a.decimals,
      blockchain: a.blockchain,
      price: this.unpriced.has(a.asset_id) ? null : a.price,
      price_updated_at: now.toISOString(),
      price_expires_at: new Date(now.getTime() + (this.stale.has(a.asset_id) ? -1 : this.ttlMs)).toISOString(),
    }));
  }
}
