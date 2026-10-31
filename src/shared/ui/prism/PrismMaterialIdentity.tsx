import { PhoenixIcon } from '../PhoenixIcon';
import './prism-fonts.css';
import './prism-workspace.css';

interface Props {
  name: string;
  nationalCode?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  compact?: boolean;
}

/** Identity fields only: this component makes no stock, approval or year-membership claim. */
export function PrismMaterialIdentity({ name, nationalCode, concentration, dosageForm, unit, compact = false }: Props) {
  const details = [dosageForm, concentration, unit].filter((value): value is string => Boolean(value));
  return (
    <div className={`prism-material-identity${compact ? ' prism-material-identity--compact' : ''}`}>
      <span className="prism-material-identity__icon" aria-hidden="true"><PhoenixIcon name="medical" size={compact ? 20 : 28} /></span>
      <div className="prism-material-identity__copy">
        <strong className="prism-material-identity__name"><bdi>{name}</bdi></strong>
        {nationalCode && <span className="prism-material-identity__code"><bdi dir="ltr">{nationalCode}</bdi></span>}
        {details.length > 0 && (
          <span className="prism-material-identity__details">
            {details.map((detail, index) => <bdi key={`${index}:${detail}`}>{detail}</bdi>)}
          </span>
        )}
      </div>
    </div>
  );
}
