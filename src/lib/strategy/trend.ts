import type { Strategy, Target } from "@/lib/strategy/strategy";

/**
 * Trend following on one risk asset against the stable asset: hold the risk asset while its price is
 * above its moving average, hold the stable asset while it is below. Pure; no I/O. Ported from House Money.
 */
export type TrendConfig = {
  /** EMA smoothing, 0 < alpha <= 1. Higher reacts faster. */
  alpha?: number;
  /** Dead band around the EMA, so noise does not flip the position. */
  band?: number;
};

export class TrendStrategy implements Strategy {
  private ema: number | null = null;
  private target: Target = "stable";
  private readonly alpha: number;
  private readonly band: number;

  constructor(cfg: TrendConfig = {}) {
    this.alpha = cfg.alpha ?? 0.3;
    this.band = cfg.band ?? 0.01;
  }

  /** Feed one price. Returns the position the strategy wants to hold now. */
  update(price: number): Target {
    if (!(price > 0)) return this.target; // never move on a bad price
    this.ema = this.ema === null ? price : this.ema + this.alpha * (price - this.ema);
    if (price > this.ema * (1 + this.band)) this.target = "risk";
    else if (price < this.ema * (1 - this.band)) this.target = "stable";
    return this.target;
  }

  get average() {
    return this.ema;
  }
}
