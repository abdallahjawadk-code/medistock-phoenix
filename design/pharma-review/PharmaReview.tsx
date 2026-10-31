import { QaAppProvider } from '@/features/qa/QaAppProvider';
import { qaPersona, type QaPersonaId } from '@/features/qa/qaFixtures';
import { createQaFixtureClient } from '@/features/qa/qaFixtureClient';
import { __installQaSupabaseClient } from '@/shared/supabase/client';
import { PharmaGallery } from './PharmaGallery';
const q=new URLSearchParams(location.search);
const persona=qaPersona((q.get('persona')??'super_admin') as QaPersonaId);
__installQaSupabaseClient(createQaFixtureClient(persona.profile.id));
export default function PharmaReview(){return <QaAppProvider persona={persona} lang={q.get('lang')==='en'?'en':'ar'} theme={q.get('theme')==='dark'?'dark':'light'}><PharmaGallery/></QaAppProvider>;}
