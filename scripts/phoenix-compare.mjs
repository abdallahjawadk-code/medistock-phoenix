/**
 * Build a side-by-side comparison PNG: approved reference (left) vs implementation
 * (right), scaled to a common height on an obsidian canvas with a divider.
 * Usage: node scripts/phoenix-compare.mjs <reference> <implementation> <out.png>
 */
import sharp from 'sharp';

const [, , refPath, implPath, out] = process.argv;
if (!refPath || !implPath || !out) { console.error('usage: <ref> <impl> <out>'); process.exit(2); }

const H = 760;
const GAP = 28;
const PAD = 28;
const BG = { r: 7, g: 17, b: 31, alpha: 1 };

async function fit(p) {
  const img = sharp(p);
  const m = await img.metadata();
  const w = Math.round((H * m.width) / m.height);
  return { buf: await img.resize(w, H, { fit: 'fill' }).toBuffer(), w };
}

const a = await fit(refPath);
const b = await fit(implPath);
const width = PAD * 2 + a.w + GAP + b.w;
const height = H + PAD * 2 + 34;

await sharp({ create: { width, height, channels: 4, background: BG } })
  .composite([
    { input: a.buf, left: PAD, top: PAD + 34 },
    { input: b.buf, left: PAD + a.w + GAP, top: PAD + 34 },
    { input: { create: { width: 2, height: H, channels: 4, background: { r: 221, g: 186, b: 99, alpha: 0.5 } } }, left: PAD + a.w + GAP / 2 - 1, top: PAD + 34 },
    { input: Buffer.from(`<svg width="${width}" height="34"><style>text{fill:#DDBA63;font-family:sans-serif;font-size:16px;font-weight:700;letter-spacing:2px}</style><text x="${PAD}" y="24">APPROVED REFERENCE</text><text x="${PAD + a.w + GAP}" y="24">IMPLEMENTATION</text></svg>`), left: 0, top: 6 },
  ])
  .png()
  .toFile(out);
console.log('wrote', out, `${width}x${height}`);
