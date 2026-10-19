/**
 * R1-A4 — the Screen-3 tab body. Rendered by the Inventory Center ONLY when the activation gate says 'on'
 * (see manual-needs-gate.ts): inactive by default, org-level (no warehouse), PDA home organization only.
 */
import { useApp } from '@/app/AppContext';
import { ManualNeedsJourney } from './ManualNeedsJourney';

export function ManualNeedsTab() {
  const { lang, activeOrgId, profile } = useApp();
  if (!activeOrgId || !profile?.id) return null;
  return <ManualNeedsJourney lang={lang === 'ar' ? 'ar' : 'en'} organizationId={activeOrgId} actorId={profile.id} />;
}
