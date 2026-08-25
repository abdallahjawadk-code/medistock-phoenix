import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from '@/shared/ui/PhoenixIcon';
import type {
  CommandCenterNetworkSummary,
  CommandCenterScopeKind,
} from '@/shared/supabase/services/command-center.service';

interface Props {
  network: CommandCenterNetworkSummary;
  scopeKind: CommandCenterScopeKind;
}

/**
 * RAC-3 — network reach, strictly as the server described it.
 *
 * Migration 199 contains the counting channel on purpose: at organization,
 * warehouse and outlet scope the organization count is pinned to exactly 1, so
 * a scoped actor cannot infer platform size from it. This panel therefore does
 * the one thing that keeps that guarantee intact — it prints the numbers it was
 * given and adds nothing.
 *
 * Concretely it draws no map, no sibling placeholders, no "of N" denominator
 * and no greyed-out nodes hinting at institutions the actor may not see. At
 * non-global scope the organization figure is presented as the actor's OWN
 * organization rather than as a count, because rendering a literal "1" beside
 * "Organizations" invites reading it as a platform total of one.
 */
export function NetworkOverviewPanel({ network, scopeKind }: Props) {
  const { lang } = useApp();
  const isGlobal = scopeKind === 'global';
  const fmt = (n: number) => n.toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-US');

  const rows: Array<{ id: string; icon: PhoenixIconName; labelKey: string; value: string }> = [];

  if (isGlobal) {
    rows.push({
      id: 'organizations',
      icon: 'institutions',
      labelKey: 'rac3_network_organizations',
      value: fmt(network.organizations),
    });
  }
  rows.push({
    id: 'warehouses',
    icon: 'warehouse',
    labelKey: 'rac3_network_warehouses',
    value: fmt(network.warehouses),
  });
  rows.push({
    id: 'distribution_points',
    icon: 'outlet',
    labelKey: 'rac3_network_points',
    value: fmt(network.distribution_points),
  });

  return (
    <div className="rac3-network">
      <ul className="rac3-network__list">
        {rows.map(row => (
          <li key={row.id} className="rac3-network__row">
            <span className="rac3-network__icon" aria-hidden="true">
              <PhoenixIcon name={row.icon} size={16} />
            </span>
            <span className="rac3-network__label">{t(row.labelKey, lang)}</span>
            <span className="rac3-network__value">{row.value}</span>
          </li>
        ))}
      </ul>
      <p className="rac3-network__scope-note">
        {t(isGlobal ? 'rac3_network_scope_global' : 'rac3_network_scope_local', lang)}
      </p>
    </div>
  );
}
