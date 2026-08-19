import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageSummary } from "../src/usage-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "local-router-test-"));
const projectRoot = new URL("..", import.meta.url);
const routerOutput = new WeakMap();
const MAX_ROUTER_OUTPUT_LENGTH = 64 * 1024;

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

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
      HEIMDALL_DATA_DIR: tempDir,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  router.stdout.setEncoding("utf8");
  router.stderr.setEncoding("utf8");
  const output = { text: "" };
  const captureOutput = (chunk) => {
    output.text = `${output.text}${chunk}`.slice(-MAX_ROUTER_OUTPUT_LENGTH);
  };
  router.stdout.on("data", captureOutput);
  router.stderr.on("data", captureOutput);
  routerOutput.set(router, output);
  return router;
}

function getRouterOutput(router) {
  return routerOutput.get(router)?.text || "";
}

async function stopRouter(router) {
  if (router.exitCode !== null) {
    return;
  }

  router.kill();
  await once(router, "exit");
}

async function reloadRouter(router, timeoutMs = 3000) {
  const requestId = `reload-${Date.now()}-${Math.random()}`;

  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      router.off("message", onMessage);
      router.off("exit", onExit);
      router.off("error", onError);
      router.off("disconnect", onDisconnect);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (message) => {
      if (message?.requestId !== requestId) {
        return;
      }
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => fail(new Error(
      `Router exited during config reload (code=${code}, signal=${signal}).\n${getRouterOutput(router)}`,
    ));
    const onError = (error) => fail(error);
    const onDisconnect = () => fail(new Error(
      `Router IPC disconnected during config reload.\n${getRouterOutput(router)}`,
    ));

    router.on("message", onMessage);
    router.once("exit", onExit);
    router.once("error", onError);
    router.once("disconnect", onDisconnect);
    timeout = setTimeout(() => fail(new Error(
      `Router config reload timed out.\n${getRouterOutput(router)}`,
    )), timeoutMs);

    if (!router.connected) {
      onDisconnect();
      return;
    }
    router.send({ type: "reload-config", requestId }, (error) => {
      if (error) {
        fail(error);
      }
    });
  });
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

