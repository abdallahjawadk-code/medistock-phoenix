/**
 * PHOENIX_DEMO_V1 — deterministic identity + synthetic Arabic content.
 *
 * EVERYTHING here is derived, never random. The same seed key always yields
 * the same UUID, document reference and idempotency fingerprint, which is
 * what makes a second `seed` run a genuine no-op rather than a duplicate
 * factory: the corridor RPCs are all idempotent on their request id, and the
 * request ids are derived from these same keys.
 *
 * PRIVACY: every name, reference and identifier below is synthetic and
 * obviously so. No real patient, employee, phone number, email address or
 * national identifier appears anywhere in this file or in anything it
 * generates. Patient references are of the form «مريض تجريبي NN» with an
 * MRN in a reserved DEMO- prefix that no real hospital document uses.
 */
import { createHash } from 'node:crypto';

export const DATASET_KEY = 'PHOENIX_DEMO_V1';

/** Arabic label attached to every demo-owned org/warehouse/outlet name. */
export const DEMO_LABEL_AR = 'تجريبي';

/**
 * Deterministic RFC-4122-shaped v5-style UUID: sha1(namespace + ':' + key),
 * with the version/variant nibbles forced. Collision-resistant for our
 * purposes and stable across machines, processes and runs.
 */
export function demoUuid(key) {
  const h = createHash('sha1').update(`${DATASET_KEY}:${key}`).digest('hex');
  const v = [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),                                   // version 5
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), // variant
    h.slice(20, 32),
  ].join('-');
  return v;
}

/** Deterministic idempotency/request id for a corridor call. */
export const demoRequestId = (key) => demoUuid(`request:${key}`);

/** Deterministic, obviously-synthetic document reference. */
export function demoDocRef(prefix, n) {
  return `DEMO-${prefix}-${String(n).padStart(5, '0')}`;
}

// ── Synthetic Arabic content pools ─────────────────────────────────────────

const INSTITUTION_NAMES = [
  ['مستشفى الأمل التعليمي (تجريبي)', 'Al-Amal Teaching Hospital (demo)'],
  ['مستشفى النخيل العام (تجريبي)', 'Al-Nakheel General Hospital (demo)'],
  ['مستشفى الرافدين للأطفال (تجريبي)', 'Al-Rafidain Children Hospital (demo)'],
  ['مستشفى السلام للنسائية (تجريبي)', 'Al-Salam Maternity Hospital (demo)'],
  ['مركز الفرات الصحي (تجريبي)', 'Al-Furat Health Centre (demo)'],
];

const OUTLET_NAMES = [
  'صيدلية الطوارئ', 'صيدلية الردهات', 'صيدلية العيادات', 'صيدلية الجراحة',
  'صيدلية الأطفال', 'صيدلية النسائية', 'صيدلية العناية المركزة', 'صيدلية الباطنية',
  'صيدلية الحوادث', 'صيدلية الخارجية', 'صيدلية الإنعاش', 'صيدلية الأورام',
];

const MATERIAL_STEMS = [
  ['باراسيتامول', 'Paracetamol'], ['أموكسيسيلين', 'Amoxicillin'],
  ['ميتفورمين', 'Metformin'], ['أوميبرازول', 'Omeprazole'],
  ['أتورفاستاتين', 'Atorvastatin'], ['أملوديبين', 'Amlodipine'],
  ['سيفترياكسون', 'Ceftriaxone'], ['أزيثروميسين', 'Azithromycin'],
  ['ايبوبروفين', 'Ibuprofen'], ['رانيتيدين', 'Ranitidine'],
  ['ديكلوفيناك', 'Diclofenac'], ['سالبوتامول', 'Salbutamol'],
  ['هيدروكورتيزون', 'Hydrocortisone'], ['فوروسيميد', 'Furosemide'],
  ['وارفارين', 'Warfarin'], ['إنسولين', 'Insulin'],
  ['ليفوثيروكسين', 'Levothyroxine'], ['بريدنيزولون', 'Prednisolone'],
  ['كلاريثروميسين', 'Clarithromycin'], ['جنتاميسين', 'Gentamicin'],
];

const CONCENTRATIONS = ['500 ملغم', '250 ملغم', '100 ملغم', '50 ملغم', '1 غم', '20 ملغم'];
const DOSAGE_FORMS = ['أقراص', 'كبسول', 'شراب', 'حقن', 'مرهم', 'تحاميل'];
// The stored vocabulary is exactly ['aid','purchase','kimadia'], and
// 'purchase' REQUIRES a purchase_origin (CHECK constraint on warehouse_stock).
const SUPPLY_TYPES = [
  { supplyType: 'kimadia',  purchaseOrigin: null },
  { supplyType: 'aid',      purchaseOrigin: null },
  { supplyType: 'purchase', purchaseOrigin: 'central' },
  { supplyType: 'purchase', purchaseOrigin: 'supplementary' },
];

