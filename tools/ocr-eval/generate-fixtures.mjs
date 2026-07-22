#!/usr/bin/env node
/**
 * PHARMA-OCR-A — synthetic, de-identified OCR evaluation corpus.
 *
 * DE-IDENTIFICATION: every document here is fabricated. Drug names are public
 * INN generics; suppliers, invoice numbers, batch codes and warehouse names are
 * invented. NO production, patient or supplier-sensitive document is used, and
 * none may ever be added to this repository.
 *
 * Documents are rendered as HTML in headless Chromium, then degraded with sharp
 * to emulate real capture conditions (mobile photo softness, glare, rotation,
 * low light). That gives a reproducible corpus with EXACT ground truth — which
 * is the only way to report field-level accuracy honestly.
 *
 * Output (gitignored, regenerate with `npm run ocr:fixtures`):
 *   tools/ocr-eval/fixtures/*.png
 *   tools/ocr-eval/fixtures/ground-truth.json
 *
 * Usage: node tools/ocr-eval/generate-fixtures.mjs
 */
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures');

/** Ground truth is authored FIRST; the document is rendered from it. */
const DOCUMENTS = [
  {
    id: 'en-clean-amoxicillin',
    language: 'eng',
    truth: {
      scientificName: 'Amoxicillin',
      concentration: '500 mg',
      dosageForm: 'Capsule',
      batchNumber: 'B4471X',
      expiryDate: '2027-06-30',
      quantity: '240',
      nationalCode: '1234567',
      unitPrice: '1250',
      sourceDocumentNumber: 'INV-2026-0088',
    },
    body: `
      <h1>Delivery Note</h1>
      <p class="big">Amoxicillin 500 mg Capsules</p>
      <table>
        <tr><td>National Code</td><td>1234567</td></tr>
        <tr><td>LOT</td><td>B4471X</td></tr>
        <tr><td>EXP</td><td>06/2027</td></tr>
        <tr><td>Quantity</td><td>240</td></tr>
        <tr><td>Unit Price</td><td>1250 IQD</td></tr>
        <tr><td>Invoice No</td><td>INV-2026-0088</td></tr>
        <tr><td>Supplier</td><td>Northgate Medical Supplies</td></tr>
      </table>`,
  },
  {
    id: 'en-clean-paracetamol',
    language: 'eng',
    truth: {
      scientificName: 'Paracetamol',
      concentration: '125 mg/5 ml',
      dosageForm: 'Oral suspension',
      batchNumber: 'PC2291',
      expiryDate: '2028-03-31',
      quantity: '60',
      nationalCode: '7654321',
    },
    body: `
      <h1>Goods Received Note</h1>
      <p class="big">Paracetamol 125 mg/5 ml Oral Suspension</p>
      <table>
        <tr><td>Product Code</td><td>7654321</td></tr>
        <tr><td>Batch Number</td><td>PC2291</td></tr>
        <tr><td>Expiry Date</td><td>03/2028</td></tr>
        <tr><td>Qty</td><td>60</td></tr>
        <tr><td>Manufacturer</td><td>Cedarcrest Pharma</td></tr>
      </table>`,
  },
  {
    id: 'ar-clean-amoxicillin',
    language: 'ara',
    rtl: true,
    truth: {
      concentration: '500 mg',
      dosageForm: 'Capsule',
      batchNumber: 'B4471',
      expiryDate: '2027-06-30',
      quantity: '240',
    },
    body: `
      <h1>مذكرة تسليم</h1>
      <p class="big">أموكسيسيلين ٥٠٠ ملغم كبسولات</p>
      <table>
        <tr><td>رقم التشغيلة</td><td>B4471</td></tr>
        <tr><td>تاريخ الانتهاء</td><td>٠٦/٢٠٢٧</td></tr>
        <tr><td>الكمية</td><td>٢٤٠</td></tr>
        <tr><td>المجهز</td><td>شركة الرافدين الطبية</td></tr>
      </table>`,
  },
  {
    id: 'bilingual-ceftriaxone',
    language: 'ara+eng',
    truth: {
      scientificName: 'Ceftriaxone',
      concentration: '1 g',
      dosageForm: 'Vial',
      batchNumber: 'CFX8823',
      expiryDate: '2027-11-30',
      quantity: '100',
      nationalCode: '5566778',
    },
    body: `
      <h1>Delivery Note / مذكرة تسليم</h1>
      <p class="big">Ceftriaxone 1 g Vial</p>
      <table>
        <tr><td>National Code / الرمز الوطني</td><td>5566778</td></tr>
        <tr><td>LOT / رقم التشغيلة</td><td>CFX8823</td></tr>
        <tr><td>EXP / تاريخ الانتهاء</td><td>11/2027</td></tr>
        <tr><td>Quantity / الكمية</td><td>100</td></tr>
      </table>`,
  },
  {
    id: 'en-dense-invoice',
    language: 'eng',
    truth: {
      scientificName: 'Metformin',
      concentration: '850 mg',
      dosageForm: 'Film-coated tablet',
      batchNumber: 'MT7741',
      expiryDate: '2029-01-31',
      quantity: '1000',
      nationalCode: '9081726',
      unitPrice: '95.5',
      sourceDocumentNumber: 'GRN-4471',
    },
    body: `
      <h1>Warehouse Intake — Consolidated</h1>
      <p>Receiving warehouse: Central Store 2 &nbsp; Date: 14/02/2026</p>
      <p class="big">Metformin 850 mg Film-coated Tablets</p>
      <table>
        <tr><td>Registration No</td><td>9081726</td></tr>
        <tr><td>Batch</td><td>MT7741</td></tr>
        <tr><td>Manufacturing Date</td><td>01/2026</td></tr>
        <tr><td>Expiry</td><td>01/2029</td></tr>
        <tr><td>Quantity</td><td>1000</td></tr>
        <tr><td>Price</td><td>95.5</td></tr>
        <tr><td>Document No</td><td>GRN-4471</td></tr>
        <tr><td>Pack</td><td>Box of 30 tablets</td></tr>
      </table>`,
  },
];

