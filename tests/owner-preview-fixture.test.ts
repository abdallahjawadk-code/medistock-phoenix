import { expect, it } from 'vitest';
// @ts-expect-error — Node-only isolated preview seeding module.
import { buildOwnerPreviewPolicy } from '../tools/owner-preview/seed.mjs';
import { decodeMonthlyPolicyReference, proposeFromMonthlyPolicy } from '../src/features/central-needs/allocation/monthly-proposal-reference';
const id=(n:number)=>`a1800000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={ownerOrgId:id(1),planningYear:2026,annualItemId:id(2),fieldVersionId:id(3),canonicalItemId:id(4),unit:'box',beneficiaryOrganizationId:id(5)};
it('the real preview fixture satisfies the unchanged monthly contract and exact twelve-month calculation',()=>{
  const policy=buildOwnerPreviewPolicy(context,id(6),'2026-11-01T10:00:00.000Z');
  expect(()=>decodeMonthlyPolicyReference(policy,context)).not.toThrow();
  const proposal=proposeFromMonthlyPolicy('1200',context,policy);
  expect(proposal).toMatchObject({status:'ready',annualQuantity:'1200',fixedTotal:'0',remainingToPropose:'1200',effectiveAllocation:false});
  if(proposal.status==='ready')expect(proposal.rows).toEqual(Array.from({length:12},(_,index)=>({month:index+1,quantity:'100',kind:'suggested'})));
});
