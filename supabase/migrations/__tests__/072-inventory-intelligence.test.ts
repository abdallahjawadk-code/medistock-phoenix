/**
 * INVENTORY-INTELLIGENCE-072-A
 *
 * Static SQL-source tests for migration 072 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 044-071.
 *
 * 072 adds a READ-ONLY intelligence layer over the existing warehouse_stock
 * (060/065) and outlet_stock (067) truth: it classifies stock into signals
 * (missing/low_stock/surplus/near_expiry/expired), orders batches FEFO when it
 * suggests a move, raises deduplicated in-app alerts with a full lifecycle,
 * suggests surplus->shortage transfers WITHOUT executing them, and scopes every
 * row to the concerned organization via RLS. It moves no stock and is frugal by
 * design: no images, no periodic snapshots/cron, no WhatsApp.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour. This migration has not
 * yet been applied to a disposable database — see the file's own header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M072_NAME = '072_phoenix_inventory_intelligence.sql';
const P072 = join(MIGRATIONS_DIR, M072_NAME);
const m072 = readFileSync(P072, 'utf8');

const active072 = activeSql(m072);
const norm072 = normalizeSql(active072);
const exec072 = executableSql(m072);

function functionBody(name: string): string {
  const src = sqlFunctionSource(m072, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

const RPCS = [
  'phoenix_can_read_inventory_signal',
  'phoenix_inventory_fefo_pick',
  'phoenix_recompute_inventory_alerts',
  'phoenix_acknowledge_inventory_alert',
  'phoenix_resolve_inventory_alert',
  'phoenix_dismiss_inventory_alert',
  'phoenix_suggest_inventory_transfers',
  'phoenix_accept_inventory_transfer_suggestion',
  'phoenix_reject_inventory_transfer_suggestion',
  'phoenix_upsert_inventory_threshold',
] as const;

const TABLES = [
  'inventory_signal_thresholds',
  'inventory_alerts',
  'inventory_transfer_suggestions',
] as const;

// ============================================================================
// 1. Presence, registration, transaction wrapper, manual-apply header
// ============================================================================
describe('1. migration 072 exists once, is registered, and is manual-apply-only', () => {
  it('the file exists on disk with the exact expected name', () => {
    expect(() => readFileSync(P072, 'utf8')).not.toThrow();
  });

  it('is registered in the reviewed-migration manifest by exact name', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M072_NAME);
  });

  it('is wrapped in a single begin/commit transaction', () => {
    expect(exec072.trimStart().toUpperCase().startsWith('BEGIN')).toBe(true);
    expect(exec072.trimEnd().toUpperCase().endsWith('COMMIT;')).toBe(true);
  });

  it('states manual-apply-only and NOT APPLIED, matching 060-071 convention', () => {
    expect(m072).toMatch(/MANUAL APPLY ONLY/);
    expect(m072).toMatch(/NOT APPLIED/);
  });

  it('runs preconditions that abort if the 065/067 stock tables are absent', () => {
    expect(m072).toContain("to_regclass('public.warehouse_stock') IS NULL");
    expect(m072).toContain("to_regclass('public.outlet_stock') IS NULL");
    expect(m072).toMatch(/ABORT 072:/);
  });

  it('requires the 062 authz helper before it will apply', () => {
    expect(m072).toContain("to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL");
  });
});

// ============================================================================
// 2. Additive-only: no ALTER/DROP/REVOKE against pre-existing objects
// ============================================================================
describe('2. additive-only over the existing schema', () => {
  it('never ALTERs warehouse_stock or outlet_stock', () => {
    expect(norm072).not.toMatch(/ALTER TABLE public\.warehouse_stock\b/i);
    expect(norm072).not.toMatch(/ALTER TABLE public\.outlet_stock\b/i);
  });

  it('the only DROP statements are DROP POLICY IF EXISTS for its own new policies', () => {
    // Real object-DROP statements only — not the `ON COMMIT DROP` temp-table clause.
    const drops = active072.match(/\bDROP\s+(TABLE|VIEW|FUNCTION|POLICY|INDEX|TRIGGER|TYPE|SCHEMA|CONSTRAINT|SEQUENCE)\b/gi) ?? [];
    for (const d of drops) {
      expect(d.replace(/\s+/g, ' ').toUpperCase()).toBe('DROP POLICY');
    }
  });

  it('creates exactly the three intelligence tables and no others', () => {
    const created = [...active072.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/gi)].map(m => m[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
  });
});

// ============================================================================
// 3. Signal vocabulary is EXACTLY the five required values
// ============================================================================
describe('3. the five signal types and nothing more', () => {
  it('inventory_alerts.signal_type CHECK is exactly missing/low_stock/surplus/near_expiry/expired', () => {
    expect(norm072).toMatch(
      /CHECK \(signal_type IN \(\s*'missing', 'low_stock', 'surplus', 'near_expiry', 'expired'\s*\)\)/,
    );
  });

  it('recompute classifies all five signals', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    for (const sig of ['missing', 'low_stock', 'surplus', 'near_expiry', 'expired']) {
      expect(body, sig).toContain(`'${sig}'`);
    }
  });

  it('date signals are per-batch, quantity signals are per-material (batch guard CHECK present)', () => {
    expect(m072).toContain('inventory_alerts_batch_signal_chk');
    expect(norm072).toMatch(/signal_type IN \('near_expiry', 'expired'\) AND expiry_date IS NOT NULL/);
  });
});

// ============================================================================
// 4. FEFO — earliest usable expiry first, undated last, never expired
// ============================================================================
describe('4. FEFO ordering is first-expiry-first-out', () => {
  it('the FEFO pick orders by expiry ASC with NULLs last', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/ORDER BY .*expiry_date ASC NULLS LAST/i);
  });

  it('FEFO never picks an already-expired batch', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/expiry_date >= current_date/i);
    expect(body).toMatch(/available_quantity > 0/i);
  });

  it('the suggestion RPC attaches a FEFO batch to each match', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toContain('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/fefo_batch_number/i);
  });
});

// ============================================================================
// 5. Thresholds are optional config, never guessed
// ============================================================================
describe('5. thresholds gate the quantity signals; nothing is invented', () => {
  it('low_stock/missing require a reorder_point; surplus requires a target_max', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/reorder_point IS NOT NULL/);
    expect(body).toMatch(/target_max\s+IS NOT NULL/);
  });

  it('a scope-specific / code-specific threshold outranks the org-wide default', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/ORDER BY .*specificity DESC/i);
  });

  it('the threshold band CHECK forbids target_max below reorder_point', () => {
    expect(m072).toContain('inventory_thresholds_band_chk');
    expect(norm072).toMatch(/target_max >= reorder_point/);
  });

  it('near_expiry defaults to the 270-day (9-month) window, matching 048', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/v_default_near integer := 270/);
  });
});

// ============================================================================
// 6. Deduplication — one row per distinct signal / suggestion
// ============================================================================
describe('6. dedup by key, upsert not duplicate', () => {
  it('inventory_alerts has a UNIQUE index on alert_key', () => {
    expect(m072).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS inventory_alerts_alert_key_uniq[\s\S]*?\(alert_key\)/);
  });

  it('inventory_transfer_suggestions has a UNIQUE index on suggestion_key', () => {
    expect(m072).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS inventory_suggestions_key_uniq[\s\S]*?\(suggestion_key\)/);
  });

  it('thresholds have a COALESCE-folded identity unique (org-wide + no-code cannot duplicate)', () => {
    expect(m072).toContain('inventory_thresholds_identity_uniq');
    expect(m072).toMatch(/COALESCE\(scope_id, '00000000-0000-0000-0000-000000000000'::uuid\)/);
  });

  it('recompute upserts on conflict rather than inserting duplicates', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/ON CONFLICT \(alert_key\) DO UPDATE/i);
  });
});

// ============================================================================
// 7. Alert lifecycle — open->ack->resolved/dismissed, reasons required, auto-resolve
// ============================================================================
describe('7. full alert lifecycle with auto-resolve', () => {
  it('status vocabulary matches the established open/acknowledged/in_progress/resolved/dismissed set', () => {
    expect(norm072).toMatch(
      /status[\s\S]*?CHECK \(status IN \('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed'\)\)/,
    );
  });

  it('resolved and dismissed each require a non-empty reason', () => {
    expect(m072).toContain('inventory_alerts_resolve_reason_chk');
    expect(m072).toContain('inventory_alerts_dismiss_reason_chk');
  });

  it('recompute auto-resolves an open alert whose condition has cleared', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/SET status = 'resolved'/);
    expect(body).toMatch(/auto_resolved = true/);
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM _inv_now/i);
  });

  it('lifecycle RPCs are IDOR-gated on the locked row and scoped-permission checked', () => {
    for (const fn of ['phoenix_acknowledge_inventory_alert', 'phoenix_resolve_inventory_alert', 'phoenix_dismiss_inventory_alert']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/FOR UPDATE/i);
      expect(body, fn).toContain("'inventory.manage_alerts'");
    }
  });
});

// ============================================================================
// 8. Advisory ONLY — a suggestion moves no stock, ever
// ============================================================================
describe('8. transfer suggestions never execute a physical move', () => {
  it('accept-suggestion writes only the suggestion row, no stock/movement/dispatch table', () => {
    const body = functionBody('phoenix_accept_inventory_transfer_suggestion');
    expect(body).toMatch(/status = 'accepted'/);
    expect(body).not.toMatch(/INSERT INTO public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)\b/i);
    expect(body).not.toMatch(/UPDATE public\.(warehouse_stock|outlet_stock)\b/i);
  });

  it('the whole migration never writes a physical stock table outside its own new tables', () => {
    // No INSERT/UPDATE of warehouse_stock or outlet_stock anywhere in 072.
    expect(norm072).not.toMatch(/INSERT INTO public\.(warehouse_stock|outlet_stock)\b/i);
    expect(norm072).not.toMatch(/UPDATE public\.(warehouse_stock|outlet_stock)\b/i);
  });

  it('§14 post-condition actively forbids accept/recompute from moving stock', () => {
    expect(m072).toMatch(/accept-suggestion must not move stock/);
    expect(m072).toMatch(/recompute must not write physical stock/);
  });

  it('a suggestion cannot target the scope it already sits in', () => {
    expect(m072).toContain('inventory_suggestions_distinct_scope_chk');
  });
});

// ============================================================================
// 9. Scoped to the concerned organization only (RLS)
// ============================================================================
describe('9. RLS scopes every row to its own organization', () => {
  it('enables RLS on all three tables', () => {
    for (const t of TABLES) {
      expect(m072).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
  });

  it('each SELECT policy gates on phoenix_can_read_inventory_signal', () => {
    const policies = active072.match(/CREATE POLICY \w+_select_scoped/gi) ?? [];
    expect(policies.length).toBe(3);
    expect(active072).toMatch(/USING \(public\.phoenix_can_read_inventory_signal\(organization_id, scope_kind, scope_id\)\)/);
  });

  it('the read gate requires auth and a scoped view_signals permission (or super_admin)', () => {
    const body = functionBody('phoenix_can_read_inventory_signal');
    expect(body).toMatch(/auth\.uid\(\) IS NOT NULL/);
    expect(body).toContain("'inventory.view_signals'");
    expect(body).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
  });

  it('a suggestion is visible to either its source or its target scope', () => {
    expect(active072).toMatch(
      /phoenix_can_read_inventory_signal\(organization_id, source_scope_kind, source_scope_id\)\s*OR\s*public\.phoenix_can_read_inventory_signal\(organization_id, target_scope_kind, target_scope_id\)/,
    );
  });
});

// ============================================================================
// 10. ACL — authenticated reads via RLS only, writes RPC-only, anon nothing
// ============================================================================
describe('10. grant hygiene', () => {
  it('authenticated is granted SELECT but has INSERT/UPDATE/DELETE revoked on every table', () => {
    for (const t of TABLES) {
      expect(m072).toMatch(new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated`));
      expect(m072).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`));
    }
  });

  it('anon has ALL revoked on every table', () => {
    for (const t of TABLES) {
      expect(m072).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });

  it('every RPC revokes from PUBLIC, anon and grants execute to authenticated only', () => {
    for (const fn of RPCS) {
      expect(m072, `${fn} REVOKE`).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*FROM PUBLIC, anon`));
      expect(m072, `${fn} GRANT`).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*TO authenticated`));
    }
  });

  it('no function or table is ever granted to anon or PUBLIC', () => {
    // Only role targets after `TO` matter — the `public.` schema qualifier is not
    // a grant target. Every GRANT in 072 targets `authenticated`.
    expect(exec072).not.toMatch(/\bTO\s+(anon|public)\b/i);
  });

  it('every RPC is SECURITY DEFINER with a pinned search_path', () => {
    for (const fn of RPCS) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/SECURITY DEFINER/i);
      expect(body, fn).toMatch(/SET search_path = public, pg_temp/i);
    }
  });
});

// ============================================================================
// 11. Frugal by design — free-plan safe
// ============================================================================
describe('11. frugal: no images, no snapshots/cron, no WhatsApp', () => {
  it('declares no image/photo/blob/attachment column on any new table', () => {
    expect(norm072).not.toMatch(/\b(image|photo|blob|attachment|snapshot_url)\b\s+(text|bytea|uuid|jsonb)/i);
  });

  it('has no cron / pg_cron / scheduled-job dependency', () => {
    // exec072 has comments stripped and string literals blanked, so the header's
    // "NO pg_cron" prose cannot satisfy this — only a real dependency would.
    expect(exec072).not.toMatch(/pg_cron|cron\.schedule|CREATE\s+EXTENSION/i);
  });

  it('has no WhatsApp / messaging fan-out (comments and §14 token literal excluded)', () => {
    expect(exec072).not.toMatch(/whatsapp|twilio|sendgrid|nodemailer|smtp/i);
  });

  it('§14 verifies the frugal contract (no forbidden columns)', () => {
    expect(m072).toMatch(/forbidden image\/whatsapp\/attachment column/);
  });

  it('recompute is on-demand (an RPC), not a trigger or scheduled job', () => {
    expect(m072).not.toMatch(/CREATE TRIGGER/i);
  });
});

// ============================================================================
// 12. Permission catalog seeding + enforcement stays OFF
// ============================================================================
describe('12. RBAC catalog registration, enforcement unchanged', () => {
  it('registers the four inventory permission keys idempotently', () => {
    for (const key of ['inventory.view_signals', 'inventory.recompute', 'inventory.manage_alerts', 'inventory.suggest_transfers']) {
      expect(m072, key).toContain(`'${key}'`);
    }
    expect(m072).toMatch(/INSERT INTO public\.permission_keys[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
  });

  it('seeds role defaults idempotently (ON CONFLICT DO NOTHING)', () => {
    expect(m072).toMatch(/INSERT INTO public\.role_permission_defaults[\s\S]*?ON CONFLICT \(role, permission_key\) DO NOTHING/);
  });

  it('separation of duty: outlet_officer views only, warehouse/institution roles drive recompute/suggest', () => {
    expect(m072).toMatch(/\('outlet_officer',\s*'inventory\.recompute',\s*false\)/);
    expect(m072).toMatch(/\('outlet_officer',\s*'inventory\.suggest_transfers',\s*false\)/);
    expect(m072).toMatch(/\('warehouse_officer',\s*'inventory\.recompute',\s*true\)/);
  });

  it('changes no RBAC enforcement flag — enforcement stays OFF', () => {
    // It may DISCUSS enforcement in comments, but must not flip an enforcement flag.
    expect(norm072).not.toMatch(/rbac_enforc|permission_enforc|set_enforcement|enforcement_enabled/i);
    expect(m072).toMatch(/Enforcement stays OFF|ENFORCEMENT STAYS OFF/i);
  });
});

// ============================================================================
// 13. Every named RPC actually exists as a CREATE FUNCTION
// ============================================================================
describe('13. all ten RPCs are present', () => {
  it('each RPC exists as a CREATE FUNCTION in the migration', () => {
    for (const fn of RPCS) {
      expect(sqlFunctionSource(m072, fn), fn).not.toBeNull();
    }
  });

  it('recompute and suggest serialize per-org with an advisory xact lock', () => {
    expect(functionBody('phoenix_recompute_inventory_alerts')).toMatch(/pg_advisory_xact_lock/i);
    expect(functionBody('phoenix_suggest_inventory_transfers')).toMatch(/pg_advisory_xact_lock/i);
  });
});

// ============================================================================
// 14. Post-condition (§14) VERIFY block asserts the promised shape
// ============================================================================
describe('14. the migration verifies itself at apply time', () => {
  it('asserts all three tables exist with RLS enabled', () => {
    expect(m072).toMatch(/VERIFY FAILED \(072\): table % missing/);
    expect(m072).toMatch(/VERIFY FAILED \(072\): RLS not enabled/);
  });

  it('asserts the dedup uniques and lifecycle reason guards exist', () => {
    expect(m072).toMatch(/a dedup unique index is missing/);
    expect(m072).toMatch(/a lifecycle reason guard is missing/);
  });

  it('asserts authenticated has no direct write and anon cannot read', () => {
    expect(m072).toMatch(/authenticated has direct write on inventory_alerts/);
    expect(m072).toMatch(/anon can read inventory intelligence/);
  });

  it('§14i resolves each ::regprocedure by its FULL signature (071 regression lesson)', () => {
    // The bare-name form aborts the migration; every cast must be parenthesised.
    const bare = m072.match(/'[a-z0-9_.]+'::regprocedure/gi) ?? [];
    expect(bare, `bare-name regprocedure casts: ${bare.join(', ')}`).toEqual([]);
  });
});
