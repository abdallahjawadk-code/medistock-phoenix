/**
 * CN-2B — rendering a server refusal for a human.
 *
 * The database's own identifier is the contract, so a code with no translation
 * yet degrades to the identifier itself rather than to a vague "something went
 * wrong" or, worse, to a raw dictionary key leaking into the interface. This
 * mirrors `tRpcError`'s reasoning in `strings.ts`: a new server-side rule must
 * never be silently flattened into a generic failure.
 */
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/i18n/strings';

export function centralNeedsErrorText(code: string, lang: Lang): string {
  const key = `cn2b_err_${code}`;
  const text = t(key, lang);
  return text === key ? code : text;
}
