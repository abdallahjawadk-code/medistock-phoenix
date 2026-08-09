/**
 * STAGE-E-E7-2 — behavioral tests for `outletContextEligibility()`, the
 * UI-affordance mirror of the route-eligibility rules Migration 164's route
 * RPC and Migration 168's replenishment RPC both enforce server-side.
 *
 * Pure function, no mocking needed. Each case below corresponds to a rule
 * actually read from 164/168's own SQL (see the doc comment on the function),
 * and mirrors the exact scenarios proven against a real rig in
 * `supabase/migrations/__tests__/172-e7-2-stage-e-wiring.dynamic.test.ts`
 * section E — this file is the fast, no-rig-required companion, not a
 * replacement for that proof.
 */
import { describe, it, expect } from 'vitest';
import { outletContextEligibility } from '../emergency-replenishment.service';

describe('outletContextEligibility — SHAPE I (hospital / specialized_center, no facility layer)', () => {
  it('hospital + rescue_cart + emergency context: legal', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'rescue_cart',
      destinationClinicalLocationKind: 'emergency',
    });
    expect(r).toEqual({ eligible: true });
  });

  it('hospital + rescue_cart + NON-emergency context: rejected (rescue_cart_requires_emergency_context)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'rescue_cart',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'rescue_cart_requires_emergency_context' });
  });

  it('specialized_center + rescue_cart: rejected (rescue_cart_requires_hospital) — only a hospital may have one', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'specialized_center',
      destinationPointType: 'rescue_cart',
      destinationClinicalLocationKind: 'emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'rescue_cart_requires_hospital' });
  });

  it('hospital + crash_cabinet + non_emergency context: legal', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: true });
  });

  it('hospital + crash_cabinet + emergency context: rejected (crash_cabinet_requires_non_emergency_context)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'crash_cabinet_requires_non_emergency_context' });
  });

  it('a facility on either side is illegal for Shape I (facility_not_permitted_for_this_institution_class)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      sourceFacilityId: 'fac-1',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'facility_not_permitted_for_this_institution_class' });
  });
});

describe('outletContextEligibility — SHAPE H (health_sector, same-facility routing)', () => {
  it('health_sector rescue_cart is ALWAYS forbidden, regardless of facility/context (health_center_rescue_cart_forbidden)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: 'fac-1',
      destinationPointType: 'rescue_cart',
      destinationClinicalLocationKind: 'emergency',
      destinationFacilityId: 'fac-1',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'active',
    });
    expect(r).toEqual({ eligible: false, reason: 'health_center_rescue_cart_forbidden' });
  });

  it('missing facility on either side is rejected BEFORE any other Shape-H rule (health_center_route_requires_facility)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: null,
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'emergency',
      destinationFacilityId: 'fac-1',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'active',
    });
    expect(r).toEqual({ eligible: false, reason: 'health_center_route_requires_facility' });
  });

  it('a cross-facility health_sector route is rejected (cross_facility_route_forbidden)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: 'fac-A',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'emergency',
      destinationFacilityId: 'fac-B',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'active',
    });
    expect(r).toEqual({ eligible: false, reason: 'cross_facility_route_forbidden' });
  });

  it('same-facility health_sector crash_cabinet + emergency context: legal', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: 'fac-A',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'emergency',
      destinationFacilityId: 'fac-A',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'active',
    });
    expect(r).toEqual({ eligible: true });
  });

  it('same-facility health_sector crash_cabinet + NON-emergency context: rejected (health_center_crash_cabinet_requires_emergency)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: 'fac-A',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'non_emergency',
      destinationFacilityId: 'fac-A',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'active',
    });
    expect(r).toEqual({ eligible: false, reason: 'health_center_crash_cabinet_requires_emergency' });
  });

  it('an inactive destination facility is rejected (facility_not_active)', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'health_sector',
      sourceFacilityId: 'fac-A',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'emergency',
      destinationFacilityId: 'fac-A',
      destinationFacilityClass: 'primary_health_center',
      destinationFacilityStatus: 'inactive',
    });
    expect(r).toEqual({ eligible: false, reason: 'facility_not_active' });
  });
});

describe('outletContextEligibility — fail-closed on missing/unrecognised context', () => {
  it('missing institution_class is rejected, never defaulted to eligible', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: null,
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'organization_institution_class_required' });
  });

  it('missing clinical_location_kind is rejected', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: null,
    });
    expect(r).toEqual({ eligible: false, reason: 'destination_clinical_location_kind_required' });
  });

  it('an unrecognised destination point type is rejected, not silently treated as one of the two known types', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'hospital',
      destinationPointType: 'pharmacy',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'destination_must_be_emergency_outlet' });
  });

  it('an unrecognised institution_class is rejected, never silently accepted', () => {
    const r = outletContextEligibility({
      sourceInstitutionClass: 'clinic',
      destinationPointType: 'crash_cabinet',
      destinationClinicalLocationKind: 'non_emergency',
    });
    expect(r).toEqual({ eligible: false, reason: 'organization_institution_class_required' });
  });
});
