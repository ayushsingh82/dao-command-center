/** Mirrors the stable `code` field of the real SDK's AgentApiError. */
export class AgentApiError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly status = 403,
  ) {
    super(message ?? code);
    this.name = "AgentApiError";
  }
}

/** A price is missing or past its expiry. Nothing may act on an unpriced value. */
export class PriceUnavailableError extends Error {
  readonly code = "spend_price_unavailable";
  constructor(
    public readonly assetId: string,
    reason: "missing" | "stale",
  ) {
    super(`price ${reason} for ${assetId}`);
    this.name = "PriceUnavailableError";
  }
}

/** The mandate itself is invalid. `problems` lists every failed rule. */
export class MandateError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid mandate: ${problems.join("; ")}`);
    this.name = "MandateError";
  }
}

/** The request would break the DAO's mandate (for example it overfills the risk bucket). */
export class MandateViolationError extends Error {
  constructor(
    public readonly code:
      | "stake_exceeds_sleeve_cap"
      | "risk_bucket_exceeded"
      | "runway_floor_breached"
      | "asset_not_allowed"
      | "mandate_not_set",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "MandateViolationError";
  }
}

/** A governance rule was broken (not a member, already voted, unknown proposal). */
export class GovernanceError extends Error {
  constructor(
    public readonly code:
      | "not_a_member"
      | "already_voted"
      | "unknown_proposal"
      | "not_pending"
      /** The caller may not file this kind of proposal on the DAO. */
      | "not_allowed"
      /** On a real DAO a member votes from their own wallet; this backend holds no keys for them. */
      | "external_vote"
      /** The chain could not be read or written, so nothing is known about the proposal. */
      | "chain_unavailable",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "GovernanceError";
  }
}

/** Something the caller asked for does not exist or is not in a state that allows it. */
export class CommandCenterError extends Error {
  constructor(
    public readonly code:
      | "unknown_sleeve"
      | "unknown_approval"
      | "unknown_proposal"
      | "not_pending"
      | "killed"
      | "not_killed"
      | "bad_request"
      /** A simulation control was asked for on a live server. */
      | "mock_only",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CommandCenterError";
  }
}
