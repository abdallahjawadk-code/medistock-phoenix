/**
 * MOVEMENT-COMPOSER-A — receipt content model and the print field selector.
 *
 * TWO RULES SHAPE THIS FILE:
 *
 * 1. An official receipt is built from the SERVER-RELOADED canonical transfer /
 *    shipment row, never from the local composer draft. The draft is what the
 *    operator asked for; the receipt must state what actually happened.
 *
 * 2. Some header fields are mandatory and LOCKED. A document without its kind,
 *    canonical trace key, timestamp, source, destination and status cannot be
 *    traced back to a movement, so those cannot be deselected at print time no
 *    matter which preset is chosen. Everything else is the operator's choice.
 */
import type { MovementDocumentKind } from './movement-trace';

/** Watermark honesty: a document must never look more final than it is. */
export type ReceiptWatermark = 'none' | 'draft' | 'partial' | 'cancelled' | 'reprint';

export interface ReceiptParty {
  organizationName: string | null;
  warehouseName: string | null;
}

/** One printed material row. Every value comes from the canonical server row. */
export interface ReceiptLine {
  lineNumber: number;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  requestedQuantity: number | null;
  approvedQuantity: number | null;
  /** Dispatched for supply, returned for a return shipment. */
  movedQuantity: number | null;
  receivedQuantity: number | null;
  onHandSnapshot: number | null;
  returnReason: string | null;
  disposition: string | null;
  custodyState: string | null;
  unitPrice: number | null;
  currency: string | null;
  priceBasis: string | null;
  supplyType: string | null;
  notes: string | null;
  /** Return lines only — links back to the exact original supply line. */
  originalSupplyReference: string | null;
}

export interface ReceiptDocument {
  kind: MovementDocumentKind;
  /** The immutable uuid. THE canonical key. */
  traceKey: string;
  /** Operator-typed value. Presented as an external reference, never a serial. */
  externalReference: string | null;
  /** Related request's uuid, when this is a dispatch/shipment. */
  requestTraceKey: string | null;
  /** For a return: the original supply/transfer uuid. */
  originalSupplyTraceKey: string | null;
  status: string;
  eventAt: string | null;
  source: ReceiptParty;
  destination: ReceiptParty;
  /** Only when legitimately exposed by RLS; otherwise null → "not available". */
  actorName: string | null;
  actorRole: string | null;
  counterpartyName: string | null;
  watermark: ReceiptWatermark;
  reprintedAt: string | null;
  lines: ReceiptLine[];
}

// ── field selector ───────────────────────────────────────────────────────────

export type ReceiptFieldKey =
  | 'lineNumber' | 'scientificName' | 'tradeName' | 'concentration' | 'dosageForm'
  | 'unit' | 'nationalCode' | 'batchNumber' | 'internalBatchReference' | 'expiryDate'
  | 'requestedQuantity' | 'approvedQuantity' | 'movedQuantity' | 'receivedQuantity'
  | 'onHandSnapshot' | 'returnReason' | 'disposition' | 'custodyState'
  | 'unitPrice' | 'currency' | 'priceBasis' | 'supplyType' | 'notes'
  | 'originalSupplyReference';

export interface ReceiptFieldDefinition {
  key: ReceiptFieldKey;
  labelKey: string;
  /** Cannot be deselected — the row is meaningless without it. */
  locked: boolean;
  /** Only rendered when the viewer is authorized to see pricing. */
  requiresPricePermission?: boolean;
  /** Only meaningful on a return document. */
  returnOnly?: boolean;
}

/**
 * `lineNumber` and `scientificName` are locked at ROW level for the same reason
 * the header trace fields are locked: a material row that identifies no material
 * is not a record of anything.
 */
