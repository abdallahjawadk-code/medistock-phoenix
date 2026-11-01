import { describe, expect, it } from 'vitest';
import { prepareAnnualYearRollover, type RolloverPreviewInput, type RolloverSourceMaterial } from '../annual-year-rollover-preview';
import type { AnnualFieldState } from '../annual-catalog.contract';

const OWNER='11111111-1111-4111-8111-111111111111';
const CANON='22222222-2222-4222-8222-222222222222';
const ANNUAL='33333333-3333-4333-8333-333333333333';
const VERSION='44444444-4444-4444-8444-444444444444';
const SHA='a'.repeat(64);
const valid=(s:string):AnnualFieldState=>({state:'known',value:s,origins:[{kind:'manual',decisionReference:'approved-source-version'}]});
function material(year=2026, canonicalId=CANON):RolloverSourceMaterial {
  const scope={ownerOrgId:OWNER,planningYear:year};
  return {
    item:{scope,membership:{scope,annualItemId:ANNUAL,canonicalItemId:canonicalId,status:'active',currentFieldVersionId:VERSION,occurrenceKeys:[]},
      fieldVersion:{scope,annualItemId:ANNUAL,fieldVersionId:VERSION,versionNumber:2,
        fields:{scientificName:valid('Paracetamol'),nameAr:valid('باراسيتامول'),nationalCode:valid('00001234'),
          barcode:{state:'missing',reason:'none'},dosageForm:valid('tablet'),concentration:valid('500 mg'),unit:valid('tablet')}},
      canonicalFingerprint:SHA,canonicalDrift:false,selectable:true,selectionBlockers:[],sourceOccurrenceCount:0,sourceAttestation:'client_attested'},
    targetCanonical:{scope:{ownerOrgId:OWNER,planningYear:year+1},canonicalItemId:canonicalId,
      canonicalSnapshot:{canonicalItemId:canonicalId,scientificName:'Paracetamol',nameAr:'باراسيتامول',nationalCode:'00001234',
        barcode:null,dosageForm:'tablet',concentration:'500 mg',unit:'tablet',status:'active'},
      canonicalFingerprint:SHA,eligible:true,missingRequired:[]},
    classifications:[{label:'مسكنات',origin:'source',reference:'2026-sheet:3:12'}],
  };
}
function input(year=2027):RolloverPreviewInput {
  return {targetScope:{ownerOrgId:OWNER,planningYear:year},targetYearStatus:'active',
    priorYearsComplete:true,targetMembershipsComplete:true,existingTargetCanonicalIds:[],
    previousYears:[{scope:{ownerOrgId:OWNER,planningYear:year-1},approval:{status:'approved',reference:'annual-final-approved'},
      itemsComplete:true,materials:[material(year-1)]}]};
}
function previewOnly(value:RolloverPreviewInput) {
  const r=prepareAnnualYearRollover(value);
  if(r.status!=='PREVIEW_ONLY')throw new Error('unexpected_hold:'+r.reason);
  return r;
}
function held(value:RolloverPreviewInput, code:string) {
  const r=previewOnly(value);
  expect(r.carry).toHaveLength(0);
  expect(r.held[0]?.reasons).toContain(code);
}

