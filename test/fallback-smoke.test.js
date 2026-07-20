import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "local-router-test-"));
const projectRoot = new URL("..", import.meta.url);

async function createMockVendor(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function findFreePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

function writeConfig(name, config) {
  const configPath = join(tempDir, `${name}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function startRouter(configPath) {
  const router = spawn(process.execPath, ["src/server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ROUTER_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  router.stdout.setEncoding("utf8");
  router.stderr.setEncoding("utf8");
  return router;
}

async function stopRouter(router) {
  if (router.exitCode !== null) {
    return;
  }

  router.kill();
  await once(router, "exit");
}

async function waitForProcessClose(router, timeoutMs = 5000, context = "Router") {
  let timeout;

  try {
    return await Promise.race([
      once(router, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${context} did not exit in time (exitCode=${router.exitCode}, signalCode=${router.signalCode}).`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForProcessExit(router, timeoutMs = 5000, context = "Router") {
  if (router.exitCode !== null || router.signalCode !== null) {
    return [router.exitCode, router.signalCode];
  }

  let timeout;
  try {
    return await Promise.race([
      once(router, "exit"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${context} did not exit in time.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(port, token = "test-token") {
  const deadline = Date.now() + 5000;
  let lastError;
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error("Router did not become healthy.");
}

async function requestChat(port, token = "test-token", model = "model-id") {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

async function withRouter(name, config, test) {
  const configPath = writeConfig(name, config);
  const router = await startRouter(configPath);
  const port = config.router.port;

  try {
    await waitForHealth(port, config.router.apiKey);
    await test({ port, configPath, router });
  } finally {
    await stopRouter(router);
  }
}

function baseConfig(port, vendors, overrides = {}) {
  return {
    router: {
      host: "127.0.0.1",
      port,
      apiKey: "test-token",
      logFile: join(tempDir, `router-${port}.log`),
      requestTimeoutMs: 500,
      ...overrides.router,
    },
    model: {
      id: "model-id",
      name: "Model Name",
      ...overrides.model,
    },
    vendors,
  };
}

async function testStatusFallback() {
  const calls = { vendorA: 0, vendorB: 0 };
  const vendorA = await createMockVendor(async (req, res) => {
    calls.vendorA += 1;
    const body = JSON.parse(await readBody(req));
    assert.equal(body.model, "model-id");
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const vendorB = await createMockVendor(async (req, res) => {
    calls.vendorB += 1;
    const body = JSON.parse(await readBody(req));
    assert.equal(req.headers.authorization, undefined);
    assert.equal(body.model, "model-id");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok from vendor b" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("status-fallback", baseConfig(port, [
      { name: "vendor-a", baseUrl: vendorA.baseUrl, apiKey: "a-key", model: "model-id" },
      { name: "vendor-b", baseUrl: vendorB.baseUrl, model: "" },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-vendor"), "vendor-b");
      assert.equal(body.choices[0].message.content, "ok from vendor b");
      assert.equal(calls.vendorA, 1);
      assert.equal(calls.vendorB, 1);
    });
  } finally {
    vendorA.server.close();
    vendorB.server.close();
  }
}

async function testTimeoutFallback() {
  const calls = { slow: 0, fast: 0 };
  const slow = await createMockVendor(async (req, res) => {
    calls.slow += 1;
    await readBody(req);
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
  });
  const fast = await createMockVendor(async (req, res) => {
    calls.fast += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "fast" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("timeout-fallback", baseConfig(port, [
      { name: "slow", baseUrl: slow.baseUrl, model: "model-id" },
      { name: "fast", baseUrl: fast.baseUrl, model: "model-id" },
    ], { router: { requestTimeoutMs: 200 } }), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-router-vendor"), "fast");
      assert.equal(body.choices[0].message.content, "fast");
      assert.equal(calls.slow, 1);
      assert.equal(calls.fast, 1);
    });
  } finally {
    slow.server.close();
    fast.server.close();
  }
}

async function testLongStreamOutlivesResponseTimeout() {
  const chunks = ["data: one\n\n", "data: two\n\n", "data: three\n\n"];
  const vendor = await createMockVendor(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      res.write(chunk);
    }
    res.end();
  });

  try {
    const port = await findFreePort();
    await withRouter("long-stream", baseConfig(port, [
      { name: "streaming", baseUrl: vendor.baseUrl, model: "model-id" },
    ], { router: { requestTimeoutMs: 100 } }), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), chunks.join(""));
    });
  } finally {
    vendor.server.close();
  }
}

async function testNoFallbackAfterPartialStream() {
  const calls = { partial: 0, fallback: 0 };
  const partial = await createMockVendor(async (req, res) => {
    calls.partial += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    setTimeout(() => res.destroy(new Error("upstream stream failed")), 50);
  });
  const fallback = await createMockVendor(async (req, res) => {
    calls.fallback += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "must not run" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("partial-stream", baseConfig(port, [
      { name: "partial", baseUrl: partial.baseUrl, model: "model-id" },
      { name: "fallback", baseUrl: fallback.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(Buffer.from(first.value).toString("utf8"), "data: first\n\n");
      await assert.rejects(() => reader.read());
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(calls.partial, 1);
      assert.equal(calls.fallback, 0);
    });
  } finally {
    partial.server.close();
    fallback.server.close();
  }
}

async function testClientAbortStopsFallback() {
  const calls = { slow: 0, fallback: 0 };
  const slow = await createMockVendor(async (req, res) => {
    calls.slow += 1;
    await readBody(req);
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }
    }, 500);
  });
  const fallback = await createMockVendor(async (req, res) => {
    calls.fallback += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  try {
    const port = await findFreePort();
    await withRouter("client-abort", baseConfig(port, [
      { name: "slow", baseUrl: slow.baseUrl, model: "model-id" },
      { name: "fallback", baseUrl: fallback.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const controller = new AbortController();
      const request = fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "model-id", messages: [] }),
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(request, (error) => error.name === "AbortError");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(calls.slow, 1);
      assert.equal(calls.fallback, 0);
    });
  } finally {
    slow.server.close();
    fallback.server.close();
  }
}

async function testNonFallbackStatus() {
  const calls = { bad: 0, fallback: 0 };
  const bad = await createMockVendor(async (req, res) => {
    calls.bad += 1;
    await readBody(req);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad vendor key" } }));
  });
  const fallback = await createMockVendor(async (req, res) => {
    calls.fallback += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "should not happen" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("non-fallback", baseConfig(port, [
      { name: "bad", baseUrl: bad.baseUrl, model: "model-id" },
      { name: "fallback", baseUrl: fallback.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("x-router-vendor"), "bad");
      assert.equal(calls.bad, 1);
      assert.equal(calls.fallback, 0);
    });
  } finally {
    bad.server.close();
    fallback.server.close();
  }
}

async function testRouterAuth() {
  let calls = 0;
  const vendor = await createMockVendor(async (req, res) => {
    calls += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("router-auth", baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort, "wrong-token");
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.error.type, "authentication_error");
      assert.equal(calls, 0);
    });
  } finally {
    vendor.server.close();
  }
}

async function testVendorModelMapping() {
  const receivedModels = [];
  const vendor = await createMockVendor(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    receivedModels.push(body.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: body.model } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("vendor-model-mapping", baseConfig(port, [
      {
        name: "vendor",
        baseUrl: vendor.baseUrl,
        models: [
          { id: "model-id" },
          { id: "coder-model" },
        ],
      },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort, "test-token", "coder-model");
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.choices[0].message.content, "coder-model");
      assert.deepEqual(receivedModels, ["coder-model"]);

      const missing = await requestChat(routerPort, "test-token", "missing-model");
      const missingBody = await missing.json();
      assert.equal(missing.status, 404);
      assert.equal(missingBody.error.type, "model_not_found");
    });
  } finally {
    vendor.server.close();
  }
}

async function testLegacyVendorModelMigration() {
  const receivedModels = [];
  const vendor = await createMockVendor(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    receivedModels.push(body.model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: body.model } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("legacy-vendor-model", baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, model: "legacy-model" },
    ]), async ({ port: routerPort }) => {
      const response = await requestChat(routerPort, "test-token", "legacy-model");
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.choices[0].message.content, "legacy-model");
      assert.deepEqual(receivedModels, ["legacy-model"]);
    });
  } finally {
    vendor.server.close();
  }
}

async function testModelsEndpointListsVendorModels() {
  const vendor = await createMockVendor(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("models-endpoint", baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, models: [
        { id: "model-id" },
        { id: "coder-model" },
      ] },
    ]), async ({ port: routerPort }) => {
      const response = await fetch(`http://127.0.0.1:${routerPort}/v1/models`, {
        headers: { authorization: "Bearer test-token" },
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(body.data.map((model) => model.id), ["model-id", "coder-model"]);
    });
  } finally {
    vendor.server.close();
  }
}

async function testHealthRequiresAuth() {
  const vendor = await createMockVendor(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("health-auth", baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`);
      const body = await response.json();
      assert.equal(response.status, 401);
      assert.equal(body.error.type, "authentication_error");
    });
  } finally {
    vendor.server.close();
  }
}

async function testHealthRedactsVendorBaseUrl() {
  const vendor = await createMockVendor(async (req, res) => {
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });

  try {
    const port = await findFreePort();
    await withRouter("health-redaction", baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`, {
        headers: { authorization: "Bearer test-token" },
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.vendorCount, 1);
      assert.equal(body.vendors[0].baseUrl, undefined);
    });
  } finally {
    vendor.server.close();
  }
}