export const RECEIPT_FIELDS: readonly ReceiptFieldDefinition[] = [
  { key: 'lineNumber', labelKey: 'mv_f_line_number', locked: true },
  { key: 'scientificName', labelKey: 'mv_f_scientific_name', locked: true },
  { key: 'tradeName', labelKey: 'mv_f_trade_name', locked: false },
  { key: 'concentration', labelKey: 'mv_f_concentration', locked: false },
  { key: 'dosageForm', labelKey: 'mv_f_dosage_form', locked: false },
  { key: 'unit', labelKey: 'mv_f_unit', locked: false },
  { key: 'nationalCode', labelKey: 'mv_f_national_code', locked: false },
  { key: 'batchNumber', labelKey: 'mv_f_batch_number', locked: false },
  { key: 'internalBatchReference', labelKey: 'mv_f_internal_batch_reference', locked: false },
  { key: 'expiryDate', labelKey: 'mv_f_expiry_date', locked: false },
  { key: 'requestedQuantity', labelKey: 'mv_f_requested_quantity', locked: false },
  { key: 'approvedQuantity', labelKey: 'mv_f_approved_quantity', locked: false },
  { key: 'movedQuantity', labelKey: 'mv_f_moved_quantity', locked: false },
  { key: 'receivedQuantity', labelKey: 'mv_f_received_quantity', locked: false },
  { key: 'onHandSnapshot', labelKey: 'mv_f_on_hand_snapshot', locked: false },
  { key: 'returnReason', labelKey: 'mv_f_return_reason', locked: false, returnOnly: true },
  { key: 'disposition', labelKey: 'mv_f_disposition', locked: false, returnOnly: true },
  { key: 'custodyState', labelKey: 'mv_f_custody_state', locked: false, returnOnly: true },
  { key: 'originalSupplyReference', labelKey: 'mv_f_original_supply_reference', locked: false, returnOnly: true },
  { key: 'unitPrice', labelKey: 'mv_f_unit_price', locked: false, requiresPricePermission: true },
  { key: 'currency', labelKey: 'mv_f_currency', locked: false, requiresPricePermission: true },
  { key: 'priceBasis', labelKey: 'mv_f_price_basis', locked: false, requiresPricePermission: true },
  { key: 'supplyType', labelKey: 'mv_f_supply_type', locked: false, requiresPricePermission: true },
  { key: 'notes', labelKey: 'mv_f_notes', locked: false },
];

export const LOCKED_FIELD_KEYS: readonly ReceiptFieldKey[] =
  RECEIPT_FIELDS.filter(f => f.locked).map(f => f.key);

/**
 * Header fields that can never be removed. Kept as data so the print builder and
 * its tests agree on one list rather than two that can drift apart.
 */
export const MANDATORY_HEADER_FIELDS = [
  'documentType', 'traceKey', 'qr', 'eventAt', 'source', 'destination', 'status',
] as const;
export type MandatoryHeaderField = typeof MANDATORY_HEADER_FIELDS[number];

export type ReceiptPreset = 'full' | 'compact' | 'custom';

const COMPACT_KEYS: readonly ReceiptFieldKey[] = [
  'lineNumber', 'scientificName', 'concentration', 'dosageForm', 'unit',
  'batchNumber', 'expiryDate', 'movedQuantity',
];

/**
 * Which fields a preset selects, narrowed to what this document and viewer may
 * actually show. Price fields disappear entirely without permission — they are
 * not merely blanked, so an unauthorized print cannot leak a column header that
 * implies a value exists.
 */
export function fieldsForPreset(
  preset: Exclude<ReceiptPreset, 'custom'>,
  options: { isReturn: boolean; canSeePrices: boolean },
): ReceiptFieldKey[] {
  return availableFields(options)
    .filter(f => (preset === 'full' ? true : COMPACT_KEYS.includes(f.key)))
    .map(f => f.key);
}

export function availableFields(options: { isReturn: boolean; canSeePrices: boolean }): ReceiptFieldDefinition[] {
  return RECEIPT_FIELDS.filter(f => {
    if (f.returnOnly && !options.isReturn) return false;
    if (f.requiresPricePermission && !options.canSeePrices) return false;
    return true;
  });
}

/**
 * Normalize a selection before printing.
 *
 * Locked fields are re-added even if a caller tried to drop them, unavailable
 * fields are stripped, and the result keeps RECEIPT_FIELDS order so column order
 * is stable regardless of the order the operator ticked things.
 */
export function normalizeSelection(
  selected: Iterable<ReceiptFieldKey>,
  options: { isReturn: boolean; canSeePrices: boolean },
): ReceiptFieldKey[] {
  const available = availableFields(options);
  const availableKeys = new Set(available.map(f => f.key));
  const chosen = new Set([...selected].filter(k => availableKeys.has(k)));
  for (const key of LOCKED_FIELD_KEYS) if (availableKeys.has(key)) chosen.add(key);
  return available.filter(f => chosen.has(f.key)).map(f => f.key);
}

/** "Clear optional fields" leaves exactly the locked ones — never nothing. */
export function clearOptionalFields(options: { isReturn: boolean; canSeePrices: boolean }): ReceiptFieldKey[] {
  return normalizeSelection([], options);
}

/**
 * Choose the page orientation from the column count rather than asking. Beyond
 * roughly eight columns a portrait A4 starts squeezing material names.
 */
export function orientationFor(selected: readonly ReceiptFieldKey[]): 'portrait' | 'landscape' {
  return selected.length > 8 ? 'landscape' : 'portrait';
}

/** The value a receipt cell should show. Never fabricates a missing field. */
export function receiptCellValue(line: ReceiptLine, key: ReceiptFieldKey): string {
  const raw = (line as unknown as Record<string, unknown>)[key];
  if (raw === null || raw === undefined || raw === '') return '—';
  return String(raw);
}
