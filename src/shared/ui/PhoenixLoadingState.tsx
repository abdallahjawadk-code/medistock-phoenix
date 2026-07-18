import { PhoenixMark } from './PhoenixMark';

interface Props {
  label?: string;
}

export function PhoenixLoadingState({ label = '...' }: Props) {
  return (
    <div className="nexus-loading" role="status" aria-live="polite">
      <div className="nexus-loading__mark" aria-hidden="true">
        <span className="nexus-loading__orbit" />
        <PhoenixMark size={34} title="" />
      </div>
      <span>{label}</span>
    </div>
  );
}
