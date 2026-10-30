export type RunnerState = {
  /**
   * Latched the first time equity reaches the trigger. From then on the stake is owed to the safe
   * account even if equity dips again (a timelocked swap that raises the cash can take minutes to fill).
   */
  triggered?: boolean;
  /** True once the stake withdrawal was accepted by the API. Reset only by an explicit retry. */
  banked: boolean;
  withdrawalId?: string;
  bankedAt?: string;
  /** True once the withdrawal's settlement was reported (settled, failed or cancelled). */
  settledReported?: boolean;
  /** True once the exit actually settled (not failed or cancelled). */
  exitSettled?: boolean;
  /** Which exit attempt this is. 0 for the first; a DAO retry after a veto increments it. */
  attempt?: number;
};

export interface StateStore {
  load(): Promise<RunnerState>;
  save(state: RunnerState): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  constructor(private state: RunnerState = { banked: false }) {}
  async load() {
    return { ...this.state };
  }
  async save(state: RunnerState) {
    this.state = { ...state };
  }
}