async function testMissingRouterApiKeyFailsFast() {
  const port = await findFreePort();
  const config = baseConfig(port, [
    { name: "vendor", baseUrl: "https://example.com/v1", model: "model-id" },
  ], { router: { apiKey: "" } });
  const configPath = writeConfig("missing-router-key", config);
  const router = await startRouter(configPath);
  const output = [];

  router.stdout.on("data", (chunk) => output.push(chunk));
  router.stderr.on("data", (chunk) => output.push(chunk));

  try {
    const [code] = await waitForProcessClose(router);
    assert.notEqual(code, 0);
    assert.match(output.join(""), /router\.apiKey/i);
  } finally {
    await stopRouter(router);
  }
}

async function testUpstreamErrorLogRedaction() {
  const secretPrompt = "user prompt that must not be written to logs";
  const vendor = await createMockVendor(async (req, res) => {
    await readBody(req);
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "rate_limit", message: secretPrompt } }));
  });

  try {
    const port = await findFreePort();
    const config = baseConfig(port, [
      { name: "vendor", baseUrl: vendor.baseUrl, model: "model-id" },
    ]);
    const logFile = config.router.logFile;
    await withRouter("log-redaction", config, async ({ port: routerPort }) => {
      const response = await requestChat(routerPort);
      assert.equal(response.status, 502);
    });

    const logText = readFileSync(logFile, "utf8");
    assert.match(logText, /"errorType":"rate_limit"/);
    assert.doesNotMatch(logText, /bodyPreview/);
    assert.doesNotMatch(logText, new RegExp(secretPrompt));
  } finally {
    vendor.server.close();
  }
}