/**
 * Batch condition mix. The seeder derives real expiry dates and quantities
 * from these so every reporting classification (available / low / missing /
 * near-expiry / expired / quarantined / damaged) has genuine rows behind it
 * rather than a hand-set status column.
 */
export const BATCH_PROFILES = [
  { key: 'available',   weight: 34, qty: [180, 600], expiryDays: [400, 900] },
  { key: 'low_stock',   weight: 14, qty: [1, 9],     expiryDays: [300, 700] },
  { key: 'out_of_stock',weight: 8,  qty: [0, 0],     expiryDays: [300, 700] },
  { key: 'near_expiry', weight: 14, qty: [40, 200],  expiryDays: [10, 85] },
  { key: 'expired',     weight: 10, qty: [15, 90],   expiryDays: [-240, -5] },
  { key: 'quarantined', weight: 10, qty: [20, 120],  expiryDays: [120, 600] },
  { key: 'damaged',     weight: 10, qty: [10, 60],   expiryDays: [120, 600] },
];

/** Deterministic integer in [min, max] derived from a key. */
export function demoInt(key, min, max) {
  const h = createHash('sha1').update(`${DATASET_KEY}:int:${key}`).digest();
  const span = max - min + 1;
  if (span <= 0) return min;
  return min + (h.readUInt32BE(0) % span);
}

/** Deterministic pick from an array. */
export const demoPick = (key, arr) => arr[demoInt(`pick:${key}`, 0, arr.length - 1)];

/** Deterministic batch profile honouring the weights above. */
export function demoBatchProfile(key) {
  const total = BATCH_PROFILES.reduce((s, p) => s + p.weight, 0);
  let n = demoInt(`profile:${key}`, 0, total - 1);
  for (const p of BATCH_PROFILES) {
    if (n < p.weight) return p;
    n -= p.weight;
  }
  return BATCH_PROFILES[0];
}

export function institutionName(i) {
  return INSTITUTION_NAMES[i % INSTITUTION_NAMES.length];
}

export function outletName(i) {
  return `${OUTLET_NAMES[i % OUTLET_NAMES.length]} (تجريبي)`;
}

export function materialName(i) {
  const [ar, en] = MATERIAL_STEMS[i % MATERIAL_STEMS.length];
  const variant = Math.floor(i / MATERIAL_STEMS.length) + 1;
  const conc = CONCENTRATIONS[i % CONCENTRATIONS.length];
  const form = DOSAGE_FORMS[i % DOSAGE_FORMS.length];
  return {
    scientificName: variant > 1 ? `${ar} ${variant}` : ar,
    tradeName: `${en}-D${variant}`,
    concentration: conc,
    dosageForm: form,
    ...SUPPLY_TYPES[i % SUPPLY_TYPES.length],
  };
}

/** Synthetic beneficiary references — never real identities. */
export function beneficiary(kind, i) {
  if (kind === 'patient') {
    return {
      beneficiaryType: 'patient',
      patientIdentifier: `DEMO-MRN-${String(i).padStart(5, '0')}`,
      patientName: `مريض تجريبي ${i}`,
      patientReferenceType: demoPick(`refkind:${i}`, ['chart', 'card', 'pass']),
    };
  }
  if (kind === 'crash_cart') {
    return { beneficiaryType: 'crash_cart', crashCartReference: `DEMO-CART-${String(i).padStart(4, '0')}` };
  }
  return { beneficiaryType: 'internal_order', internalOrderReference: `DEMO-ORD-${String(i).padStart(5, '0')}` };
}

/** Default scale. Overridable from the CLI so the same code path proves the
 *  small scenario pack first and then scales mechanically. */
export const DEFAULT_SCALE = {
  institutions: 5,
  outletsPerInstitution: 3,   // 5 x 3 = 15 outlets
  materials: 180,
  batchesPerWarehouse: 80,
  dispensesPerOutlet: 6,
  months: 3,
  // Safe by default: migration 141/142's write-once marker (wired through
  // ownership.mjs's registerNewRows) makes every row these corridors create
  // genuinely purgeable, so there is no residue reason left to gate them off.
  includeProcurement: true,
  includeSnapshots: true,
};
