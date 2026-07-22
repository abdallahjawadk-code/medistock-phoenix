/**
 * APP-ICON-REFRESH-HOTFIX-A — regenerate EVERY runtime app icon from the
 * single approved master. No repainting / tracing / reconstruction — pure
 * crop + resize + re-encode of design/phoenix-source/phoenix-app-icon-master.png
 * (2048², photorealistic 3D Phoenix, teal medical chest, obsidian/navy field).
 *
 * Outputs (VERSIONED "-v2" names so no browser/Android/Windows icon cache can
 * keep resolving old art; the legacy filenames are ALSO overwritten in place
 * so anything still holding a stale manifest gets the new identity too):
 *
 *   public/phoenix-favicon-v2-{16,32,48,64,128}.png   browser/desktop sizes
 *   public/phoenix-favicon-v2.ico                     16+32+48 (PNG-in-ICO)
 *   public/phoenix-favicon-v2.svg                     svg-wrapped 64px raster
 *   public/apple-touch-icon-v2.png                    180², opaque
 *   public/pwa-icon-v2-{192,512}.png                  purpose "any"
 *   public/pwa-icon-maskable-v2-{192,512}.png         safe-zone padded
 *
 * Run: node scripts/phoenix-app-icons.mjs
 */
import sharp from 'sharp';
import { writeFileSync } from 'fs';

const SRC = 'design/phoenix-source/phoenix-app-icon-master.png';
const OUT = 'public';

// The master frames the bird with generous navy margins. For small favicons
// the bird must dominate or it is unreadable at 16px, so small sizes crop the
// central region tighter; large sizes keep more of the field for elegance.
const TIGHT_CROP = 0.82;  // fraction of master kept for <=64px sizes
const WIDE_CROP = 0.92;   // fraction kept for >=128px "any" icons

const meta = await sharp(SRC).metadata();
const W = meta.width, H = meta.height;

function cropRegion(fraction) {
  const side = Math.round(Math.min(W, H) * fraction);
  return {
    left: Math.round((W - side) / 2),
    // The bird's visual mass sits slightly above centre; bias the crop up a
    // touch so head + chest stay centred after cropping.
    top: Math.max(0, Math.round((H - side) / 2 - H * 0.01)),
    width: side,
    height: side,
  };
}

async function pngAt(size, fraction) {
  return sharp(SRC).extract(cropRegion(fraction)).resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9, palette: size <= 64 }).toBuffer();
}

// Obsidian field sampled from the master's own corner so composites blend
// seamlessly with the source art (no repaint, same pigment).
const corner = await sharp(SRC).extract({ left: 4, top: 4, width: 8, height: 8 })
  .resize(1, 1).raw().toBuffer();
const FIELD = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 };

/** Maskable: full-bleed obsidian with the bird inside the ~80% safe zone.
    The bird tile is feathered with a radial alpha mask so its own navy field
    blends seamlessly into the canvas — no visible tile seam under any mask
    shape. */
async function maskableAt(size) {
  const inner = Math.round(size * 0.72);
  const feather = Buffer.from(
    `<svg width="${inner}" height="${inner}" xmlns="http://www.w3.org/2000/svg">
       <defs><radialGradient id="f" cx="50%" cy="50%" r="50%">
         <stop offset="0%" stop-color="#fff"/><stop offset="78%" stop-color="#fff"/>
         <stop offset="100%" stop-color="#000"/>
       </radialGradient></defs>
       <rect width="100%" height="100%" fill="url(#f)"/>
     </svg>`,
  );
  const bird = await sharp(SRC).extract(cropRegion(TIGHT_CROP))
    .resize(inner, inner, { fit: 'cover' })
    .composite([{ input: feather, blend: 'dest-in' }])
    .png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: FIELD } })
    .composite([{ input: bird, gravity: 'centre' }])
    .png({ compressionLevel: 9 }).toBuffer();
}

/** Minimal PNG-in-ICO container (universally supported for favicons). */
function packIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);      // width
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);  // height
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);                    // planes
    dir.writeUInt16LE(32, o + 6);                   // bpp
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(e => e.png)]);
}

// ── Browser/desktop favicon sizes ──
const faviconPngs = {};
for (const size of [16, 32, 48, 64, 128]) {
  const png = await pngAt(size, size <= 64 ? TIGHT_CROP : WIDE_CROP);
  faviconPngs[size] = png;
  writeFileSync(`${OUT}/phoenix-favicon-v2-${size}.png`, png);
  console.log(`phoenix-favicon-v2-${size}.png`, png.length, 'bytes');
}

writeFileSync(`${OUT}/phoenix-favicon-v2.ico`, packIco([
  { size: 16, png: faviconPngs[16] },
  { size: 32, png: faviconPngs[32] },
  { size: 48, png: faviconPngs[48] },
]));
console.log('phoenix-favicon-v2.ico');

// SVG-wrapped raster favicon (crisp, tiny, theme-independent).
const svg64 = faviconPngs[64].toString('base64');
const svgIcon = `<!-- APP-ICON-REFRESH-HOTFIX-A: the approved photorealistic 3D Phoenix
     (design/phoenix-source/phoenix-app-icon-master.png) re-encoded as an
     optimized raster. Regenerate: node scripts/phoenix-app-icons.mjs -->
<svg width="512" height="512" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="MediStock-Babil Phoenix">
  <image width="64" height="64" href="data:image/png;base64,${svg64}"/>
</svg>
`;
writeFileSync(`${OUT}/phoenix-favicon-v2.svg`, svgIcon);
console.log('phoenix-favicon-v2.svg');

// ── Apple touch icon (opaque, 180²) ──
writeFileSync(`${OUT}/apple-touch-icon-v2.png`,
  await sharp(SRC).extract(cropRegion(WIDE_CROP)).resize(180, 180).flatten({ background: FIELD })
    .png({ compressionLevel: 9 }).toBuffer());
console.log('apple-touch-icon-v2.png');

// ── PWA icons ──
for (const size of [192, 512]) {
  writeFileSync(`${OUT}/pwa-icon-v2-${size}.png`, await pngAt(size, WIDE_CROP));
  writeFileSync(`${OUT}/pwa-icon-maskable-v2-${size}.png`, await maskableAt(size));
  console.log(`pwa-icon-v2-${size}.png + pwa-icon-maskable-v2-${size}.png`);
}

// ── Overwrite the RETIRED legacy filenames in place with the new identity so
//    stale caches / pinned manifests can never resurface the old emblem.
//    index.html + manifest reference ONLY the -v2 names above. ──
writeFileSync(`${OUT}/favicon.svg`, svgIcon);
writeFileSync(`${OUT}/app-icon.svg`, svgIcon);
writeFileSync(`${OUT}/pwa-icon-192.svg`, svgIcon);
writeFileSync(`${OUT}/pwa-icon-512.svg`, svgIcon);
writeFileSync(`${OUT}/pwa-icon-maskable-512.svg`, svgIcon);
writeFileSync(`${OUT}/apple-touch-icon.png`,
  await sharp(SRC).extract(cropRegion(WIDE_CROP)).resize(180, 180).flatten({ background: FIELD })
    .png({ compressionLevel: 9 }).toBuffer());
writeFileSync(`${OUT}/pwa-icon-192.png`, await pngAt(192, WIDE_CROP));
writeFileSync(`${OUT}/pwa-icon-512.png`, await pngAt(512, WIDE_CROP));
writeFileSync(`${OUT}/pwa-icon-maskable-512.png`, await maskableAt(512));
console.log('legacy filenames overwritten with the new identity');