async function waitForAuthorizedHealth(port, token, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await response.arrayBuffer();
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Router did not accept the reloaded token in time: ${token}`);
}

async function assertEndpointUnavailable(url) {
  try {
    const response = await fetch(url);
    await response.arrayBuffer();
  } catch {
    return;
  }
  assert.fail(`Expected endpoint to be unavailable: ${url}`);
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

async function requestResponses(port, token = "test-token", model = "model-id") {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: "hello" }),
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

async function testResponsesRoutingAndConversion() {
  const received = [];
  const vendor = await createMockVendor(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    received.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `resp-${received.length}`,
      object: "response",
      created_at: 10,
      model: body.model,
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "response answer" }],
      }],
    }));
  });

  try {
    const port = await findFreePort();
    const vendors = [{
      name: "responses-vendor",
      baseUrl: vendor.baseUrl,
      models: [{ id: "model-id", enabled: true }],
      requestFormat: "responses",
    }];
    await withRouter("responses-routing", baseConfig(port, vendors), async ({ port: routerPort }) => {
      const nativeResponse = await requestResponses(routerPort);
      assert.equal(nativeResponse.status, 200);
      assert.equal(nativeResponse.headers.get("x-router-vendor"), "responses-vendor");
      const nativeBody = await nativeResponse.json();
      assert.equal(nativeBody.object, "response");
      assert.equal(received[0].path, "/v1/responses");
      assert.equal(received[0].body.input, "hello");

      const convertedResponse = await requestChat(routerPort);
      assert.equal(convertedResponse.status, 200);
      const convertedBody = await convertedResponse.json();
      assert.equal(received[1].path, "/v1/responses");
      assert.deepEqual(received[1].body.input, [{ role: "user", content: "hello" }]);
      assert.equal(convertedBody.object, "chat.completion");
      assert.equal(convertedBody.choices[0].message.content, "response answer");
    });
  } finally {
    vendor.server.close();
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

async function testCircuitBreakerSkipsFailedVendorPerModel() {
  const calls = { primaryDefault: 0, primaryOther: 0, fallback: 0 };
  const primary = await createMockVendor(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.model === "other-model") {
      calls.primaryOther += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "primary other model" } }] }));
      return;
    }

    calls.primaryDefault += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "unavailable" } }));
  });
  const fallback = await createMockVendor(async (req, res) => {
    calls.fallback += 1;
    const body = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `fallback ${body.model}` } }] }));
  });

  try {
    const port = await findFreePort();
    const config = baseConfig(port, [
      {
        name: "primary",
        baseUrl: primary.baseUrl,
        models: [{ id: "model-id" }, { id: "other-model" }],
      },
      {
        name: "fallback",
        baseUrl: fallback.baseUrl,
        models: [{ id: "model-id" }, { id: "other-model" }],
      },
    ]);
    const logFile = config.router.logFile;

    await withRouter("circuit-breaker", config, async ({ port: routerPort }) => {
      for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
        const response = await requestChat(routerPort);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-router-vendor"), "fallback");
        await response.arrayBuffer();
      }

      const healthResponse = await fetch(`http://127.0.0.1:${routerPort}/health`, {
        headers: { authorization: "Bearer test-token" },
      });
      const health = await healthResponse.json();
      assert.equal(health.vendors[0].models[0].circuit.state, "open");
      assert.equal(health.vendors[0].models[0].circuit.ejectionCount, 1);
      assert.equal(health.vendors[0].models[1].circuit.state, "closed");

      const otherModelResponse = await requestChat(routerPort, "test-token", "other-model");
      assert.equal(otherModelResponse.status, 200);
      assert.equal(otherModelResponse.headers.get("x-router-vendor"), "primary");
      await otherModelResponse.arrayBuffer();
    });

    assert.equal(calls.primaryDefault, 2);
    assert.equal(calls.primaryOther, 1);
    assert.equal(calls.fallback, 3);
    const logText = readFileSync(logFile, "utf8");
    assert.match(logText, /"event":"vendor_circuit_opened"/);
    assert.match(logText, /"durationMs":10000/);
    assert.match(logText, /"ejectionCount":1/);
  } finally {
    primary.server.close();
    fallback.server.close();
  }
}

