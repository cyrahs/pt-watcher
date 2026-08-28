// 从 src/web/public/favicon.svg 生成 PNG/ICO 图标，产物提交进 repo。
// 用法: bun scripts/gen-icons.ts  （需要临时安装 sharp: bun add -d sharp）

import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const SRC = "src/web/public/favicon.svg";
const OUT = "src/web/public";

async function png(size: number, name: string): Promise<Buffer> {
  const buf = await sharp(SRC, { density: 300 }).resize(size, size).png().toBuffer();
  await Bun.write(`${OUT}/${name}`, new Uint8Array(buf));
  console.log(`✓ ${name} (${size}x${size})`);
  return buf;
}

/** 最小 ICO 封装：直接内嵌 PNG（现代浏览器/系统均支持 PNG-in-ICO） */
function icoFromPngs(pngs: { size: number; data: Buffer }[]): Uint8Array {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return new Uint8Array(Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
}

await mkdir(OUT, { recursive: true });
const png16 = await png(16, "favicon-16.png");
const png32 = await png(32, "favicon-32.png");
await png(180, "apple-touch-icon.png");
await png(512, "icon-512.png");
await Bun.write(
  `${OUT}/favicon.ico`,
  icoFromPngs([
    { size: 16, data: png16 },
    { size: 32, data: png32 },
  ]),
);
console.log("✓ favicon.ico");
