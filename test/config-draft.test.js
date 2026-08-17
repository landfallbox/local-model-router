import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { getVendorCircuitSummary, suggestCatalogSwitch } from "../gui/src/app-model.js";
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
assert.equal(roundTrip.vendors[0].models[0].enableThinking, undefined);

const thinkingRoundTrip = toConfig(toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "local-vllm",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "model-id", enabled: true, enableThinking: true }],
  }],
})));
assert.equal(thinkingRoundTrip.vendors[0].models[0].enableThinking, true);

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

const deepseekRoundTrip = toConfig(toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: [{
      id: "deepseek-v4-flash",
      enabled: true,
      pricing: { mode: "deepseek" },
    }],
  }],
})));
assert.deepEqual(deepseekRoundTrip.vendors[0].models[0].pricing, { mode: "deepseek" });
const deepseekDraftModel = toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-flash", pricing: { mode: "deepseek" } }],
  }],
})).vendors[0].models[0];
assert.equal(deepseekDraftModel.pricingMode, "deepseek");
assert.equal(deepseekDraftModel.inputPerMillion, "");
const deepseekDraft = toDraft(normalizeConfig({
  router: { apiKey: "test-token" },
  vendors: [{
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-v4-pro", enabled: true }],
  }],
}));
deepseekDraft.vendors[0].models[0].pricingMode = "deepseek";
assert.deepEqual(toConfig(deepseekDraft).vendors[0].models[0].pricing, { mode: "deepseek" });
assert.deepEqual(getVendorCircuitSummary({ models: [
  { id: "model-a", circuit: { state: "closed" } },
  { id: "model-b", circuit: { state: "open" } },
] }), { tone: "danger", label: "Circuit open · model-b" });
assert.deepEqual(getVendorCircuitSummary({ models: [
  { id: "model-a", circuit: { state: "half-open" } },
] }), { tone: "warning", label: "Recovering · model-a" });
assert.equal(getVendorCircuitSummary({ models: [] }), null);

assert.equal(suggestCatalogSwitch("openai", "deepseek-v4-flash"), "deepseek");
assert.equal(suggestCatalogSwitch("openai", "deepseek-chat"), null);
assert.equal(suggestCatalogSwitch("deepseek", "gpt-5-mini"), "openai");
assert.equal(suggestCatalogSwitch("openai", "gpt-5-mini"), null);
assert.equal(suggestCatalogSwitch("deepseek", "deepseek-v4-pro"), null);
assert.equal(suggestCatalogSwitch("openai", "private-model"), null);
assert.equal(suggestCatalogSwitch("custom", "deepseek-v4-flash"), null);
assert.equal(suggestCatalogSwitch("openai", ""), null);

console.log("config draft tests passed");