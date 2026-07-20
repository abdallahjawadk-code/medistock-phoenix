/**
 * Derive optimized MASAR copyright-seal runtime images DIRECTLY from the approved
 * master. Pure resize + re-encode — no repaint / trace / bg-removal / distortion.
 * The navy background and gold identity are preserved. Square 1:1 throughout.
 * Source: design/phoenix-source/masar-copyright-master.png (1254², navy).
 * Output: public/assets/phoenix/runtime/masar-seal-{128,256,512}.{avif,webp,png}
 */
import sharp from 'sharp';

const SRC = 'design/phoenix-source/masar-copyright-master.png';
const OUT = 'public/assets/phoenix/runtime';
const sizes = [128, 256, 512];

for (const s of sizes) {
  const base = sharp(SRC).resize(s, s, { fit: 'contain' }); // 1:1 master → no distortion
  await base.clone().avif({ quality: 64, effort: 6 }).toFile(`${OUT}/masar-seal-${s}.avif`);
  await base.clone().webp({ quality: 84, effort: 6 }).toFile(`${OUT}/masar-seal-${s}.webp`);
  await base.clone().png({ compressionLevel: 9 }).toFile(`${OUT}/masar-seal-${s}.png`);
  console.log('wrote masar-seal-' + s);
}
