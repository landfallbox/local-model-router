import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigStore, writeConfigStore } from "../gui/electron/config-store.js";
import { getChatCompletionsUrl, getRouterBaseUrl } from "../src/router-urls.js";

const tempDirectory = mkdtempSync(join(tmpdir(), "local-router-config-test-"));
const configPath = join(tempDirectory, "config.json");
const baseConfig = {
  router: { apiKey: "test-token" },
  vendors: [],
};

try {
  writeFileSync(configPath, `${JSON.stringify(baseConfig)}\n`, "utf8");
  const initial = await readConfigStore(configPath);
  const saved = await writeConfigStore(configPath, {
    ...initial.config,
    router: { ...initial.config.router, port: 4100 },
  }, initial.revision);

  assert.equal(saved.config.router.port, 4100);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).router.port, 4100);
  await assert.rejects(
    () => writeConfigStore(configPath, initial.config, initial.revision),
    (error) => error.code === "CONFIG_CONFLICT",
  );

  assert.equal(getRouterBaseUrl({ router: { host: "::1", port: 4000 } }), "http://[::1]:4000");
  assert.equal(
    getChatCompletionsUrl({ router: { host: "127.0.0.1", port: 4000 } }),
    "http://127.0.0.1:4000/v1/chat/completions",
  );
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("config and URL tests passed");