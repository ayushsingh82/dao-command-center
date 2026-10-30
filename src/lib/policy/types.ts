/** Structural subset of the Agent API types (matches @near-intents-agent-api/sdk). Ported from House Money. */

export type Destination = {
  action: "withdraw" | "transfer";
  chain: string;
  address: string;
  memo: string | null;
};

export type Policy = {
  frozen: boolean;
  actions: Array<"swap" | "transfer" | "withdraw">;
  confidential: boolean;
  owner_approval: boolean;
  assets: "any" | string[];
  limits: { per_transaction?: Record<string, string> };
  max_actions_per_hour: number | null;
  destinations: { mode: "only" | "except"; list: Destination[] };
  budget: { daily_usd: string | null; weekly_usd: string | null; monthly_usd: string | null };
  timelock_ms: number;
};

export type TokenInfo = {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number | null;
  price_updated_at: string;
  price_expires_at: string;
};

/** Atomic-unit balances keyed by asset id. */
export type Balances = Record<string, string>;

export type WithdrawRequest = {
  asset: string;
  amount: string;
  chain: string;
  recipient: string;
  memo?: string | null;
};
