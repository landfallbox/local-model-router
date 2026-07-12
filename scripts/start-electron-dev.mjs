import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electronPath from "electron";
import { createServer } from "vite";

const server = await createServer({
  configFile: resolve("gui/vite.config.js"),
});

await server.listen();
server.printUrls();

const rendererUrl = server.resolvedUrls?.local?.[0] || "http://127.0.0.1:5173/";
const projectRoot = resolve(".");
const forwardedArgs = process.argv.slice(2);
const startsHidden = forwardedArgs.some((arg) => ["--hidden", "--background", "--minimized", "--tray"].includes(arg));
const electron = spawn(electronPath, [projectRoot, ...forwardedArgs], {
  env: {
    ...process.env,
    ELECTRON_RENDERER_URL: rendererUrl,
    LOCAL_MODEL_ROUTER_APP_DIR: projectRoot,
    LOCAL_MODEL_ROUTER_START_HIDDEN: startsHidden ? "1" : process.env.LOCAL_MODEL_ROUTER_START_HIDDEN,
    ROUTER_CONFIG: resolve(projectRoot, "config.json"),
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
