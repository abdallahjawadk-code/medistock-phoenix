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