async function testRuntimeConfigReload() {
  const calls = { primary: 0, secondary: 0 };
  const primary = await createMockVendor(async (req, res) => {
    calls.primary += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "primary" } }] }));
  });
  const secondary = await createMockVendor(async (req, res) => {
    calls.secondary += 1;
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "secondary" } }] }));
  });

  try {
    const port = await findFreePort();
    const nextPort = await findFreePort();
    const initialConfig = baseConfig(port, [
      { name: "primary", baseUrl: primary.baseUrl, model: "model-id" },
      { name: "secondary", baseUrl: secondary.baseUrl, model: "model-id" },
    ]);

    await withRouter("runtime-reload", initialConfig, async ({ port: routerPort, configPath, router }) => {
      const initialResponse = await requestChat(routerPort);
      assert.equal(initialResponse.headers.get("x-router-vendor"), "primary");
      await initialResponse.arrayBuffer();

      const nextConfig = {
        ...initialConfig,
        router: {
          ...initialConfig.router,
          port: nextPort,
          apiKey: "reloaded-token",
        },
        vendors: [...initialConfig.vendors].reverse(),
      };
      writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
      const reloadResult = await reloadRouter(router);
      assert.equal(reloadResult.ok, true);
      assert.equal(reloadResult.restartRequired, true);
      assert.deepEqual(reloadResult.restartFields, ["router.port"]);

      const oldKeyResponse = await requestChat(routerPort);
      assert.equal(oldKeyResponse.status, 401);
      await oldKeyResponse.arrayBuffer();

      const reloadedResponse = await requestChat(routerPort, "reloaded-token");
      assert.equal(reloadedResponse.status, 200);
      assert.equal(reloadedResponse.headers.get("x-router-vendor"), "secondary");
      await reloadedResponse.arrayBuffer();

      const healthResponse = await fetch(`http://127.0.0.1:${routerPort}/health`, {
        headers: { authorization: "Bearer reloaded-token" },
      });
      const health = await healthResponse.json();
      assert.equal(health.restartRequired, true);
      assert.deepEqual(health.restartFields, ["router.port"]);
      await assertEndpointUnavailable(`http://127.0.0.1:${nextPort}/health`);

      const watchedConfig = {
        ...nextConfig,
        router: { ...nextConfig.router, apiKey: "watched-token" },
      };
      writeFileSync(configPath, JSON.stringify(watchedConfig, null, 2));
      await waitForAuthorizedHealth(routerPort, "watched-token");

      writeFileSync(configPath, "{ invalid json");
      await new Promise((resolve) => setTimeout(resolve, 350));
      const retainedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`, {
        headers: { authorization: "Bearer watched-token" },
      });
      assert.equal(retainedHealth.status, 200);
    });

    assert.equal(calls.primary, 1);
    assert.equal(calls.secondary, 1);
  } finally {
    primary.server.close();
    secondary.server.close();
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
      await waitFor(() => calls.slow === 1, "Request did not reach the slow vendor.");
      controller.abort();
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
      { name: "disabled", enabled: false, baseUrl: "", models: [] },
      { name: "vendor", baseUrl: vendor.baseUrl, model: "model-id" },
    ]), async ({ port: routerPort }) => {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`, {
        headers: { authorization: "Bearer test-token" },
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.vendorCount, 1);
      assert.equal(body.vendors[0].priority, 1);
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

  try {
    const [code] = await waitForProcessClose(router);
    assert.notEqual(code, 0);
    assert.match(getRouterOutput(router), /router\.apiKey/i);
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

async function testUsageCaptureForJsonAndSse() {
  const vendor = await createMockVendor(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "streamed" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 70, total_tokens: 150 } })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "regular" } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));
  });

  try {
    const port = await findFreePort();
    const model = {
      id: "usage-capture-model",
      enabled: true,
      pricing: {
        mode: "custom",
        currency: "USD",
        inputPerMillion: 1,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 2,
      },
    };
    await withRouter("usage-capture", baseConfig(port, [{
      name: "usage-capture-vendor",
      baseUrl: vendor.baseUrl,
      models: [model],
    }]), async ({ port: routerPort }) => {
      const regular = await requestChat(routerPort, "test-token", model.id);
      assert.equal((await regular.json()).choices[0].message.content, "regular");

      const streamed = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: model.id, messages: [], stream: true }),
      });
      const streamText = await streamed.text();
      assert.match(streamText, /streamed/);
      assert.match(streamText, /"total_tokens":150/);
      assert.match(streamText, /data: \[DONE\]/);

      await waitFor(async () => {
        const summary = await readUsageSummary(tempDir);
        return summary.models.find((item) => item.name === model.id)?.requestCount === 2;
      }, "Router did not persist JSON and SSE usage events.");
      const summary = await readUsageSummary(tempDir);
      const modelUsage = summary.models.find((item) => item.name === model.id);
      assert.equal(modelUsage.usageKnownCount, 2);
      assert.equal(modelUsage.totalTokens, 300);
      assert.deepEqual(modelUsage.costs, [{ currency: "USD", amount: 0.00042 }]);
    });
  } finally {
    vendor.server.close();
  }
}

async function testNoVendorsFailsFast() {
  const port = await findFreePort();
  const configPath = writeConfig("no-vendors", baseConfig(port, []));
  const router = await startRouter(configPath);

  try {
    const [code] = await waitForProcessClose(router);
    assert.notEqual(code, 0);
    assert.match(getRouterOutput(router), /vendor|router/i);
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
await testResponsesRoutingAndConversion();
await testTimeoutFallback();
await testCircuitBreakerSkipsFailedVendorPerModel();
await testRuntimeConfigReload();
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
await testUsageCaptureForJsonAndSse();
await testNoVendorsFailsFast();
await testParentIpcStopsRouterGracefully();
await testParentDisconnectStopsRouter();

console.log("fallback smoke tests passed");
