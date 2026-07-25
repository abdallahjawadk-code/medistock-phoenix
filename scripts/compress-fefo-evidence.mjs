/* One-off, run-once optimization pass for the FEFO-override evidence PNGs
   added by scripts/phoenix-capture-fefo-override.mjs. Lossless (palette
   PNG re-encode, no resampling) — pixel content unchanged, just re-compressed. */
import sharp from 'sharp';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('docs', 'phoenix', 'visual-evidence', 'phase3-nine-screens');
const files = readdirSync(DIR).filter((f) => f.startsWith('inventory-dispatch-fefo-override-') && f.endsWith('.png'));

let before = 0;
let after = 0;
for (const f of files) {
  const p = join(DIR, f);
  const sizeBefore = statSync(p).size;
  const buf = await sharp(p).png({ compressionLevel: 9, effort: 10, palette: true }).toBuffer();
  if (buf.length < sizeBefore) writeFileSync(p, buf);
  const sizeAfter = statSync(p).size;
  before += sizeBefore;
  after += sizeAfter;
  console.log(f, sizeBefore, '->', sizeAfter);
}
console.log('TOTAL', before, '->', after, `(${((1 - after / before) * 100).toFixed(1)}% smaller)`);
