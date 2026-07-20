import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";
import { toConfig, toDraft } from "../gui/src/config-draft.js";

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

console.log("config draft tests passed");