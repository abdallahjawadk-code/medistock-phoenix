import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const service = read('shared/supabase/services/availability.service.ts');
const institution = read('features/institutions/InstitutionScreen.tsx');

function functionBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Stage G G1 · canonical authenticated availability read cutover', () => {
  it('getAvailabilityByPoint delegates to Migration-176 CQRS instead of reading item_availability directly', () => {
    const body = functionBody(
      service,
      'export async function getAvailabilityByPoint',
      'export async function upsertAvailability',
    );
    expect(body).toContain("supabase.rpc('phoenix_outlet_availability_read_model'");
    expect(body).toContain('p_distribution_point_id: pointId');
    expect(body).not.toContain(".from('item_availability')");
    expect(body).not.toContain('.select(`');
  });

  it('preserves the existing AvailabilityRecord contract and effective-status mapping', () => {
    const body = functionBody(
      service,
      'export async function getAvailabilityByPoint',
      'export async function upsertAvailability',
    );
    expect(body).toContain('Promise<(AvailabilityRecord & EffectiveAvailabilityFields)[]>');
    expect(body).toContain('withEffectiveAvailabilityStatus(r)');
  });

  it('keeps InstitutionScreen on the shared service and visibility-only filtering', () => {
    expect(institution).toContain('getAvailabilityByPoint,');
    const start = institution.indexOf('function PortAvailabilitySection');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = institution.slice(start);
    expect(section).toContain('getAvailabilityByPoint(pointId)');
    expect(section).toContain('filter(r => r.removed_at == null)');
  });

  it('does not resurrect a manual availability writer in InstitutionScreen', () => {
    const start = institution.indexOf('function PortAvailabilitySection');
    const section = institution.slice(start);
    expect(section).not.toContain('upsertAvailability(');
    expect(section).not.toContain('applyAvailabilityMovement(');
  });
});
