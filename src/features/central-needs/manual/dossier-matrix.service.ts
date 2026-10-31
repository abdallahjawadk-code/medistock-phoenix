import { supabase } from '@/shared/supabase/client';
import { CentralNeedsError, centralNeedsErrorFromPostgrest } from '../central-needs.service';
import { listDossierSources, type DossierSource, type WorkbookSelection } from './dossier-workbook';
import type { MatrixRegion } from './dossier-workbook-matrix';

export interface CaptureInput {
  planId: string; revisionId: string; filename: string; bytes: Uint8Array; operationId: string; year: number;
  rows: WorkbookSelection[]; exclusions: {sheet: number; row: number; quantity_column: number; reason: string}[];
  regions: MatrixRegion[]; signal?: AbortSignal;
}
export class IntakeInterrupted extends Error {
  constructor(readonly operationId: string, readonly intakeId: string | null, readonly confirmedRows: number,
    readonly outcomeUnknown: boolean, readonly businessCode: string | null) { super('dossier_intake_paused'); }
}
async function write(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const {data, error} = await supabase.rpc(name, args);
  if (error) {
    const code = typeof error.code === 'string' ? error.code : '';
    const definitive = (/^(22|23|25|28|40|42|55|P0)[0-9A-Z]{3}$/.test(code) && code !== '40003') || /^PGRST[23][0-9]{2}$/.test(code);
    if (definitive) throw centralNeedsErrorFromPostgrest(error);
    throw new Error('dossier_intake_outcome_unknown');
  }
  if (!data || data.ok !== true) throw new Error('unconfirmed_dossier_intake');
  return data;
}
function progress(source: DossierSource, revisionId: string): number {
  const done = source.applied_rows;
  if (source.revision_id !== revisionId || source.can_resume !== true || !Number.isInteger(source.rows) || source.rows < 1 || source.rows > 10000
    || !Number.isInteger(done) || done === undefined || done < 0 || done > source.rows || done < source.rows && done % 100 !== 0) throw new Error('dossier_progress_invalid');
  return done;
}
/** The user explicitly resumes only after a successful readback. No retry on error. */
export async function resumeDossierWorkbook(planId: string, revisionId: string, intakeId: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new IntakeInterrupted('', intakeId, 0, false, 'dossier_context_changed');
  const source = (await listDossierSources(planId)).find((s) => s.id === intakeId);
  if (!source) throw new Error('dossier_progress_unavailable');
  let done = progress(source, revisionId);
  try {
    while (done < source.rows) {
      if (signal?.aborted) throw new IntakeInterrupted(source.operation_id ?? '', source.id, done, false, 'dossier_context_changed');
      const expected = Math.min(100, source.rows - done);
      const result = await write('phoenix_central_needs_apply_dossier_workbook_batch', {p_intake_id: source.id, p_offset: done});
      if (result.intake_id !== source.id || result.offset !== done || result.rows !== expected) throw new Error('unconfirmed_dossier_batch');
      done += expected;
    }
    return {id: source.id, rows: source.rows, replay: source.applied_rows === source.rows};
  } catch (e) {
    if (e instanceof IntakeInterrupted) throw e;
    throw new IntakeInterrupted(source.operation_id ?? '', source.id, done, !(e instanceof CentralNeedsError), e instanceof CentralNeedsError ? e.businessCode : null);
  }
}
export async function captureDossierWorkbook(input: CaptureInput) {
  let id: string | null = null;
  try {
    if (input.signal?.aborted) throw new IntakeInterrupted(input.operationId, null, 0, false, 'dossier_context_changed');
    const digest = await crypto.subtle.digest('SHA-256', input.bytes.slice().buffer);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2,'0')).join('');
    let binary = '';
    for (let offset = 0; offset < input.bytes.length; offset += 16384) binary += String.fromCharCode(...input.bytes.subarray(offset, offset + 16384));
    if (input.signal?.aborted) throw new IntakeInterrupted(input.operationId, null, 0, false, 'dossier_context_changed');
    const captured = await write('phoenix_central_needs_begin_dossier_workbook', {
      p_revision_id: input.revisionId, p_filename: input.filename, p_file_hash: hash, p_original_base64: btoa(binary),
      p_rows: input.rows, p_exclusions: input.exclusions, p_operation_id: input.operationId,
      p_confirmation: {format: 'matrix-v2', plan_year: input.year, year_confirmed: true, regions: input.regions},
    });
    if (typeof captured.intake_id !== 'string' || captured.rows !== input.rows.length) throw new Error('unconfirmed_dossier_capture');
    id = captured.intake_id;
    return await resumeDossierWorkbook(input.planId, input.revisionId, id, input.signal);
  } catch (e) {
    if (e instanceof IntakeInterrupted || e instanceof CentralNeedsError && id === null) throw e;
    throw new IntakeInterrupted(input.operationId, id, 0, !(e instanceof CentralNeedsError), e instanceof CentralNeedsError ? e.businessCode : null);
  }
}
