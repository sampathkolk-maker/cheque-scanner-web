// Generates placeholder app icons (solid accent) in all formats Tauri bundles
// need: PNGs, a Windows .ico, and a macOS .icns — using only Node's zlib.
// Replace with your own logo via:  npx tauri icon path/to/logo.png
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('./src-tauri/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const COLOR = [0x4f, 0x8c, 0xff, 0xff]; // accent blue, opaque

// --- CRC32 (for PNG chunks) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function pngSolid(size, [r, g, b, a]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // rows: filter byte 0 + RGBA pixels
  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function ico(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 == 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bit count
  entry.writeUInt32LE(png.length, 8); // bytes in resource
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png]);
}

function icns(entries) {
  // entries: [{ type, png }]
  const blocks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    Buffer.from(type, 'ascii').copy(head, 0);
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  Buffer.from('icns', 'ascii').copy(head, 0);
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

const p32 = pngSolid(32, COLOR);
const p128 = pngSolid(128, COLOR);
const p256 = pngSolid(256, COLOR);
const p512 = pngSolid(512, COLOR);

writeFileSync(new URL('32x32.png', OUT), p32);
writeFileSync(new URL('128x128.png', OUT), p128);
writeFileSync(new URL('128x128@2x.png', OUT), p256);
writeFileSync(new URL('icon.png', OUT), p512);
writeFileSync(new URL('icon.ico', OUT), ico(p256, 256));
writeFileSync(
  new URL('icon.icns', OUT),
  icns([
    { type: 'ic07', png: p128 },
    { type: 'ic08', png: p256 },
    { type: 'ic09', png: p512 }
  ])
);
console.log('icons written to src-tauri/icons/');
