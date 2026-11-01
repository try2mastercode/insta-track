// Generates icons/icon{16,32,48,128}.png (a gradient rounded square with a "not following" slash).
// Pure Node, no dependencies:  node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  let crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // rounded-square mask
      const dx = Math.max(r - x - 0.5, 0, x + 0.5 - (size - r));
      const dy = Math.max(r - y - 0.5, 0, y + 0.5 - (size - r));
      const inside = dx * dx + dy * dy <= r * r;
      const t = (x + y) / (2 * size);
      // black -> gold
      let R = Math.round(20 + (212 - 20) * t);
      let G = Math.round(16 + (175 - 16) * t);
      let B = Math.round(4 + (55 - 4) * t);
      // white person silhouette (head + shoulders)
      const cx = size * 0.5;
      const head = Math.hypot(x + 0.5 - cx, y + 0.5 - size * 0.38) < size * 0.14;
      const body = Math.hypot((x + 0.5 - cx) / 1.5, y + 0.5 - size * 0.8) < size * 0.2 && y + 0.5 < size * 0.8;
      // slash
      const d = Math.abs(x + 0.5 - (size - (y + 0.5))) / Math.SQRT2;
      const slash = d < Math.max(1, size * 0.045) && x > size * 0.15 && x < size * 0.85 && y > size * 0.15 && y < size * 0.85;
      if (head || body) {
        R = 245;
        G = 215;
        B = 110;
      }
      if (slash) {
        R = 255;
        G = 255;
        B = 255;
      }
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
      raw[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
[16, 32, 48, 128].forEach((s) => fs.writeFileSync(path.join(dir, `icon${s}.png`), png(s)));
console.log('icons written to', dir);
