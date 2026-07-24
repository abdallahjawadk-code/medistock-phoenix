/**
 * PAPER-REFERENCE-CONTRACT-110 — read-side client for phoenix_paper_references.
 *
 * A plain RLS-scoped SELECT by (document_type, document_id) — no RPC needed
 * for reads, since 110 already grants authenticated SELECT on the table and
 * scopes every row by organization_id via RLS. Writes remain exclusively
 * through phoenix_set_paper_reference (never called from here).
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

export type PaperReferenceDocumentType =
  | 'warehouse_dispatch' | 'warehouse_return_request' | 'outlet_return_request'
  | 'stock_correction_request' | 'warehouse_stock_movement';

export interface PaperReference {
  paperReferenceNumber: string | null;
  paperReferenceDate: string | null;
  issuingAuthority: string | null;
  paperReferenceNotes: string | null;
}

interface PaperReferenceDbRow {
  paper_reference_number: string | null;
  paper_reference_date: string | null;
  issuing_authority: string | null;
  paper_reference_notes: string | null;
}

/**
 * The paper reference attached to one document, or null when none has been
 * recorded (the common case — most documents never carry one). Never throws
 * on "not found"; only a genuine read error propagates.
 */
export async function getPaperReference(
  documentType: PaperReferenceDocumentType,
  documentId: string | null | undefined,
): Promise<PaperReference | null> {
  if (!supabaseConfigured || !documentId) return null;
  const { data, error } = await supabase
    .from('phoenix_paper_references')
    .select('paper_reference_number, paper_reference_date, issuing_authority, paper_reference_notes')
    .eq('document_type', documentType)
    .eq('document_id', documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as PaperReferenceDbRow;
  return {
    paperReferenceNumber: r.paper_reference_number,
    paperReferenceDate: r.paper_reference_date,
    issuingAuthority: r.issuing_authority,
    paperReferenceNotes: r.paper_reference_notes,
  };
}

/**
 * Paper references for MANY documents of the SAME type in ONE query — a
 * ledger/history view showing N rows must never issue N getPaperReference
 * calls. Returns a Map keyed by document_id; a document absent from the map
 * simply has no paper reference recorded.
 */
export async function getPaperReferencesFor(
  documentType: PaperReferenceDocumentType,
  documentIds: readonly string[],
): Promise<Map<string, PaperReference>> {
  if (!supabaseConfigured || documentIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('phoenix_paper_references')
    .select('document_id, paper_reference_number, paper_reference_date, issuing_authority, paper_reference_notes')
    .eq('document_type', documentType)
    .in('document_id', documentIds as string[]);
  if (error) throw error;
  const rows = (data as unknown as (PaperReferenceDbRow & { document_id: string })[] | null) ?? [];
  return new Map(rows.map(r => [r.document_id, {
    paperReferenceNumber: r.paper_reference_number,
    paperReferenceDate: r.paper_reference_date,
    issuingAuthority: r.issuing_authority,
    paperReferenceNotes: r.paper_reference_notes,
  }]));
}

export interface SetPaperReferenceInput {
  documentType: PaperReferenceDocumentType;
  documentId: string;
  paperReferenceNumber: string | null;
  paperReferenceDate?: string | null;
  issuingAuthority?: string | null;
  paperReferenceNotes?: string | null;
}

export interface SetPaperReferenceResult {
  ok: boolean;
  possibleDuplicate?: boolean;
  error?: string;
}

/**
 * The ONLY writer — a thin call to phoenix_set_paper_reference (110). The RPC
 * itself re-derives the document's org/role/editable-state on every call, so
 * a stale client (document moved past draft/pending since it was loaded)
 * fails server-side rather than silently succeeding. All three optional
 * fields are nullable by design — a paper reference is optional metadata,
 * never a precondition for the underlying document's own lifecycle.
 */
export async function setPaperReference(input: SetPaperReferenceInput): Promise<SetPaperReferenceResult> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const trimmedNumber = (input.paperReferenceNumber ?? '').trim();
  if (trimmedNumber === '') return { ok: false, error: 'paper_reference_number_required' };
  const { data, error } = await supabase.rpc('phoenix_set_paper_reference', {
    p_document_type: input.documentType,
    p_document_id: input.documentId,
    p_paper_reference_number: trimmedNumber,
    p_paper_reference_date: input.paperReferenceDate ?? null,
    p_issuing_authority: input.issuingAuthority ?? null,
    p_paper_reference_notes: input.paperReferenceNotes ?? null,
  });
  if (error) {
    const head = /[a-z][a-z0-9_]{3,}/.exec(error.message ?? '');
    return { ok: false, error: head ? head[0] : 'unknown_error' };
  }
  const r = data as { ok?: boolean; possible_duplicate?: boolean };
  return { ok: r.ok !== false, possibleDuplicate: r.possible_duplicate ?? false };
}
