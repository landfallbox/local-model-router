export const DEFAULT_CIRCUIT_BREAKER_OPTIONS = Object.freeze({
  failureThreshold: 2,
  baseEjectionMs: 10_000,
  maxEjectionMs: 60_000,
});

export class VendorCircuitBreaker {
  constructor(options = {}) {
    this.options = {
      ...DEFAULT_CIRCUIT_BREAKER_OPTIONS,
      ...options,
    };
    this.now = options.now || Date.now;
    this.states = new Map();
  }

  candidates(vendors, modelId) {
    const now = this.now();
    const available = vendors
      .filter((vendor) => this.#isAvailable(vendor, modelId, now))
      .map((vendor) => ({ vendor, forced: false }));

    if (available.length) {
      return available;
    }

    const forced = vendors
      .map((vendor, index) => ({ vendor, index, state: this.#getState(vendor, modelId) }))
      .filter(({ state }) => state.openUntil > 0)
      .sort((left, right) => left.state.openUntil - right.state.openUntil || left.index - right.index)[0];

    return forced && !forced.state.probeInFlight ? [{ vendor: forced.vendor, forced: true }] : [];
  }

  acquire(vendor, modelId, { forced = false } = {}) {
    const state = this.#getState(vendor, modelId);
    const now = this.now();

    if (state.openUntil === 0) {
      return { key: this.#key(vendor, modelId), probe: false, forced: false };
    }
    if (state.probeInFlight || (state.openUntil > now && !forced)) {
      return null;
    }

    state.probeInFlight = true;
    return { key: this.#key(vendor, modelId), probe: true, forced };
  }

  recordFailure(permission) {
    const state = this.states.get(permission.key);
    if (!state) {
      return { opened: false };
    }

    state.probeInFlight = false;
    state.consecutiveFailures += 1;
    if (!permission.probe && state.consecutiveFailures < this.options.failureThreshold) {
      return { opened: false, consecutiveFailures: state.consecutiveFailures };
    }

    state.ejectionCount += 1;
    state.consecutiveFailures = 0;
    const durationMs = Math.min(
      this.options.baseEjectionMs * state.ejectionCount,
      this.options.maxEjectionMs,
    );
    state.openUntil = this.now() + durationMs;

    return {
      opened: true,
      durationMs,
      ejectionCount: state.ejectionCount,
      retryAt: new Date(state.openUntil).toISOString(),
    };
  }

  recordSuccess(permission) {
    const state = this.states.get(permission.key);
    if (!state) {
      return { closed: false };
    }

    const wasOpen = state.openUntil > 0;
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.probeInFlight = false;
    state.ejectionCount = Math.max(0, state.ejectionCount - 1);
    return { closed: wasOpen, ejectionCount: state.ejectionCount };
  }

  release(permission) {
    const state = this.states.get(permission.key);
    if (state && permission.probe) {
      state.probeInFlight = false;
    }
  }

  snapshot(vendor, modelId) {
    const state = this.#getState(vendor, modelId);
    const now = this.now();
    const status = state.openUntil === 0
      ? "closed"
      : state.openUntil > now
        ? "open"
        : "half-open";

    return {
      state: status,
      consecutiveFailures: state.consecutiveFailures,
      ejectionCount: state.ejectionCount,
      retryAt: status === "open" ? new Date(state.openUntil).toISOString() : "",
      probeInFlight: state.probeInFlight,
    };
  }

  #isAvailable(vendor, modelId, now) {
    const state = this.#getState(vendor, modelId);
    return state.openUntil === 0 || (state.openUntil <= now && !state.probeInFlight);
  }

  #getState(vendor, modelId) {
    const key = this.#key(vendor, modelId);
    let state = this.states.get(key);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        ejectionCount: 0,
        openUntil: 0,
        probeInFlight: false,
      };
      this.states.set(key, state);
    }
    return state;
  }

  #key(vendor, modelId) {
    return JSON.stringify([
      Number.isInteger(vendor?.priority) ? vendor.priority : null,
      String(vendor?.name || ""),
      String(vendor?.baseUrl || ""),
      String(modelId || ""),
    ]);
  }
}