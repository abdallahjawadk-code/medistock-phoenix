/** P3-B: attributed yearly corrections and immutable references in the existing need event chain. */
import { NEED_LINE_UNITS } from '../central-needs.service';
import type { ManualNeedEvent, ManualScope } from '../manual/manual-needs.service';
import { checkManualQuantityText } from '../manual/manual-quantity';
import type { MaterialRequest } from '../manual/material-registration.service';
import { ANNUAL_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualFieldVersion, type AnnualIdentityField } from './annual-catalog.contract';
import {
  AnnualCatalogContractError, catalogBoolean, catalogInteger, catalogObject, catalogScope, catalogText,
  catalogUuid, validateAnnualCatalogFields, validateAnnualCatalogItem,
  type AnnualCatalogWriteResult,
} from './annual-catalog-server.contract';

export interface AnnualNeedsServerContract {
  version: 1;
  quantityBinding: true;
  annualEdits: true;
  actorSnapshots: true;
  scope: 'owner_year';
  editPolicy: 'annual_snapshot_with_legal_review';
}

export type AnnualEditableFields = Record<AnnualIdentityField, string | null>;
export const ANNUAL_LEGAL_IDENTITY_FIELDS = ANNUAL_IDENTITY_FIELDS.filter((field) => field !== 'nameAr');

export interface AnnualCatalogChange {
  changeId: string;
  fromFieldVersionId: string;
  toFieldVersionId: string;
  actorId: string;
  actorName: string | null;
  fromTrustedProfile: boolean;
  createdAt: string;
  reason: string;
  beforeFields: AnnualEditableFields;
  afterFields: AnnualEditableFields;
  requiresLegalReview: AnnualIdentityField[];
}

export interface EditAnnualCatalogItemInput {
  scope: AnnualCatalogScope;
  annualItemId: string;
  expectedFieldVersionId: string;
  expectedCanonicalFingerprint: string;
  fields: AnnualEditableFields;
  reason: string;
  idempotencyKey: string;
}

export interface AnnualCatalogEditResult extends AnnualCatalogWriteResult { change: AnnualCatalogChange }
export interface AnnualCatalogChangesPage {
  scope: AnnualCatalogScope;
  annualItemId: string;
  changes: AnnualCatalogChange[];
  nextAfterChangeId: string | null;
}

export interface AnnualNeedBinding {
  scope: AnnualCatalogScope;
  annualItemId: string;
  fieldVersionId: string;
  versionNumber: number;
  canonicalItemId: string;
  fields: AnnualFieldVersion['fields'];
}

export interface AnnualNeedEvent extends ManualNeedEvent {
  createdAt: string;
  /** Null means the historical event did not capture an employee name. */
  actorName: string | null;
  fromTrustedProfile: boolean;
  /** Null means this historical event has no saved annual binding. */
  annualBinding: AnnualNeedBinding | null;
}

export interface AnnualNeedEventsPage {
  scope: AnnualCatalogScope;
  planRevisionId: string;
  events: AnnualNeedEvent[];
  nextAfterEventId: string | null;
}

export interface AnnualNeedWriteInput {
  scope: AnnualCatalogScope;
  manualScope: ManualScope;
  annualItemId: string;
  fieldVersionId: string;
  quantityText: string;
  reason: string;
  idempotencyKey: string;
  expectedLastEventId: string | null;
  reference: string | null;
}
export type AnnualNeedVoidInput = Omit<AnnualNeedWriteInput, 'quantityText'>;
export interface AnnualNeedWriteResult {
  scope: AnnualCatalogScope;
  planRevisionId: string;
  idempotentReplay: boolean;
  eventId: string;
  eventSeq: number;
  annualBinding: AnnualNeedBinding;
}
export interface AnnualMaterialRequestsPage {
  scope: AnnualCatalogScope;
  requests: MaterialRequest[];
  nextAfterRequestId: string | null;
}

export function annualNeedsCheck(ok: boolean, path: string, boundary: 'input' | 'response' = 'response'): asserts ok {
  if (!ok) throw new AnnualCatalogContractError(boundary, `annualNeeds.${path}`);
}

export function annualTimestamp(value: unknown, path: string): string {
  const text = catalogText(value, path, 'response', 64);
  annualNeedsCheck(/^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(Date.parse(text)), path);
  return text;
}

export function validateAnnualNeedsContract(value: unknown): AnnualNeedsServerContract {
  const row = catalogObject(value, ['version', 'quantityBinding', 'annualEdits', 'actorSnapshots', 'scope', 'editPolicy'], 'annualNeeds.contract');
  annualNeedsCheck(row.version === 1 && row.quantityBinding === true && row.annualEdits === true
    && row.actorSnapshots === true && row.scope === 'owner_year' && row.editPolicy === 'annual_snapshot_with_legal_review', 'contract');
  return row as unknown as AnnualNeedsServerContract;
}

