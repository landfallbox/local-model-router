import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { getVendorCircuitSummary } from "../gui/src/app-model.js";
import { normalizeVendorModelsForDraft, toConfig, toDraft } from "../gui/src/config-draft.js";

const config = normalizeConfig({
  router: {
    apiKey: "test-token",
    maxBodyBytes: 1572864,
  },
  vendors: [{
    name: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "legacy-model",
    authentication: "none",
  }],
});

const draft = toDraft(config);
const roundTrip = toConfig(draft);

assert.equal(draft.router.maxBodyMb, "1.5");
assert.equal(roundTrip.router.maxBodyBytes, 1572864);
assert.deepEqual(roundTrip.vendors[0].models, [{ id: "legacy-model", enabled: true }]);
assert.equal(roundTrip.vendors[0].model, undefined);
assert.equal(draft.vendors[0].requestFormat, "chat-completions");
assert.equal(roundTrip.vendors[0].requestFormat, "chat-completions");

const responsesRoundTrip = toConfig(toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "responses",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "model-id", enabled: true }],
    requestFormat: "responses",
    responsesPath: "/custom/responses",
  }],
})));
assert.equal(responsesRoundTrip.vendors[0].requestFormat, "responses");
assert.equal(responsesRoundTrip.vendors[0].responsesPath, "/custom/responses");

const pricingRoundTrip = toConfig(toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "custom-priced",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{
      id: "private-model",
      enabled: true,
      pricing: {
        mode: "custom",
        currency: "cny",
        inputPerMillion: 1.25,
        cachedInputPerMillion: null,
        outputPerMillion: 6,
      },
    }],
  }],
})));
assert.deepEqual(pricingRoundTrip.vendors[0].models[0].pricing, {
  mode: "custom",
  currency: "CNY",
  inputPerMillion: 1.25,
  cachedInputPerMillion: null,
  outputPerMillion: 6,
});
assert.equal(normalizeVendorModelsForDraft({
  models: [{ id: "gpt-5-mini", pricingMode: "custom" }],
})[0].pricingMode, "custom");
const switchedToOpenAI = normalizeVendorModelsForDraft({
  models: [{
    id: "private-model",
    pricingMode: "openai",
    inputPerMillion: "",
    pricing: { mode: "custom", currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
  }],
})[0];
assert.equal(switchedToOpenAI.pricingMode, "openai");
assert.equal(switchedToOpenAI.inputPerMillion, "");
assert.deepEqual(getVendorCircuitSummary({ models: [
  { id: "model-a", circuit: { state: "closed" } },
  { id: "model-b", circuit: { state: "open" } },
] }), { tone: "danger", label: "Circuit open · model-b" });
assert.deepEqual(getVendorCircuitSummary({ models: [
  { id: "model-a", circuit: { state: "half-open" } },
] }), { tone: "warning", label: "Recovering · model-a" });
assert.equal(getVendorCircuitSummary({ models: [] }), null);

console.log("config draft tests passed");