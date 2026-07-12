import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

if (process.platform !== "win32") {
  throw new Error("The formal installer build currently targets Windows only.");
}

const target = resolve("build", "bin", "node.exe");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(process.execPath, target);
console.log(`Prepared bundled Node runtime: ${target}`);