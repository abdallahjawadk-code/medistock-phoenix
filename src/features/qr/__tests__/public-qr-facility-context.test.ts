/**
 * QR-FACILITY-CONTEXT-188
 *
 * Public QR screen must render a server-derived Health Center context only
 * where it really exists; it must never fabricate one from names.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { publicQrFacilityLabel } from '../PublicQrScreen';

const ROOT = join(__dirname, '../../../../');
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

type LabelPayload = Parameters<typeof publicQrFacilityLabel>[0];

const screen = readRoot('src/features/qr/PublicQrScreen.tsx');
const qrService = readRoot('src/shared/supabase/services/qr.service.ts');
const migration = readRoot('supabase/migrations/188_phoenix_public_qr_facility_context.sql');

describe('public QR facility context (M188)', () => {
  it('labels Arabic facility with Arabic name, English with English name', () => {
    expect(publicQrFacilityLabel({
      facility_id: 'f1', facility_name: 'Centre', facility_name_ar: 'مركز',
    }, 'ar')).toBe('مركز');
    expect(publicQrFacilityLabel({
      facility_id: 'f1', facility_name: 'Centre', facility_name_ar: 'مركز',
    }, 'en')).toBe('Centre');
  });

  it('falls back across languages when the primary name is empty/whitespace', () => {
    expect(publicQrFacilityLabel({
      facility_id: 'f1', facility_name: '   ', facility_name_ar: 'مركز',
    }, 'en')).toBe('مركز');
    expect(publicQrFacilityLabel({
      facility_id: 'f1', facility_name: 'Centre', facility_name_ar: '  ',
    }, 'ar')).toBe('Centre');
  });

  it('returns null (hides the line) when there is no structural facility', () => {
    expect(publicQrFacilityLabel(null, 'en')).toBeNull();
    expect(publicQrFacilityLabel({
      facility_id: null, facility_name: null, facility_name_ar: null,
    } as unknown as LabelPayload, 'en')).toBeNull();
    expect(publicQrFacilityLabel({
      facility_id: '', facility_name: 'Centre', facility_name_ar: 'مركز',
    } as unknown as LabelPayload, 'en')).toBeNull();
    expect(publicQrFacilityLabel({
      facility_id: 'f1', facility_name: '', facility_name_ar: '',
    }, 'en')).toBeNull();
  });

  it('the service exports a typed PublicQrPayload with additive facility fields', () => {
    expect(qrService).toContain('export interface PublicQrPayload');
    expect(qrService).toContain("target_type?: 'distribution_point' | 'warehouse' | 'local_item'");
    expect(qrService).toContain('facility_id?: string | null');
    expect(qrService).toContain('facility_name?: string | null');
    expect(qrService).toContain('facility_name_ar?: string | null');
  });

  it('the screen renders facility context only through the server-derived helper', () => {
    expect(screen).toContain('publicQrFacilityLabel(payload, lang)');
    expect(screen).toContain('payload.facility_id');
    expect(screen).toContain('payload.facility_name');
    expect(screen).toContain('dir="auto"');
    // The same no-name-inference rule is enforced on the client side.
    expect(screen).not.toMatch(/facility.*match|match.*facility|ILIKE.*facility/i);
  });

  it('the migration derives facility ancestry from structural IDs, not names', () => {
    const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
    const fnEnd = migration.indexOf('$function$;', fnStart);
    const fnBody = migration.slice(fnStart, fnEnd);
    expect(fnBody).toContain('JOIN public.organization_facilities f');
    expect(fnBody).toContain('ON f.id = w.facility_id');
    expect(fnBody).not.toMatch(/name\s+ILIKE\s+'%/i);
    expect(fnBody).not.toMatch(/name_ar\s+ILIKE\s+'%/i);
  });
});
