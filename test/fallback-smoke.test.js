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
    stdio: ["ignore", "pipe", "pipe"],
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

async function waitForProcessClose(router, timeoutMs = 5000) {
  let timeout;

  try {
    return await Promise.race([
      once(router, "close"),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Router did not fail fast."));
        }, timeoutMs);
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
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw lastError || new Error("Router did not become healthy.");
}

async function requestChat(port, token = "test-token") {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "model-id",
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
    await readBody(req);
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
      { name: "vendor-a", baseUrl: vendorA.baseUrl, apiKey: "a-key", model: "vendor-a-model" },
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

await testStatusFallback();
await testTimeoutFallback();
await testNonFallbackStatus();
await testRouterAuth();
await testHealthRequiresAuth();
await testHealthRedactsVendorBaseUrl();
await testMissingRouterApiKeyFailsFast();
await testUpstreamErrorLogRedaction();
await testNoVendorsFailsFast();

console.log("fallback smoke tests passed");
