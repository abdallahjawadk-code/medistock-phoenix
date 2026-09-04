import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { GUIDE_ANCHORS, guideAnchor } from './guide.anchors';

interface Props {
  onOpen: () => void;
  /**
   * `compact` is the topbar control (icon only, one more 44px slot beside the
   * bell); `full` is the drawer row (icon + label, matching the drawer's other
   * entries).
   *
   * This split is measured, not assumed: at 375px the topbar already carries
   * the menu trigger, the title, the bell, the language toggle and the theme
   * toggle across the full width, so a fifth control there would squeeze the
   * screen title. The drawer is the shell's existing overflow surface for
   * exactly this, and already hosts My Account the same way.
   */
  variant: 'compact' | 'full';
}

/**
 * INTERACTIVE-GUIDE-IG1 — the Guide & Help entry point.
 *
 * Carries its own stable anchor so the tour can point AT the way back to
 * itself, which is how an operator learns that the guide is re-openable.
 */
export function GuideEntryButton({ onOpen, variant }: Props) {
  const { lang } = useApp();
  const label = t('guide_entry', lang);

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="nexus-control"
        aria-label={t('guide_entry_aria', lang)}
        {...guideAnchor(GUIDE_ANCHORS.shellTopbarHelp)}
      >
        <PhoenixIcon name="info" size={17} />
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
