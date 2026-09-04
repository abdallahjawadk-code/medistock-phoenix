import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

/**
 * INTERACTIVE-GUIDE-IG1 — change the APPLICATION language from inside the guide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, given that the guide has no language of its own
 *
 * The guide is strictly modal while a tour runs: a full-viewport blocking layer
 * plus `inert` on everything behind it, so that a highlighted operational
 * control cannot be activated by mouse, touch or keyboard. That is deliberate
 * and is not weakened anywhere — there is no click-through hole.
 *
 * The cost of that modality was that the topbar's language control became
 * unreachable mid-tour, which left the live-language contract technically
 * implemented but unusable by an operator. This control closes that gap from
 * the safe side: instead of punching a hole through the blocker, the guide
 * offers the SAME action inside its own surface, where interaction is already
 * legitimate.
 *
 * WHAT IT IS NOT
 *
 * It is not a guide-language selector, and it introduces no second source of
 * truth. It holds no state, reads `lang` from AppContext, and mutates it
 * through `toggleLang` — byte-for-byte the same canonical setter the topbar
 * control calls. Persistence therefore happens where it already happened, in
 * `LanguagePreferenceBridge`, through the one storage key that already exists.
 * This module writes to no storage, defines no preference, and knows nothing
 * about how the choice is remembered.
 *
 * `guide-language-canonical.runtime.test.tsx` proves that end to end against
 * the real provider and the real bridge, and `guide-safety.test.ts` fails if
 * the guide ever acquires a storage key of its own.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function GuideLanguageControl() {
  const { lang, toggleLang } = useApp();

  return (
    <button
      type="button"
      /* The canonical setter, passed straight through. No wrapper, no local
         state, and nothing else happens on activation. */
      onClick={toggleLang}
      className="guide-btn guide-btn--quiet guide-lang"
      /* A greppable marker for the acceptance suites, so they address this
         control by identity rather than by its translated label. */
      data-guide-language-control=""
    >
      <PhoenixIcon name="globe" size={14} inline />
      <span>{t('guide_change_app_language', lang)}</span>
    </button>
  );
}
