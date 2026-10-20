/**
 * R1 acceptance harness - TEST ONLY, never part of the application bundle (it lives under tests/ and is served only by the acceptance suite).
 *
 * It mounts the REAL manual-needs journey (real components, real service modules, real Supabase client) in a real browser. The only
 * things replaced are:
 *   * the HTTP endpoint behind the Supabase client (a local PostgREST-style shim in front of the disposable PostgreSQL rig, so every
 *     RPC and RLS-governed read runs the REAL SQL candidates under the REAL `authenticated` role with the test account's identity);
 *   * three catalog reads (beneficiaries, catalog search, identity lookup) that the application performs with PostgREST filter syntax
 *     the shim does not reproduce - they are answered from the same rig by plain SQL (the shared PRE3-A resolver itself is NOT under test).
 * Test accounts are the rig's synthetic users; the "session" is an unsigned token the shim reads. Nothing here can reach anything outside localhost.
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { supabase } from '@/shared/supabase/client';
import { ManualNeedsJourney } from '@/features/central-needs/manual/ManualNeedsJourney';
import { realJourneyApi, type JourneyApi } from '@/features/central-needs/manual/manual-journey.service';

interface Actor { id: string; label: string; jwt: string }
interface Org { id: string; label: string }
declare global {
  interface Window { __ACTORS__: Actor[]; __ORGS__: Org[]; __SHIM__: string; __supabase: typeof supabase; __harnessReady?: boolean }
}

const shim = window.__SHIM__;
const getJson = async (path: string) => {
  const r = await fetch(shim + path);
  if (!r.ok) throw new Error(`test endpoint ${path}: ${r.status}`);
  return r.json();
};
const api: JourneyApi = {
  ...realJourneyApi,
  listBeneficiaries: () => getJson('/test/beneficiaries'),
  searchCatalog: (q) => getJson('/test/catalog?q=' + encodeURIComponent(q)),
  resolveForIdentity: (q) => getJson('/test/identity?q=' + encodeURIComponent(q)),
};
window.__supabase = supabase;

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const [actorId, setActorId] = useState<string>(params.get('actor') ?? window.__ACTORS__[0].id);
  const [orgId, setOrgId] = useState<string>(params.get('org') ?? window.__ORGS__[0].id);
  const [lang, setLang] = useState<'ar' | 'en'>(params.get('lang') === 'ar' ? 'ar' : 'en');
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const actor = window.__ACTORS__.find((a) => a.id === actorId)!;

  useEffect(() => {
    let cancelled = false;
    setSignedInAs(null);
    (async () => {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const { error } = await supabase.auth.setSession({ access_token: actor.jwt, refresh_token: 'rig-refresh' });
      if (!cancelled) { if (error) throw error; setSignedInAs(actor.id); window.__harnessReady = true; }
    })();
    return () => { cancelled = true; };
  }, [actor.id, actor.jwt]);

  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <div role="toolbar" aria-label="Test harness controls (not part of the application)" style={{ padding: 8, background: '#eef', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>Test account
          <select aria-label="Test account" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            {window.__ACTORS__.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </label>
        <label>Acting organization
          <select aria-label="Acting organization" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {window.__ORGS__.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setLang('ar')} data-testid="lang-ar">AR</button>
        <button type="button" onClick={() => setLang('en')} data-testid="lang-en">EN</button>
      </div>
      {signedInAs === actor.id && (
        // a role/account switch is a new session (remount); an organization switch is a prop change on the SAME mounted journey
        <ManualNeedsJourney key={actor.id} lang={lang} organizationId={orgId} actorId={actor.id} api={api} initialYear={2027} />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
