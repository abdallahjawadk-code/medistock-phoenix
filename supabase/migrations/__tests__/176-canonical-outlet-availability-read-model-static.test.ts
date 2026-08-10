import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '..', '176_phoenix_canonical_outlet_availability_read_model.sql'),
  'utf8',
);

describe('176 · canonical outlet availability read model (static)', () => {
  it('adds one authenticated CQRS read RPC and does not replace stock truth', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model');
    expect(sql).toContain('FROM public.outlet_stock s');
    expect(sql).toContain('FROM public.item_availability ia');
    expect(sql).toContain('public.phoenix_derive_outlet_availability_condition');
    expect(sql).not.toContain('ia.quantity');
    expect(sql).not.toContain('ia.condition');
  });

  it('uses item_availability only as compatibility metadata and preserves exact batch identity', () => {
    expect(sql).toContain("COALESCE(ia.internal_batch_reference, '') = c.internal_batch_reference_key");
    expect(sql).toContain("COALESCE(s.internal_batch_reference, '') AS internal_batch_reference_key");
    expect(sql).toContain("'removed_at', s.removed_at");
    expect(sql).toContain("'notes', s.notes");
    expect(sql).toContain("'canonical_available_quantity', s.canonical_available_quantity");
  });

  it('fails closed rather than silently hiding canonical stock without a cache identity', () => {
    expect(sql).toContain("RAISE EXCEPTION 'availability_projection_cache_mismatch'");
    expect(sql).toContain("USING ERRCODE = '23514'");
  });

  it('is read-only and never mutates stock, availability, RLS, or QR', () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+public\.(?:outlet_stock|item_availability)\b/i);
    expect(sql).not.toMatch(/\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b|\bDROP\s+POLICY\b/i);
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_public_qr_payload/i);
  });

  it('keeps the read model least-privileged while explicitly preserving service use', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM PUBLIC;');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role;');
  });

  it('pins anonymous public QR as a precondition and postcondition', () => {
    const qrChecks = sql.match(/has_function_privilege\('anon',\s*'public\.get_public_qr_payload\(text\)'::regprocedure,\s*'EXECUTE'\)/g) ?? [];
    expect(qrChecks.length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toMatch(/REVOKE[^;]*get_public_qr_payload/is);
  });
});
