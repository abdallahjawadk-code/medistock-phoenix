/**
 * Derive optimized brand-mark rasters DIRECTLY from the approved app-icon master.
 * No repainting / tracing / reconstruction — pure resize + re-encode.
 * Source: design/phoenix-source/phoenix-app-icon-master.png (2048², navy safe-zone).
 * Output: public/assets/phoenix/runtime/phoenix-icon-{256,512}.{avif,webp,png}
 */
import sharp from 'sharp';

const SRC = 'design/phoenix-source/phoenix-app-icon-master.png';
const OUT = 'public/assets/phoenix/runtime';
const sizes = [256, 512];

for (const s of sizes) {
  const base = sharp(SRC).resize(s, s, { fit: 'cover' });
  await base.clone().avif({ quality: 62, effort: 6 }).toFile(`${OUT}/phoenix-icon-${s}.avif`);
  await base.clone().webp({ quality: 82, effort: 6 }).toFile(`${OUT}/phoenix-icon-${s}.webp`);
  await base.clone().png({ compressionLevel: 9 }).toFile(`${OUT}/phoenix-icon-${s}.png`);
  console.log('wrote phoenix-icon-' + s);
}

const meta = await sharp(SRC).metadata();
console.log('master source', meta.width + 'x' + meta.height);
