/**
 * MOVEMENT-COMPOSER-A — party selection, shared by supply and return.
 *
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE: an institution and its
 * warehouse/depot are ALWAYS shown together, everywhere. A depot name on its own
 * ("مذخر المستشفى") is ambiguous across institutions, and a receipt that names
 * only the depot cannot be reconciled. Selecting the institution first and then
 * only its own warehouses also makes a cross-institution mismatch unselectable
 * rather than merely validated later.
 */
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';

export interface PartyOption {
  id: string;
  organizationId: string | null;
  organizationName: string;
  warehouseName: string;
}

/** The canonical paired label. Used by selectors, cards, receipts and tracking. */
export function pairedPartyLabel(organizationName: string | null, warehouseName: string | null): string {
  const org = organizationName?.trim() || '—';
  const wh = warehouseName?.trim() || '—';
  return `${org} — ${wh}`;
}

interface Props {
  lang: Lang;
  label: string;
  organizations: Array<{ id: string; name: string }>;
  warehouses: readonly PartyOption[];
  selectedOrganizationId: string;
  selectedWarehouseId: string;
  onSelectOrganization: (id: string) => void;
  onSelectWarehouse: (id: string) => void;
  disabled?: boolean;
}

export function MovementPartySelector({
  lang, label, organizations, warehouses,
  selectedOrganizationId, selectedWarehouseId,
  onSelectOrganization, onSelectWarehouse, disabled,
}: Props) {
  // Only warehouses belonging to the chosen institution are offered, so an
  // impossible pairing cannot be composed in the first place.
  const scoped = warehouses.filter(w => w.organizationId === selectedOrganizationId);
  const selected = scoped.find(w => w.id === selectedWarehouseId) ?? null;

  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <PhoenixSelect
        label={label}
        value={selectedOrganizationId}
        disabled={disabled}
        onChange={e => {
          onSelectOrganization(e.target.value);
          // Never leave a warehouse from the previous institution selected.
          onSelectWarehouse('');
        }}
        options={[{ value: '', label: t('inv_select_warehouse', lang) }, ...organizations.map(o => ({ value: o.id, label: o.name }))]}
      />

      <PhoenixSelect
        label={t('inv_warehouse', lang)}
        value={selectedWarehouseId}
        disabled={disabled || !selectedOrganizationId}
        onChange={e => onSelectWarehouse(e.target.value)}
        options={[
          { value: '', label: t('inv_select_warehouse', lang) },
          ...scoped.map(w => ({ value: w.id, label: w.warehouseName })),
        ]}
      />

      {/* The paired identity, restated so the operator reads what a receipt will say. */}
      <p
        data-testid="movement-party-pair"
        style={{ fontSize: '12.5px', fontWeight: 700, color: selected ? 'var(--t)' : 'var(--t2)' }}
      >
        {selected
          ? pairedPartyLabel(selected.organizationName, selected.warehouseName)
          : pairedPartyLabel(null, null)}
      </p>
    </div>
  );
}
