/**
 * CN-2A verification tooling — generates the synthetic ZIP fixture used for
 * Node/browser archive-parity evidence. Run once; the resulting .zip is a
 * committed SYNTHETIC fixture containing no real corpus or business data.
 *
 * Usage: node scripts/cn2a-make-zip-fixture.ts
 */
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';

function crc32(buf: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const isDir = entry.name.endsWith('/');
    const payload = isDir ? new Uint8Array(0) : new Uint8Array(deflateRawSync(Buffer.from(entry.data)));
    const method = isDir ? 0 : 8;

    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralStart = offset;
  const centralBytes = concat(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, centralStart, true);
  return concat([...locals, centralBytes, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Synthetic workbook exercising the contract's tricky cases.
const ws = XLSX.utils.aoa_to_sheet([
  ['Item', 'Item', 'Qty'],
  ['Paracetamol', 'x', 10],
  ['Amoxicillin', 'y', 0],
]);
ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
ws.D2 = { t: 'n', v: 5, f: 'C2*0.5' };
ws.D3 = { t: 'e', v: 15, w: '#VALUE!', f: 'C3/0' };
ws['!ref'] = 'A1:E3';
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const workbookBytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));

const zip = buildZip([
  { name: 'needs/', data: new Uint8Array(0) },
  { name: 'needs/institution-a.xlsx', data: workbookBytes },
  { name: 'needs/~$institution-a.xlsx', data: new Uint8Array(165).fill(0x20) },
]);

const out = 'src/features/central-needs/import/__tests__/fixtures/synthetic-archive.zip';
writeFileSync(out, zip);
console.log(`wrote ${out} (${zip.length} bytes, ${3} entries)`);
