import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function color(x, y) {
  const inside = (left, top, right, bottom) => x >= left && x <= right && y >= top && y <= bottom;
  if ((x < 12 || x > 116) && (y < 12 || y > 116)
    && Math.hypot(x < 64 ? x - 12 : x - 116, y < 64 ? y - 12 : y - 116) > 12) return [0, 0, 0, 0];
  if (inside(34, 25, 88, 90) && !inside(40, 31, 82, 84)) return [127, 204, 168, 255];
  if (inside(46, 40, 100, 105)) {
    if (!inside(52, 46, 94, 99)) return [255, 255, 255, 255];
    return [28, 66, 55, 255];
  }
  return [28, 66, 55, 255];
}

await mkdir(new URL('../extension/icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const samples = [];
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        samples.push(color((x + (dx + 0.5) / 4) * 128 / size, (y + (dy + 0.5) / 4) * 128 / size));
      }
      for (let c = 0; c < 4; c++) pixels[y * (size * 4 + 1) + 1 + x * 4 + c] = Math.round(samples.reduce((sum, p) => sum + p[c], 0) / samples.length);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
  await writeFile(new URL(`../extension/icons/${size}.png`, import.meta.url), png);
}