/** Degradations emulating real capture conditions. Each has a stated intent. */
const VARIANTS = [
  { id: 'scan', label: 'clean flatbed scan', apply: (img) => img },
  {
    id: 'photo',
    label: 'handheld mobile photo (slight softness + warmth)',
    apply: (img) => img.blur(0.8).modulate({ brightness: 1.04 }),
  },
  {
    id: 'rotated',
    label: 'rotated 3.5 degrees',
    apply: (img) => img.rotate(3.5, { background: '#ffffff' }),
  },
  {
    id: 'blurred',
    label: 'out-of-focus',
    apply: (img) => img.blur(2.4),
  },
  {
    id: 'glare',
    label: 'flash glare across the upper third',
    apply: (img) => img.linear(1.45, -18),
  },
  {
    id: 'dim',
    label: 'poor indoor lighting',
    apply: (img) => img.linear(0.55, 0),
  },
];

const page = (doc) => `<!doctype html>
<html lang="${doc.rtl ? 'ar' : 'en'}" dir="${doc.rtl ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 56px; width: 1240px; background: #fff; color: #000;
    font-family: ${doc.rtl ? "'Noto Sans Arabic', 'Segoe UI'" : "'Arial', 'Helvetica'"}, sans-serif;
    font-size: 22px; line-height: 1.55;
  }
  h1 { font-size: 30px; margin: 0 0 18px; border-bottom: 3px solid #000; padding-bottom: 10px; }
  .big { font-size: 27px; font-weight: 700; margin: 18px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  td { border: 1px solid #333; padding: 10px 14px; }
  td:first-child { font-weight: 600; width: 42%; background: #f2f2f2; }
</style></head>
<body>${doc.body}</body></html>`;

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const tab = await browser.newPage({ viewport: { width: 1240, height: 1000 } });
  const manifest = [];

  for (const doc of DOCUMENTS) {
    await tab.setContent(page(doc), { waitUntil: 'networkidle' });
    const base = await tab.screenshot({ fullPage: true, type: 'png' });

    for (const variant of VARIANTS) {
      const name = `${doc.id}--${variant.id}.png`;
      const buffer = await variant.apply(sharp(base)).png().toBuffer();
      await writeFile(join(OUT, name), buffer);
      manifest.push({
        file: name,
        documentId: doc.id,
        variant: variant.id,
        variantLabel: variant.label,
        language: doc.language,
        truth: doc.truth,
      });
    }
  }

  await browser.close();
  await writeFile(join(OUT, 'ground-truth.json'), JSON.stringify(manifest, null, 2));
  console.log(`Generated ${manifest.length} de-identified fixtures in ${OUT}`);
}

main().catch((error) => {
  console.error(`Fixture generation failed: ${error.message}`);
  process.exit(1);
});
