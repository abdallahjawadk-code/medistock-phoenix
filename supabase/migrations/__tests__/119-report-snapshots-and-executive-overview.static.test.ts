/**
 * REPORT-SNAPSHOTS-AND-EXECUTIVE-OVERVIEW-119 — static contract.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const sql = readFileSync(
  join(__dirname, '../119_phoenix_report_snapshots_and_executive_overview.sql'),
  'utf8',
);

describe('119 — report snapshots and executive overview contract', () => {
  it('the snapshot table is INSERT-only for authenticated, with no write policy', () => {
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_report_snapshots FROM authenticated');
    expect(sql).toContain('GRANT SELECT ON TABLE public.phoenix_report_snapshots TO authenticated');
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)[^;]*ON public\.phoenix_report_snapshots/);
  });

  it('mutation is forbidden outright by trigger, not merely by grants', () => {
    expect(sql).toContain('report_snapshot_is_immutable');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON public.phoenix_report_snapshots');
  });

  it('official numbering is server-owned (090 trigger-stamp pattern), never client-supplied', () => {
    expect(sql).toContain('CREATE SEQUENCE public.phoenix_report_snapshot_number_seq');
    expect(sql).toContain('REVOKE ALL ON SEQUENCE public.phoenix_report_snapshot_number_seq FROM PUBLIC, anon, authenticated');
    expect(sql).toContain("'RP-' || to_char(now(), 'YYYY') || '-' ||");
    expect(sql).toContain('BEFORE INSERT ON public.phoenix_report_snapshots');
  });

  it('the executive overview aggregates existing classification/provenance columns — no new classification math', () => {
    expect(sql).not.toMatch(/reorder_point|target_max/);
    expect(sql).toContain('FROM public.item_availability');
    expect(sql).toContain("GROUP BY condition");
    expect(sql).toContain("WHEN supply_type = 'purchase' THEN 'purchase_' || purchase_origin");
  });

  it('both RPCs require reports.view scoped to the target organization', () => {
    const overviewFn = sql.slice(sql.indexOf('FUNCTION public.phoenix_executive_overview'), sql.indexOf('FUNCTION public.phoenix_create_report_snapshot'));
    expect(overviewFn).toContain("'reports.view', p_organization_id, NULL, NULL");
    const snapshotFn = sql.slice(sql.indexOf('FUNCTION public.phoenix_create_report_snapshot'));
    expect(snapshotFn).toContain("'reports.view', p_organization_id, NULL, NULL");
  });

  it('the snapshot payload is produced by calling the live overview function itself', () => {
    expect(sql).toContain('v_payload := public.phoenix_executive_overview(p_organization_id);');
  });

  it('the QR payload uses a namespaced, opaque, versioned code (no balance/material data)', () => {
    expect(sql).toContain("'phxrpt:1:' || v_qr_code || ':' || v_new_id::text");
  });

  it('is idempotent on request id with a sha256 hex fingerprint', () => {
    expect(sql).toContain('pg_advisory_xact_lock(hashtextextended(p_request_id::text, 119119))');
    expect(sql).toContain('request_id_conflict');
    expect(sql).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
  });
});
