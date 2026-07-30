import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const buildDir = join(projectRoot, "build");
const sourceSvg = join(buildDir, "icon.svg");
const pngDir = join(buildDir, "icons");
const iconPath = join(buildDir, "icon.ico");
const macIconPath = join(buildDir, "icon.png");
const trayIconPath = join(buildDir, "trayTemplate.png");
const trayIcon2xPath = join(buildDir, "trayTemplate@2x.png");
const installerIconPath = join(buildDir, "installerIcon.ico");
const uninstallerIconPath = join(buildDir, "uninstallerIcon.ico");
const sizes = [16, 24, 32, 48, 64, 128, 256];

await mkdir(pngDir, { recursive: true });

const pngFiles = [];
for (const size of sizes) {
  const pngPath = join(pngDir, `icon-${size}.png`);
  await renderSvgToPng(size, pngPath);
  pngFiles.push(pngPath);
}

const ico = await createIco(pngFiles);
await writeFile(iconPath, ico);
await writeFile(installerIconPath, ico);
await writeFile(uninstallerIconPath, ico);
await renderSvgToPng(1024, macIconPath);
await renderTrayIcon(16, trayIconPath);
await renderTrayIcon(32, trayIcon2xPath);
await rm(pngDir, { recursive: true, force: true });

console.log(`Prepared desktop icons: ${iconPath}, ${macIconPath}`);

async function renderSvgToPng(size, outputPath) {
  await sharp(sourceSvg)
    .resize(size, size, { fit: "contain" })
    .png()
    .toFile(outputPath);
}

async function createIco(pngPaths) {
  const images = await Promise.all(pngPaths.map(async (pngPath) => {
    const buffer = await readFile(pngPath);
    const size = readPngSize(buffer);
    return { buffer, ...size };
  }));

  const headerSize = 6;
  const directorySize = images.length * 16;
  let imageOffset = headerSize + directorySize;
  const chunks = [Buffer.alloc(headerSize), Buffer.alloc(directorySize), ...images.map(({ buffer }) => buffer)];

  chunks[0].writeUInt16LE(0, 0);
  chunks[0].writeUInt16LE(1, 2);
  chunks[0].writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const entryOffset = index * 16;
    const directory = chunks[1];
    directory.writeUInt8(image.width >= 256 ? 0 : image.width, entryOffset);
    directory.writeUInt8(image.height >= 256 ? 0 : image.height, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(image.buffer.length, entryOffset + 8);
    directory.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.buffer.length;
  });

  return Buffer.concat(chunks);
}

function readPngSize(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error("Icon conversion expected PNG output.");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function renderTrayIcon(size, outputPath) {
  const scale = size / 16;
  const strokeWidth = Math.max(1, Math.round(scale * 1.5));
  const circleRadius = Math.max(1, Math.round(scale * 1.5));
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <g fill="none" stroke="#000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
        <path d="M${4 * scale} ${4 * scale}H${12 * scale}V${12 * scale}H${4 * scale}"/>
        <path d="M${8 * scale} ${4 * scale}V${12 * scale}"/>
      </g>
      <g fill="#000">
        <circle cx="${4 * scale}" cy="${4 * scale}" r="${circleRadius}"/>
        <circle cx="${8 * scale}" cy="${8 * scale}" r="${circleRadius}"/>
        <circle cx="${12 * scale}" cy="${12 * scale}" r="${circleRadius}"/>
      </g>
    </svg>
  `);

  await sharp(svg).png().toFile(outputPath);
}