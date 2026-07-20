import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronPath from "electron";
import { createServer } from "vite";

const server = await createServer({
  configFile: resolve("gui/vite.config.js"),
});

await server.listen();
server.printUrls();

const rendererUrl = server.resolvedUrls?.local?.[0] || "http://127.0.0.1:5173/";
const projectRoot = resolve(".");
const projectHash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
const devDataRoot = process.env.LOCAL_MODEL_ROUTER_DEV_DATA_DIR || join(tmpdir(), "local-model-router-dev", projectHash);
const requestedArgs = process.argv.slice(2);
const mockUpdateArg = requestedArgs.includes("--mock-update");
const mockUpdateErrorArg = requestedArgs.includes("--mock-update-error");
const forwardedArgs = requestedArgs.filter((arg) => !["--mock-update", "--mock-update-error"].includes(arg));
const startsHidden = forwardedArgs.some((arg) => ["--hidden", "--background", "--minimized", "--tray"].includes(arg));
const isMockUpdate = mockUpdateArg || mockUpdateErrorArg;
const previewSuffix = mockUpdateErrorArg ? "update-error-preview" : mockUpdateArg ? "update-preview" : "";
const devUserDataDir = join(devDataRoot, previewSuffix ? `electron-user-data-${previewSuffix}` : "electron-user-data");
const devRouterDataDir = join(devDataRoot, previewSuffix ? `router-data-${previewSuffix}` : "router-data");
const devConfigPath = process.env.ROUTER_CONFIG || join(devRouterDataDir, "config.json");

mkdirSync(devUserDataDir, { recursive: true });
mkdirSync(devRouterDataDir, { recursive: true });

const electron = spawn(electronPath, [projectRoot, ...forwardedArgs], {
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
    LOCAL_MODEL_ROUTER_APP_DIR: projectRoot,
    LOCAL_MODEL_ROUTER_DATA_DIR: devRouterDataDir,
    LOCAL_MODEL_ROUTER_DEFAULT_PORT: process.env.LOCAL_MODEL_ROUTER_DEFAULT_PORT || (mockUpdateErrorArg ? "4300" : isMockUpdate ? "4200" : "4100"),
    LOCAL_MODEL_ROUTER_DEV_MODE: "1",
    LOCAL_MODEL_ROUTER_MOCK_UPDATE: mockUpdateErrorArg ? "download-error" : mockUpdateArg ? "available" : process.env.LOCAL_MODEL_ROUTER_MOCK_UPDATE,
    LOCAL_MODEL_ROUTER_START_HIDDEN: startsHidden ? "1" : process.env.LOCAL_MODEL_ROUTER_START_HIDDEN,
    LOCAL_MODEL_ROUTER_USER_DATA_DIR: devUserDataDir,
    ROUTER_CONFIG: devConfigPath,
  },
  stdio: "inherit",
  windowsHide: false,
});

async function shutdown(code = 0) {
  electron.kill();
  await server.close();
  process.exit(code);
}

electron.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});
