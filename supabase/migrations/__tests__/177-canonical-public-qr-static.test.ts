import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname,'..','177_phoenix_canonical_public_qr.sql'),'utf8');

/**
 * The EXECUTABLE QR implementation only — everything between `AS $function$`
 * and its closing `$function$;`.
 *
 * Scanning the whole FILE for forbidden expressions cannot work here: the
 * migration's own runtime VERIFY block legitimately contains them as ILIKE
 * patterns (`v_def ILIKE '%ia.quantity%'`) precisely in order to REJECT them.
 * A whole-file scan therefore matches the very guard that protects the
 * contract. The fix is to isolate the implementation — never to weaken or
 * delete the guard, which is asserted to still exist further below.
 */
const fnBody = (() => {
  const open = sql.indexOf('AS $function$');
  const close = sql.indexOf('$function$;', open + 1);
  if (open === -1 || close === -1) throw new Error('177: could not isolate the $function$ body');
  return sql.slice(open, close);
})();

describe('177 · canonical public QR (static)',()=>{
  it('keeps the same public RPC boundary and all three target types',()=>{
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload(p_public_id text)');
    expect(sql).toContain("WHEN 'distribution_point' THEN");
    expect(sql).toContain("WHEN 'warehouse' THEN");
    expect(sql).toContain("WHEN 'local_item' THEN");
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
  });

  it('uses outlet_stock as physical truth and cache only for removed visibility',()=>{
    // Asserted against the IMPLEMENTATION, not the whole file — see fnBody.
    expect(fnBody).toContain('FROM public.outlet_stock s');
    expect(fnBody).toContain('ia.removed_at IS NOT NULL');
    expect(fnBody).toContain('phoenix_derive_outlet_availability_condition');
    // item_availability must never supply PHYSICAL quantity or condition; it
    // is catalogue-visibility metadata (removed_at) only.
    expect(fnBody).not.toContain('ia.quantity');
    expect(fnBody).not.toContain('ia.condition');
  });

  it('groups every branch on the canonical Migration-150 material identity',()=>{
    // outlet_stock.material_identity_key is the GENERATED ALWAYS canonical key
    // over (central_item_id, scientific_name, national_code, concentration,
    // dosage_form, unit). Grouping on it — rather than on a hand-rebuilt tuple
    // of raw columns — is what makes case/whitespace variants aggregate and
    // unit-distinct identities stay apart.
    expect(fnBody).toContain('GROUP BY s.material_identity_key');
    expect(fnBody).toContain('GROUP BY s.distribution_point_id,s.material_identity_key');
    expect(fnBody).toContain('public._phoenix_material_identity_v1(');
    // The pre-remediation raw-tuple grouping must never return.
    expect(fnBody).not.toContain('GROUP BY s.central_item_id,s.scientific_name');
    expect(fnBody).not.toContain("coalesce(s.unit,'') AS unit_key");
  });

  it('matches catalogue removal exactly, never fuzzily, and fails safe when ambiguous',()=>{
    // item_availability cannot express unit and its local_item_id is nullable,
    // so a marker may not resolve one canonical identity. It hides only when it
    // resolves exactly one, and central item is constrained only when proven.
    expect(fnBody).not.toContain('OR coalesce(ia.scientific_name');
    expect(fnBody).toContain('HAVING count(DISTINCT c.material_identity_key)=1');
    expect(fnBody).toContain('m.proven_central_item_id IS NULL');
    expect(fnBody).toContain('ia.removed_at IS NOT NULL');
  });

  it('keeps the runtime VERIFY guards that protect canonical identity',()=>{
    expect(sql).toContain("v_def NOT ILIKE '%GROUP BY s.material_identity_key%'");
    expect(sql).toContain("v_def ILIKE '%OR coalesce(ia.scientific_name%'");
    expect(sql).toContain("v_def NOT ILIKE '%HAVING count(DISTINCT c.material_identity_key)=1%'");
    expect(sql).toContain("v_def NOT ILIKE '%min(s.unit) AS unit%'");
  });

  it('publishes a per-identity unit on local_item availability rows',()=>{
    // Quantity without its unit is unattributable: two unit-distinct identities
    // would surface as bare "5" and "3". The unit must come from the canonical
    // stock identity, never from the local item's single central unit.
    const localItem = fnBody.slice(fnBody.indexOf("WHEN 'local_item' THEN"));
    expect(localItem).toContain('min(s.unit) AS unit');
    expect(localItem).toContain("'unit',NULLIF(s.unit,'')");
  });

  it('keeps the runtime VERIFY guard that rejects cache-as-physical-truth',()=>{
    // The whole point of isolating fnBody above is that this guard is allowed
    // — indeed required — to mention the forbidden expressions. If a future
    // edit silences the static check by deleting the runtime guard instead of
    // fixing the implementation, this fails.
    expect(sql).toContain("v_def ILIKE '%ia.quantity%'");
    expect(sql).toContain("v_def ILIKE '%ia.condition%'");
  });

  it('preserves anonymous access and scan accounting',()=>{
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.get_public_qr_payload(text) TO anon;");
    expect(sql).toContain('scan_count = scan_count + 1');
    expect(sql).toContain('last_scanned_at = now()');
  });

  it('preserves public privacy curation',()=>{
    for (const key of ['batch_number','national_code','price','trade_name','notes','actor_name_snapshot','actor_email_snapshot']) {
      expect(sql).not.toContain(`'${key}',`);
    }
    expect(sql).toContain("'quantity',CASE WHEN s.effective_condition='expired' THEN NULL ELSE s.available_quantity END");
    expect(sql).toContain("'expiry_date',CASE WHEN s.effective_condition IN ('near_expiry','expired') THEN s.expiry_date ELSE NULL END");
  });

  it('never mutates inventory, catalogue rows, RLS, or indexes',()=>{
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b|\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b/i);
  });
});
