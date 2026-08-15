import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ipcContractChannels, parseIpcRequest, parseIpcResponse } from "../gui/electron/ipc-contracts.js";

const health = {
  ok: true,
  status: 200,
  url: "http://127.0.0.1:4000/health",
  body: { ok: true },
  text: "{\"ok\":true}",
  processCount: 0,
};

assert.deepEqual(parseIpcRequest("router:start", []), []);
assert.deepEqual(
  parseIpcRequest("logs:read", [{ limit: 80, before: 1024 }]),
  [{ limit: 80, before: 1024 }],
);
assert.deepEqual(
  parseIpcRequest("usage:summary", [{ vendor: "vendor-a", model: "gpt-5-mini" }]),
  [{ vendor: "vendor-a", model: "gpt-5-mini" }],
);
assert.equal(parseIpcResponse("router:start", { started: true, via: "process", pid: 1234, health }).health.ok, true);

assert.throws(
  () => parseIpcRequest("logs:read", [{ limit: "80" }]),
  /Invalid IPC request for logs:read: 0\.limit/,
);
assert.throws(
  () => parseIpcRequest("usage:summary", [{ vendor: 42 }]),
  /Invalid IPC request for usage:summary: 0\.vendor/,
);
assert.throws(
  () => parseIpcResponse("router:start", { started: true, health: { ...health, processCount: "0" } }),
  /Invalid IPC response for router:start: health\.processCount/,
);
assert.throws(
  () => parseIpcRequest("unknown:channel", []),
  /Missing IPC request contract for unknown:channel/,
);

const mainSource = readFileSync(new URL("../gui/electron/main.js", import.meta.url), "utf8");
const registeredChannels = [...mainSource.matchAll(/registerIpcHandler\("([^"]+)"/g)].map((match) => match[1]).sort();
assert.deepEqual([...ipcContractChannels].sort(), registeredChannels);

console.log("IPC contract tests passed");