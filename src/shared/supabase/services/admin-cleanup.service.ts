import { supabase, supabaseConfigured } from '../client';

export const DEEP_CLEAN_AVAILABILITY_CONFIRMATION = 'DEEP CLEAN AVAILABILITY';

export interface AvailabilityDeepCleanCounts {
  inter_org_exchange_events: number;
  inter_org_exchange_requests: number;
  inter_org_alert_events: number;
  inter_org_alert_states: number;
  item_availability_movements: number;
  item_availability: number;
}

export interface AvailabilityDeepCleanDryRunResult {
  ok: true;
  dryRun: true;
  strategy: 'physical_delete_operational_availability';
  confirmationRequired: string;
  warning: string;
  counts: AvailabilityDeepCleanCounts;
  protectedTables: string[];
}

export interface AvailabilityDeepCleanExecuteResult {
  ok: true;
  dryRun: false;
  strategy: 'physical_delete_operational_availability';
  countsBefore: AvailabilityDeepCleanCounts;
  countsAfter: AvailabilityDeepCleanCounts;
  rowsDeletedByTable: AvailabilityDeepCleanCounts;
}

export interface AvailabilityDeepCleanError {
  ok: false;
  error: string;
}

/**
 * Dry run: fully read-only. Never mutates data. Requires a super_admin
 * session — the real check is server-side (phoenix_clean_availability_data,
 * migration 055); a non-super caller gets back
 * { ok: false, error: 'INSUFFICIENT_ROLE' }.
 */
export async function dryRunAvailabilityDeepClean(): Promise<
  AvailabilityDeepCleanDryRunResult | AvailabilityDeepCleanError
> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_clean_availability_data', {
    p_dry_run: true,
    p_confirmation: null,
  });

  if (error) throw error;
  return data as AvailabilityDeepCleanDryRunResult | AvailabilityDeepCleanError;
}

/**
 * Execute: physically DELETEs item_availability, item_availability_movements,
 * and every linked inter-org alert/exchange row, in FK-safe order. Requires
 * the exact confirmation phrase DEEP CLEAN AVAILABILITY — the RPC itself
 * rejects anything else with { ok: false, error: 'INVALID_CONFIRMATION' }.
 */
export async function executeAvailabilityDeepClean(
  confirmation: string,
): Promise<AvailabilityDeepCleanExecuteResult | AvailabilityDeepCleanError> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('phoenix_clean_availability_data', {
    p_dry_run: false,
    p_confirmation: confirmation,
  });

  if (error) throw error;
  return data as AvailabilityDeepCleanExecuteResult | AvailabilityDeepCleanError;
}
