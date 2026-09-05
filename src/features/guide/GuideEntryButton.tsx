import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { GUIDE_ANCHORS, guideAnchor } from './guide.anchors';

interface Props {
  onOpen: () => void;
  /**
   * `topbar` is the desktop control; `full` is the drawer row on a phone,
   * which matches the drawer's other entries.
   *
   * The split is measured, not assumed: at 375px the topbar already carries
   * the menu trigger, the title, the bell, the language toggle and the theme
   * toggle across its full width, so a fifth control there would squeeze the
   * screen title. The drawer is the shell's existing overflow surface for
   * exactly this, and already hosts My Account the same way.
   */
  variant: 'topbar' | 'full';
}

/**
 * INTERACTIVE-GUIDE-IG1 — the Guide & Help entry point.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DESKTOP CONTROL CARRIES ITS LABEL
 *
 * It first shipped as a bare glyph, and owner acceptance found Guide & Help on
 * mobile and not on desktop. Measured against the real render at 1280, 1440 and
 * 1920 in both languages and both themes, the control was present, visible,
 * unclipped, hit-testable and gated by nothing — and still unfindable, because
 * a 17px outline "i" between a notification bell and a language chip reads as
 * decoration. "Rendered" was never the acceptance criterion; "discoverable"
 * was, and only the mobile drawer met it, where the entry has always been a
 * full row reading «الدليل والمساعدة».
 *
 * So the desktop control now names itself. Below 1024px the label is dropped by
 * `phoenix-nexus.css` and the glyph stands alone, which is the constrained
 * fallback: `aria-label` and `title` are always present, so the accessible name
 * and the tooltip survive that fallback unchanged. The accessible name is a
 * superset of the visible label, which keeps WCAG 2.5.3 (Label in Name)
 * satisfied in both states.
 *
 * There is exactly ONE entry at every breakpoint: the topbar control is
 * desktop-only and the drawer row is phone-only — see PhoenixTopbar and
 * PhoenixMobileDrawer, and the browser suite asserts the count directly.
 *
 * DISCOVERABILITY IS NOT PERMISSION-GATED. Every authenticated operator can
 * open Guide & Help. Permissions filter the CONTENT inside it — see
 * guide.permissions.ts — never the way in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Carries its own stable anchor so the tour can point AT the way back to
 * itself, which is how an operator learns that the guide is re-openable.
 */
export function GuideEntryButton({ onOpen, variant }: Props) {
  const { lang } = useApp();
  const label = t('guide_entry', lang);

  if (variant === 'topbar') {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="nexus-control nexus-control--labelled"
        /* Kept on both states on purpose. Below 1024px the visible label is
           display:none and is therefore excluded from the accessible name, so
           without this the constrained control would have no name at all. */
        aria-label={t('guide_entry_aria', lang)}
        title={t('guide_entry_aria', lang)}
        {...guideAnchor(GUIDE_ANCHORS.shellTopbarHelp)}
      >
        <PhoenixIcon name="info" size={17} />
        <span className="nexus-control__label">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="premium-nav-item"
      {...guideAnchor(GUIDE_ANCHORS.shellDrawerHelp)}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '0 12px', borderRadius: 'var(--r2)',
        borderBlock: 'none', borderInlineEnd: 'none', width: '100%', textAlign: 'start',
        fontSize: '14px', fontWeight: 500,
        transition: 'background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
        minHeight: 'var(--touch-target)',
        cursor: 'pointer',
      }}
    >
      <span className="nexus-nav-icon"><PhoenixIcon name="info" size={19} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}
