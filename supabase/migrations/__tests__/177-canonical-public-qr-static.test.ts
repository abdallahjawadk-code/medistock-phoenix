import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname,'..','177_phoenix_canonical_public_qr.sql'),'utf8');

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
    expect(sql).toContain('FROM public.outlet_stock s');
    expect(sql).toContain('ia.removed_at IS NOT NULL');
    expect(sql).not.toContain('ia.quantity');
    expect(sql).not.toContain('ia.condition');
    expect(sql).toContain('phoenix_derive_outlet_availability_condition');
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