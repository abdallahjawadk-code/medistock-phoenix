/**
 * CN-2B — rendering a server refusal for a human.
 *
 * The database's own identifier is the contract, so a code with no translation
 * yet degrades to the identifier itself rather than to a vague "something went
 * wrong" or, worse, to a raw dictionary key leaking into the interface. This
 * mirrors `tRpcError`'s reasoning in `strings.ts`: a new server-side rule must
 * never be silently flattened into a generic failure.
 *
 * DISPLAY TERMINOLOGY
 * -------------------
 * The product-facing name of this module is "Annual Needs" / "الاحتياج السنوي".
 * The technical identifiers remain `central_needs.*`, and the already-applied
 * M209 permission-catalog labels remain historical database evidence. So the
 * rename changes translation VALUES only — never a key, a permission, a table,
 * an RPC, a migration, or stored evidence.
 *
 * Those values live where every other string lives: `src/shared/i18n/strings.ts`.
 * They are deliberately NOT patched over `T` from here.
 *
 * An earlier revision of this file did exactly that — a module-scope assign over
 * the shared dictionary — and it made the displayed name depend on whether
 * anything had imported this module yet. That is not a theoretical concern: CI
 * proved it.
 * On the same commit, the Arabic Central Needs screen rendered the NEW name
 * (this module was in its import graph) while the English sidebar still
 * rendered the OLD one (it was not), so one chromium assertion failed and its
 * sibling passed. A canonical value in the dictionary has no import order to
 * get wrong.
 *
 * C5 §14 — a refusal object is read by its fields, never by its message:
 * a retryable contention gets the one "try again" sentence (nothing retries on
 * its own), and a code whose DETAIL pins a `reason=` token gets the
 * reason-specific sentence `cn2b_err_<code>__<reason>` when one exists.
 */
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/i18n/strings';
import { reasonOf } from './central-needs.service';

/** The fields of a `CentralNeedsError` this module reads. */
export interface CentralNeedsRefusal {
  businessCode: string;
  details?: string | null;
  retryable?: boolean;
}

function codeText(code: string, lang: Lang): string {
  const key = `cn2b_err_${code}`;
  const text = t(key, lang);
  return text === key ? code : text;
}

export function centralNeedsErrorText(error: string | CentralNeedsRefusal, lang: Lang): string {
  if (typeof error === 'string') return codeText(error, lang);
  if (error.retryable === true) return t('cn2b_err_retryable_contention', lang);
  const reason = reasonOf(error.details);
  if (reason !== null) {
    const key = `cn2b_err_${error.businessCode}__${reason}`;
    const text = t(key, lang);
    if (text !== key) return text;
  }
  return codeText(error.businessCode, lang);
}