describe('year rollover identity-only preview (never persists)',()=>{
  it('copies verified fields including the national code leading zeros, not quantities or quota',()=>{
    const r=previewOnly(input());
    expect(r.sourceScope.planningYear).toBe(2026);
    expect(r.targetScope.planningYear).toBe(2027);
    expect(r.carry).toHaveLength(1);
    expect(r.carry[0]?.identity.nationalCode).toBe('00001234');
    expect(r.carry[0]?.identity.dosageForm).toBe('tablet');
    expect(r.carry[0]?.identity.barcode).toBeNull();
    expect(r.carry[0]?.classifications).toEqual([{label:'مسكنات',reference:'2026-sheet:3:12'}]);
    const output=JSON.stringify(r);
    for(const key of ['quantityText','annualQuantity','monthlyAllocation','beneficiaryOrganizationId','stock','approvedQuota'])
      expect(output).not.toContain(key);
  });
  it('does not silently copy 2027 entries into 2028 from 2026',()=>{
    const r=previewOnly(input(2028));
    expect(r.sourceScope.planningYear).toBe(2027);
    expect(r.targetScope.planningYear).toBe(2028);
  });
  it('selects the latest legally approved older year rather than the latest active year',()=>{
    const i=input();
    const older={scope:{ownerOrgId:OWNER,planningYear:2025},approval:{status:'approved' as const,reference:'older'},
      itemsComplete:true,materials:[{...material(2025),targetCanonical:{...material(2025).targetCanonical,scope:{ownerOrgId:OWNER,planningYear:2027}}}]};
    const newest={scope:{ownerOrgId:OWNER,planningYear:2026},approval:{status:'unapproved' as const},
      itemsComplete:true,materials:[]};
    const r=previewOnly({...i,previousYears:[newest,older]});
    expect(r.sourceScope.planningYear).toBe(2025);
    expect(r.carry).toHaveLength(1);
    expect(r.held).toHaveLength(0);
  });
  it('holds year with missing or archived target, incomplete source/target census and missing approval',()=>{
    expect(prepareAnnualYearRollover({...input(),targetYearStatus:'missing'})).toMatchObject({status:'HOLD',reason:'target_year_not_active'});
    expect(prepareAnnualYearRollover({...input(),targetYearStatus:'archived'})).toMatchObject({status:'HOLD',reason:'target_year_not_active'});
    expect(prepareAnnualYearRollover({...input(),priorYearsComplete:false})).toMatchObject({status:'HOLD',reason:'year_index_incomplete'});
    expect(prepareAnnualYearRollover({...input(),targetMembershipsComplete:false})).toMatchObject({status:'HOLD',reason:'target_memberships_incomplete'});
    expect(prepareAnnualYearRollover({...input(),previousYears:[]})).toMatchObject({status:'HOLD',reason:'source_year_unapproved'});
    const a=input();expect(prepareAnnualYearRollover({...a,previousYears:[{...a.previousYears[0],itemsComplete:false}]})).toMatchObject({status:'HOLD',reason:'source_items_incomplete'});
  });
  it('holds all rows with duplicate canonical identities instead of choosing one',()=>{
    const i=input();const row=material();
    const other=structuredClone(row) as any;other.item.membership.annualItemId='55555555-5555-4555-8555-555555555555';
    other.item.fieldVersion.annualItemId=other.item.membership.annualItemId;
    const r=previewOnly({...i,previousYears:[{...i.previousYears[0],materials:[row,other]}]});
    expect(r.carry).toHaveLength(0);expect(r.held).toHaveLength(2);
    expect(r.held.every(x=>x.reasons.includes('duplicate_source_canonical'))).toBe(true);
  });
  it('holds duplicate annual records even when canonical identities differ',()=>{
    const i=input(),a=material(),b=structuredClone(a) as any;
    const alternative='66666666-6666-4666-8666-666666666666';
    b.item.membership.canonicalItemId=alternative;
    b.targetCanonical.canonicalItemId=alternative;
    b.targetCanonical.canonicalSnapshot.canonicalItemId=alternative;
    const r=previewOnly({...i,previousYears:[{...i.previousYears[0],materials:[a,b]}]});
    expect(r.carry).toHaveLength(0);
    expect(r.held.every(x=>x.reasons.includes('duplicate_source_annual_item'))).toBe(true);
  });
  it('does not create duplicate target membership after an existing successful transaction',()=>{
    held({...input(),existingTargetCanonicalIds:[CANON]},'target_already_contains_material');
  });
  it('holds changed legal identity or fingerprint drift',()=>{
    const i=input();const m=material();
    held({...i,previousYears:[{...i.previousYears[0],materials:[{...m,targetCanonical:{...m.targetCanonical,canonicalFingerprint:'b'.repeat(64)}}]}]},'canonical_fingerprint_drift');
    held({...i,previousYears:[{...i.previousYears[0],materials:[{...m,item:{...m.item,canonicalDrift:true}}]}]},'canonical_fingerprint_drift');
  });
  it('refuses retired, preparing, unresolved, and legally inactive materials',()=>{
    for(const status of ['retired','preparing'] as const){
      const m=material();held({...input(),previousYears:[{...input().previousYears[0],materials:[{...m,item:{...m.item,membership:{...m.item.membership,status}}}]}]},'source_not_selectable');
    }
    const m=material();held({...input(),previousYears:[{...input().previousYears[0],materials:[{...m,targetCanonical:{...m.targetCanonical,eligible:false,canonicalSnapshot:{...m.targetCanonical.canonicalSnapshot,status:'retired'}}}]}]},'canonical_missing_or_inactive');
  });
  it('holds stale annual field snapshots and missing mandatory source identity',()=>{
    const m=material();
    held({...input(),previousYears:[{...input().previousYears[0],materials:[{...m,item:{...m.item,fieldVersion:{...m.item.fieldVersion,fieldVersionId:'55555555-5555-4555-8555-555555555555'}}}]}]},'source_version_stale');
    const next=structuredClone(material()) as any;next.item.fieldVersion.fields.unit={state:'missing',reason:'unknown'};
    held({...input(),previousYears:[{...input().previousYears[0],materials:[next]}]},'source_field_unresolved');
  });
  it('requires reviewed source classification and unchanged reference',()=>{
    const m=material();
    held({...input(),previousYears:[{...input().previousYears[0],materials:[{...m,classifications:[]}]}]},'source_classification_unreviewed');
    held({...input(),previousYears:[{...input().previousYears[0],materials:[{...m,classifications:[{label:'new',origin:'proposed',reference:'no-reviewed-source'}]}]}]},'source_classification_unreviewed');
  });
  it('does not cross owner, future year or canonical target preview scope',()=>{
    const i=input();const a=material();
    expect(()=>prepareAnnualYearRollover({...i,previousYears:[{...i.previousYears[0],scope:{ownerOrgId:'99999999-9999-4999-8999-999999999999',planningYear:2026}}]})).toThrow('annual_rollover_source_scope_invalid');
    expect(()=>prepareAnnualYearRollover({...i,previousYears:[{...i.previousYears[0],scope:{ownerOrgId:OWNER,planningYear:2028}}]})).toThrow('annual_rollover_source_scope_invalid');
    expect(()=>prepareAnnualYearRollover({...i,previousYears:[{...i.previousYears[0],materials:[{...a,targetCanonical:{...a.targetCanonical,scope:{...a.targetCanonical.scope,planningYear:2028}}}]}]})).toThrow('annual_catalog_scope_mismatch');
  });
  it('holds missing or colliding annual year evidence and malformed target memberships',()=>{
    const i=input();expect(prepareAnnualYearRollover({...i,previousYears:[...i.previousYears,...i.previousYears]})).toMatchObject({status:'HOLD',reason:'duplicate_year_evidence'});
    expect(()=>prepareAnnualYearRollover({...i,existingTargetCanonicalIds:[CANON,CANON]})).toThrow('annual_rollover_target_memberships_invalid');
    expect(()=>prepareAnnualYearRollover({...i,existingTargetCanonicalIds:['not-a-uuid']})).toThrow('annual_rollover_target_memberships_invalid');
  });
  it('bounds untrusted input and never infers approval from active status',()=>{
    const i=input();
    expect(()=>prepareAnnualYearRollover({...i,previousYears:Array(102).fill(i.previousYears[0])})).toThrow('annual_rollover_input_limit');
    expect(prepareAnnualYearRollover({...i,previousYears:[{...i.previousYears[0],approval:{status:'unapproved'}}]})).toMatchObject({status:'HOLD',reason:'source_year_unapproved'});
    expect(prepareAnnualYearRollover({...i,previousYears:[{...i.previousYears[0],approval:{status:'approved',reference:''}}]})).toMatchObject({status:'HOLD',reason:'source_year_unapproved'});
  });
});
