/** Which asset a strategy wants to hold right now. */
export type Target = "risk" | "stable";

/** A strategy decides from prices alone. Pure: no I/O, so it is deterministic and easy to test. */
export interface Strategy {
  update(price: number): Target;
}

/** Buy the risk asset and keep it. Used for a sleeve that simply holds. */
export class HoldStrategy implements Strategy {
  private target: Target = "stable";

  update(price: number): Target {
    if (price > 0) this.target = "risk"; // never move on a bad price
    return this.target;
  }
}

/** The strategies a sleeve can be opened with. */
export type StrategySpec =
  | { kind: "trend"; alpha?: number; band?: number }
  | { kind: "hold" };