export function editableAnnualFields(fields: AnnualFieldVersion['fields']): AnnualEditableFields {
  return Object.fromEntries(ANNUAL_IDENTITY_FIELDS.map((field) => {
    const value = fields[field];
    return [field, value.state === 'known' ? value.value : null];
  })) as AnnualEditableFields;
}

export function validateAnnualEditableFields(value: unknown, boundary: 'input' | 'response' = 'input'): AnnualEditableFields {
  const fields = catalogObject(value, ANNUAL_IDENTITY_FIELDS, 'annualNeeds.fields', boundary);
  for (const field of ANNUAL_IDENTITY_FIELDS) {
    if (fields[field] === null) continue;
    const text = catalogText(fields[field], `annualNeeds.fields.${field}`, boundary, 4000);
    // New corrections follow the server's control-character rule. Historical A1 snapshots
    // remain readable verbatim; the current edit acknowledgement is also matched to validated input.
    if (boundary === 'input') annualNeedsCheck(!/[\u0000-\u001F\u007F]/.test(text), `fields.${field}`, boundary);
    if (field === 'unit') annualNeedsCheck((NEED_LINE_UNITS as readonly string[]).includes(text), 'fields.unit', boundary);
  }
  return fields as AnnualEditableFields;
}

export function validateAnnualCatalogChange(value: unknown): AnnualCatalogChange {
  const row = catalogObject(value, ['changeId', 'fromFieldVersionId', 'toFieldVersionId', 'actorId', 'actorName',
    'fromTrustedProfile', 'createdAt', 'reason', 'beforeFields', 'afterFields', 'requiresLegalReview'], 'annualNeeds.change');
  for (const field of ['changeId', 'fromFieldVersionId', 'toFieldVersionId', 'actorId']) catalogUuid(row[field], `change.${field}`, 'response');
  annualNeedsCheck(row.fromFieldVersionId !== row.toFieldVersionId && row.changeId === row.toFieldVersionId, 'change.version');
  if (row.actorName !== null) catalogText(row.actorName, 'change.actorName', 'response', 4000);
  catalogBoolean(row.fromTrustedProfile, 'change.fromTrustedProfile');
  annualNeedsCheck(row.fromTrustedProfile === (row.actorName !== null), 'change.actorSource');
  annualTimestamp(row.createdAt, 'change.createdAt');
  catalogText(row.reason, 'change.reason', 'response', 2000);
  validateAnnualEditableFields(row.beforeFields, 'response');
  validateAnnualEditableFields(row.afterFields, 'response');
  annualNeedsCheck(Array.isArray(row.requiresLegalReview) && row.requiresLegalReview.length <= 6
    && row.requiresLegalReview.every((field) => ANNUAL_LEGAL_IDENTITY_FIELDS.includes(field))
    && new Set(row.requiresLegalReview).size === row.requiresLegalReview.length, 'change.requiresLegalReview');
  return row as unknown as AnnualCatalogChange;
}

export function validateAnnualCatalogEdit(value: unknown, input: EditAnnualCatalogItemInput): AnnualCatalogEditResult {
  annualNeedsCheck(!!value && typeof value === 'object' && !Array.isArray(value), 'edit');
  const { change, ...item } = value as Record<string, unknown>;
  const validated = validateAnnualCatalogItem(item, input.scope, { annualItemId: input.annualItemId,
    current: true, write: true, allowAnnualEdits: true }) as AnnualCatalogWriteResult;
  const audit = validateAnnualCatalogChange(change);
  annualNeedsCheck(audit.fromTrustedProfile && audit.actorName !== null, 'edit.actorSource');
  annualNeedsCheck(ANNUAL_IDENTITY_FIELDS.some((field) => audit.beforeFields[field] !== audit.afterFields[field]), 'edit.noDifference');
  annualNeedsCheck(audit.fromFieldVersionId === input.expectedFieldVersionId
    && audit.toFieldVersionId === validated.fieldVersion.fieldVersionId && audit.reason === input.reason
    && validated.canonicalFingerprint === input.expectedCanonicalFingerprint, 'edit.intent');
  const fields = editableAnnualFields(validated.fieldVersion.fields);
  annualNeedsCheck(ANNUAL_IDENTITY_FIELDS.every((field) => audit.afterFields[field] === input.fields[field]
    && fields[field] === audit.afterFields[field]), 'edit.afterFields');
  if (audit.requiresLegalReview.length > 0) annualNeedsCheck(!validated.selectable && validated.membership.status === 'preparing', 'edit.reviewRequired');
  return { ...validated, change: audit };
}