async function testNoVendorsFailsFast() {
  const port = await findFreePort();
  const configPath = writeConfig("no-vendors", baseConfig(port, []));
  const router = await startRouter(configPath);
  const output = [];

  router.stdout.on("data", (chunk) => output.push(chunk));
  router.stderr.on("data", (chunk) => output.push(chunk));

  try {
    const [code] = await waitForProcessClose(router);
    assert.notEqual(code, 0);
    assert.match(output.join(""), /vendor|router/i);
  } finally {
    await stopRouter(router);
  }
}

async function testParentIpcStopsRouterGracefully() {
  const port = await findFreePort();
  const configPath = writeConfig("parent-ipc-shutdown", baseConfig(port, [{
    name: "primary",
    baseUrl: "http://127.0.0.1:1/v1",
    models: [{ id: "model-id", enabled: true }],
  }]));
  const router = await startRouter(configPath);

  try {
    await waitForHealth(port);
    router.send({ type: "shutdown" });
    const [code] = await waitForProcessExit(router, 5000, "Router after parent shutdown request");
    assert.equal(code, 0);
  } finally {
    await stopRouter(router);
  }
}

async function testParentDisconnectStopsRouter() {
  const port = await findFreePort();
  const configPath = writeConfig("parent-ipc-disconnect", baseConfig(port, [{
    name: "primary",
    baseUrl: "http://127.0.0.1:1/v1",
    models: [{ id: "model-id", enabled: true }],
  }]));
  const router = await startRouter(configPath);

  try {
    await waitForHealth(port);
    router.disconnect();
    const [code] = await waitForProcessExit(router, 5000, "Router after parent disconnect");
    assert.equal(code, 0);
  } finally {
    await stopRouter(router);
  }
}

await testStatusFallback();
await testTimeoutFallback();
await testLongStreamOutlivesResponseTimeout();
await testNoFallbackAfterPartialStream();
await testClientAbortStopsFallback();
await testNonFallbackStatus();
await testRouterAuth();
await testVendorModelMapping();
await testLegacyVendorModelMigration();
await testModelsEndpointListsVendorModels();
await testHealthRequiresAuth();
await testHealthRedactsVendorBaseUrl();
await testMissingRouterApiKeyFailsFast();
await testUpstreamErrorLogRedaction();
await testNoVendorsFailsFast();
await testParentIpcStopsRouterGracefully();
await testParentDisconnectStopsRouter();

console.log("fallback smoke tests passed");
