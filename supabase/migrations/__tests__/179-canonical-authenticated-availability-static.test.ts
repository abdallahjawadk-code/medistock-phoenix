/**
 * STAGE-G-G3.1 (179) — static contract of the authenticated availability
 * hardening. Guards the SHAPE of the migration so a later edit cannot quietly
 * reintroduce raw-column physical grouping, add a catalogue unit fallback, or
 * let the item_availability cache become physical stock truth again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..');
const NAME = '179_phoenix_canonical_authenticated_availability_hardening.sql';
const sql = readFileSync(join(MIGRATIONS, NAME), 'utf8');
/** Executable SQL only — the header prose deliberately quotes the OLD grouping
 *  and the rejected catalogue-fallback shapes, and must not trip these guards. */
const exec = sql.replace(/--[^\n]*/g, '');
/** Just the replaced function body. */
const fn = exec.slice(exec.indexOf('CREATE OR REPLACE FUNCTION'), exec.indexOf('$function$;'));
/** Whitespace-flattened body, so multi-line SQL can be asserted verbatim
 *  without the assertion depending on the checkout's line endings (cf. the
 *  CRLF-portability guard below). */
const flat = fn.replace(/\s+/g, ' ');

describe('179 · canonical authenticated availability hardening (static)', () => {
  it('replaces exactly the Migration-176 read model and nothing else', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model(p_distribution_point_id uuid)',
    );
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    // A read-model regrouping touches no table, policy, index or trigger.
    expect(exec).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(exec).not.toMatch(/CREATE (OR REPLACE )?(TABLE|VIEW|POLICY|INDEX|TRIGGER)/i);
    expect(exec).not.toMatch(/\bDROP\s+(TABLE|POLICY|TRIGGER|FUNCTION|INDEX)\b/i);
    expect(exec).not.toMatch(/ROW LEVEL SECURITY/i);
  });

  it('preserves the signature, security context and pinned search_path', () => {
    expect(sql).toContain('(p_distribution_point_id uuid)');
    expect(sql).toContain('RETURNS jsonb');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('STABLE');
  });

  it('groups physical rows on the canonical identity, not raw material columns', () => {
    expect(fn).toContain('s.material_identity_key');
    expect(fn).toMatch(/GROUP BY[^;]*s\.material_identity_key/);
    // The exact defective grouping from 176 must not survive: it re-derived
    // identity from scientific_name + COALESCE(...) material columns and left
    // `unit` out entirely, so 5 box + 3 strip summed to 8.
    expect(fn).not.toMatch(/GROUP BY s\.organization_id,s\.distribution_point_id,s\.scientific_name/);
  });

  it('publishes an additive row-level unit with NO catalogue fallback', () => {
    expect(fn).toContain("NULLIF(j.canonical_unit,'') AS unit");
    expect(fn).toContain("'unit', s.unit");
    // Neither direction of the forbidden fallback may appear.
    expect(fn).not.toMatch(/COALESCE\([^)]*canonical_unit[^)]*ci\.unit/i);
    expect(fn).not.toMatch(/COALESCE\([^)]*ci\.unit[^)]*canonical_unit/i);
    expect(fn).not.toMatch(/COALESCE\(\s*ci\.unit/i);
    // central_items.unit may still be published as catalogue metadata inside
    // local_items — that is the pre-existing 176 contract and is not the
    // physical row unit.
    expect(fn).toContain("'unit',ci.unit");
  });

  it('keeps item_availability out of physical quantity and condition', () => {
    expect(fn).toContain('COALESCE(j.available_quantity,0) AS quantity');
    expect(fn).not.toMatch(/COALESCE\(\s*ia\.quantity/i);
    expect(fn).not.toMatch(/COALESCE\(\s*ia\.condition/i);
    expect(fn).toContain('public.phoenix_derive_outlet_availability_condition(');
  });

  it('derives the stock row_key by LOSSLESS encoding, never by hashing', () => {
    expect(fn).toContain('canonical_row_key IS NOT NULL');
    expect(fn).toContain("'catalogue:'||j.catalogue_id::text");
    // The encoding IS the contract. This column advertises "unique per physical
    // row" to its consumers, and no finite digest can deliver that at any
    // width — md5 only makes a collision unlikely, and so does sha256.
    expect(flat).toContain(
      "'stock:v1:'||encode(convert_to(jsonb_build_array( " +
      'p_distribution_point_id::text, ' +
      's.material_identity_key, ' +
      "COALESCE(s.batch_number,''), " +
      "COALESCE(s.expiry_date,DATE '0001-01-01')::text, " +
      "COALESCE(s.internal_batch_reference,''))::text,'UTF8'),'hex')",
    );
    for (const forbidden of [/\bmd5\s*\(/i, /\bdigest\s*\(/i, /\bsha\d+\s*\(/i, /\bhashtext\s*\(/i]) {
      expect(fn, `hashed row identity: ${forbidden}`).not.toMatch(forbidden);
    }
    // concat_ws is genuinely ambiguous here: batch_number and
    // internal_batch_reference are free text and may contain the separator.
    expect(fn).not.toMatch(/concat_ws/i);
    // Nothing non-deterministic or non-persisted may enter the row identity.
    for (const forbidden of [/gen_random_uuid/i, /\bnow\s*\(\)/i, /clock_timestamp/i, /row_number/i]) {
      expect(fn, `non-deterministic row identity: ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('pairs catalogue metadata raw-first, then 150-normalized, then not at all', () => {
    // Migration 150's OWN normalization — not a second lower/btrim algorithm.
    expect(fn).toContain('public._phoenix_material_identity_component_v1(');
    expect(fn).not.toMatch(/lower\s*\(\s*btrim/i);
    // Step 1 (raw) must still exist and must win, so a pairing that already
    // worked is bit-for-bit unchanged.
    expect(flat).toContain('COALESCE(rm.catalogue_id,nm.catalogue_id) AS selected_catalogue_id');
    // Step 2 is fail-safe: an ambiguous normalized candidate set attaches
    // nothing rather than guessing, and can never multiply a physical row.
    expect(flat).toContain('HAVING count(*)=1');
    // The lot dimensions are matched EXACTLY on both paths — normalization is
    // scoped to the material components, exactly as Migration 150 scopes it.
    expect(flat).toContain('AND ia.batch_number_key=c.batch_number_key AND ia.expiry_date_key=c.expiry_date_key');
    expect(fn).not.toMatch(/_phoenix_material_identity_component_v1\(\s*ia\.batch_number/i);
    expect(fn).not.toMatch(/_phoenix_material_identity_component_v1\(\s*ia\.internal_batch_reference/i);
    // The pairing decision is made once, in `selected`; the outer join consumes
    // it by id and therefore cannot re-open a many-to-many.
    expect(flat).toContain('FULL OUTER JOIN catalogue ia ON ia.id=c.selected_catalogue_id');
    // item_availability has no unit column, so unit must never be a match key.
    expect(fn).not.toMatch(/ia\.unit/i);
  });

  it('does not repurpose id or catalogue_item_availability_id', () => {
    expect(fn).toContain('j.catalogue_id AS id');
    expect(fn).toContain('j.catalogue_id AS catalogue_item_availability_id');
  });

  it('preserves every response key the 176 contract already published', () => {
    for (const k of [
      'id', 'catalogue_item_availability_id', 'row_key', 'local_item_id',
      'distribution_point_id', 'organization_id', 'quantity', 'condition',
      'batch_number', 'national_code', 'expiry_date', 'notes', 'updated_at',
      'port_name', 'supply_type', 'removed_at', 'scientific_name', 'trade_name',
      'dosage_form', 'concentration', 'price', 'internal_batch_reference',
      'canonical_on_hand_quantity', 'canonical_available_quantity',
      'canonical_usable_quantity', 'local_items',
    ]) expect(fn, `response key ${k}`).toContain(`'${k}',`);
    expect(fn).toContain("'source','canonical_outlet_stock'");
  });

  it('keeps the ACL contract and never opens anon', () => {
    expect(exec).toContain('REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon');
    expect(exec).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated');
    expect(exec).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role');
    expect(exec).not.toMatch(/GRANT[^;]*TO\s+anon/i);
  });

  it('preserves organization scoping and point indistinguishability', () => {
    expect(fn).toContain("v_role='super_admin'");
    expect(fn).toContain('v_org=v_point_org');
    expect(fn).toContain("RAISE EXCEPTION 'not_authenticated'");
  });

  it('is transactional with preflight and fail-closed verify', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain('$preflight$');
    expect(sql).toContain('$verify$');
    expect(sql).toContain('179 preflight failed: outlet_stock.material_identity_key is missing or not GENERATED ALWAYS');
    expect(sql).toContain('179 verify failed: read model does not group on material_identity_key');
    expect(sql).toContain('179 verify failed: raw-column physical grouping was reintroduced');
    expect(sql).toContain('179 verify failed: physical unit can fall back to the catalogue unit');
    expect(sql).toContain('179 verify failed: anon gained EXECUTE on the authenticated read model');
    expect(sql).toContain('179 verify failed: stock row_key is not the lossless v1 encoding');
    expect(sql).toContain('179 verify failed: a hash reappeared in the physical row identity');
    expect(sql).toContain('179 verify failed: ambiguous catalogue candidates are no longer fail-safe');
    expect(sql).toContain('179 preflight failed: Migration-150 canonical component helper missing');
    // Step 1's "at most one raw candidate" is a proof only while this index
    // exists, so the migration pins it rather than assuming it.
    expect(sql).toContain('179 preflight failed: item_availability raw uniqueness index missing');
    expect(sql).toContain('item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq');
  });

  it('every verify assertion literal is single-line (CRLF-portable, cf. 162)', () => {
    const verify = sql.slice(sql.indexOf('$verify$'));
    const literals = [...verify.matchAll(/LIKE\s+'([^']*)'/g)].map(m => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const lit of literals) expect(lit).not.toContain('\n');
  });

  it('does not touch Migration 177 Public QR or Hotfix 178 territory', () => {
    // Both are asserted as PREconditions only — 179 must never redefine them.
    expect(exec).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/i);
    expect(exec).not.toMatch(/ADD CONSTRAINT/i);
    expect(exec).not.toMatch(/_phoenix_distribution_points_owner_kind_guard_v1\s*\(\s*\)\s*RETURNS/i);
    expect(sql).toContain('179 preflight failed: public QR anonymous contract is not intact');
    expect(sql).toContain('179 preflight failed: Hotfix-178 ownership FK is missing');
  });

  it('adds no third stock truth', () => {
    expect(fn).toContain('FROM public.outlet_stock s');
    expect(exec).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(exec).not.toMatch(/\bUPDATE\s+public\./i);
    expect(exec).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