export function validateAnnualNeedBinding(value: unknown, scope: AnnualCatalogScope, expected?: {
  annualItemId?: string; fieldVersionId?: string; canonicalItemId?: string;
}): AnnualNeedBinding {
  const row = catalogObject(value, ['scope', 'annualItemId', 'fieldVersionId', 'versionNumber', 'canonicalItemId', 'fields'], 'annualNeeds.binding');
  catalogScope(row.scope, scope, 'response');
  for (const key of ['annualItemId', 'fieldVersionId', 'canonicalItemId'] as const) {
    const id = catalogUuid(row[key], `binding.${key}`, 'response');
    annualNeedsCheck(!expected?.[key] || expected[key] === id, `binding.${key}`);
  }
  catalogInteger(row.versionNumber, 1, 2_147_483_647, 'binding.versionNumber', 'response');
  validateAnnualCatalogFields(row.fields, row.canonicalItemId as string, true);
  return row as unknown as AnnualNeedBinding;
}

export function validateAnnualNeedEvent(value: unknown, scope: AnnualCatalogScope, revisionId: string): AnnualNeedEvent {
  const row = catalogObject(value, ['id', 'planRevisionId', 'beneficiaryOrganizationId', 'centralItemId', 'targetWarehouseId',
    'eventSeq', 'eventKind', 'quantityText', 'approvedUnit', 'reason', 'reference', 'actorId', 'createdAt', 'actorName',
    'fromTrustedProfile', 'annualBinding'], 'annualNeeds.event');
  for (const field of ['id', 'planRevisionId', 'beneficiaryOrganizationId', 'centralItemId', 'actorId']) catalogUuid(row[field], `event.${field}`, 'response');
  annualNeedsCheck(row.planRevisionId === revisionId, 'event.revision');
  if (row.targetWarehouseId !== null) catalogUuid(row.targetWarehouseId, 'event.targetWarehouseId', 'response');
  catalogInteger(row.eventSeq, 1, Number.MAX_SAFE_INTEGER, 'event.eventSeq', 'response');
  annualNeedsCheck(['add', 'correct', 'void', 'carried_forward'].includes(String(row.eventKind)), 'event.kind');
  if (row.quantityText !== null) annualNeedsCheck(typeof row.quantityText === 'string' && checkManualQuantityText(row.quantityText).ok, 'event.quantity');
  if (row.approvedUnit !== null) annualNeedsCheck(typeof row.approvedUnit === 'string'
    && (NEED_LINE_UNITS as readonly string[]).includes(row.approvedUnit), 'event.unit');
  if (row.eventKind !== 'void') annualNeedsCheck(row.quantityText !== null && row.approvedUnit !== null, 'event.liveQuantity');
  catalogText(row.reason, 'event.reason', 'response', 4000);
  if (row.reference !== null) catalogText(row.reference, 'event.reference', 'response', 4000, false);
  annualTimestamp(row.createdAt, 'event.createdAt');
  catalogBoolean(row.fromTrustedProfile, 'event.fromTrustedProfile');
  if (row.actorName !== null) catalogText(row.actorName, 'event.actorName', 'response', 4000);
  annualNeedsCheck(row.fromTrustedProfile === (row.actorName !== null), 'event.actorSource');
  annualNeedsCheck(row.fromTrustedProfile === (row.annualBinding !== null), 'event.bindingActor');
  if (row.annualBinding !== null) {
    const binding = validateAnnualNeedBinding(row.annualBinding, scope, { canonicalItemId: row.centralItemId as string });
    const unit = binding.fields.unit;
    if (row.eventKind !== 'void') annualNeedsCheck(unit.state === 'known' && unit.value === row.approvedUnit, 'event.bindingUnit');
  }
  return row as unknown as AnnualNeedEvent;
}

export function validateAnnualNeedWrite(value: unknown, input: AnnualNeedWriteInput | AnnualNeedVoidInput): AnnualNeedWriteResult {
  const row = catalogObject(value, ['scope', 'planRevisionId', 'idempotentReplay', 'eventId', 'eventSeq', 'annualBinding'], 'annualNeeds.write');
  catalogScope(row.scope, input.scope, 'response');
  annualNeedsCheck(catalogUuid(row.planRevisionId, 'write.planRevisionId', 'response') === input.manualScope.planRevisionId, 'write.revision');
  catalogBoolean(row.idempotentReplay, 'write.idempotentReplay');
  catalogUuid(row.eventId, 'write.eventId', 'response');
  catalogInteger(row.eventSeq, 1, Number.MAX_SAFE_INTEGER, 'write.eventSeq', 'response');
  validateAnnualNeedBinding(row.annualBinding, input.scope, { annualItemId: input.annualItemId,
    fieldVersionId: input.fieldVersionId, canonicalItemId: input.manualScope.centralItemId });
  return row as unknown as AnnualNeedWriteResult;
}
