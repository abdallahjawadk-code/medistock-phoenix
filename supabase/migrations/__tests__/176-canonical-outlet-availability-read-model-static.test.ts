import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname,'..','176_phoenix_canonical_outlet_availability_read_model.sql'),'utf8');

describe('176 · canonical outlet availability read model (static)',()=>{
  it('adds one authenticated CQRS RPC whose physical truth is outlet_stock only',()=>{
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model');
    expect(sql).toContain('FROM public.outlet_stock s');
    expect(sql).toContain('FROM public.item_availability ia');
    expect(sql).toContain('public.phoenix_derive_outlet_availability_condition');
    expect(sql).not.toContain('ia.quantity');
    expect(sql).not.toContain('ia.condition');
  });

  it('makes compatibility catalogue metadata optional instead of a stock-visibility prerequisite',()=>{
    expect(sql).toContain('FULL OUTER JOIN catalogue ia');
    expect(sql).not.toContain('availability_projection_cache_mismatch');
    expect(sql).toContain("j.catalogue_id AS catalogue_item_availability_id");
    expect(sql).toContain("ELSE 'stock:'||md5");
  });

  it('never substitutes a stock id for the nullable catalogue id',()=>{
    expect(sql).toContain('j.catalogue_id AS id');
    expect(sql).toContain('j.catalogue_id AS catalogue_item_availability_id');
    expect(sql).not.toMatch(/(?:catalogue_item_availability_id|\bAS id\b)[\s\S]{0,80}\boutlet_stock\.id/i);
  });

  it('preserves exact visible batch identity when cache metadata exists',()=>{
    expect(sql).toContain('ia.internal_batch_reference_key=c.internal_batch_reference_key');
    expect(sql).toContain("COALESCE(s.internal_batch_reference,'') AS internal_batch_reference_key");
    expect(sql).toContain("'removed_at', s.removed_at");
    expect(sql).toContain("'canonical_available_quantity', s.canonical_available_quantity");
  });

  it('is read-only and never mutates stock/cache/RLS/QR',()=>{
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b|\bDROP\s+POLICY\b/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_public_qr_payload/i);
  });

  it('keeps least privilege and public QR',()=>{
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM PUBLIC;');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role;');
    const qrChecks=sql.match(/has_function_privilege\('anon','public\.get_public_qr_payload\(text\)'::regprocedure,'EXECUTE'\)/g)??[];
    expect(qrChecks.length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toMatch(/REVOKE[^;]*get_public_qr_payload/is);
  });
});