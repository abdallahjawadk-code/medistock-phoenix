import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixEmptyState } from './PhoenixEmptyState';

/** Shared role/permission refusal state for authenticated screens. */
export function ForbiddenScreen() {
  const { lang } = useApp();
  return (
    <PhoenixEmptyState
      icon="lock"
      title={t('access_forbidden_title', lang)}
      description={t('access_forbidden_hint', lang)}
    />
  );
}
