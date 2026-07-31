import assert from "node:assert/strict";
import { VendorCircuitBreaker } from "../src/vendor-circuit-breaker.js";

let now = Date.parse("2026-01-01T00:00:00.000Z");
const breaker = new VendorCircuitBreaker({
  failureThreshold: 2,
  baseEjectionMs: 100,
  maxEjectionMs: 300,
  now: () => now,
});
const primary = { name: "primary", baseUrl: "https://primary.example/v1" };
const fallback = { name: "fallback", baseUrl: "https://fallback.example/v1" };

function fail(vendor, modelId = "model-id", options = {}) {
  const permission = breaker.acquire(vendor, modelId, options);
  assert.ok(permission);
  return breaker.recordFailure(permission);
}

assert.deepEqual(
  breaker.candidates([primary, fallback], "model-id").map(({ vendor }) => vendor.name),
  ["primary", "fallback"],
);
assert.equal(fail(primary).opened, false);
assert.deepEqual(fail(primary), {
  opened: true,
  durationMs: 100,
  ejectionCount: 1,
  retryAt: "2026-01-01T00:00:00.100Z",
});
assert.equal(breaker.snapshot(primary, "model-id").state, "open");
assert.deepEqual(
  breaker.candidates([primary, fallback], "model-id").map(({ vendor }) => vendor.name),
  ["fallback"],
);
assert.equal(breaker.snapshot(primary, "other-model").state, "closed");

now += 100;
const halfOpenCandidates = breaker.candidates([primary, fallback], "model-id");
assert.deepEqual(halfOpenCandidates.map(({ vendor }) => vendor.name), ["primary", "fallback"]);
const probe = breaker.acquire(primary, "model-id");
assert.ok(probe?.probe);
assert.equal(breaker.acquire(primary, "model-id"), null);
assert.deepEqual(breaker.recordFailure(probe), {
  opened: true,
  durationMs: 200,
  ejectionCount: 2,
  retryAt: "2026-01-01T00:00:00.300Z",
});

fail(fallback);
fail(fallback);
const forcedCandidates = breaker.candidates([primary, fallback], "model-id");
assert.equal(forcedCandidates.length, 1);
assert.equal(forcedCandidates[0].vendor, fallback);
assert.equal(forcedCandidates[0].forced, true);
const forcedProbe = breaker.acquire(fallback, "model-id", { forced: true });
assert.ok(forcedProbe?.probe);
assert.deepEqual(breaker.candidates([primary, fallback], "model-id"), []);
breaker.release(forcedProbe);

now += 200;
const recoveryProbe = breaker.acquire(primary, "model-id");
assert.ok(recoveryProbe?.probe);
assert.deepEqual(breaker.recordSuccess(recoveryProbe), { closed: true, ejectionCount: 1 });
assert.deepEqual(breaker.snapshot(primary, "model-id"), {
  state: "closed",
  consecutiveFailures: 0,
  ejectionCount: 1,
  retryAt: "",
  probeInFlight: false,
});

console.log("vendor circuit breaker tests passed");