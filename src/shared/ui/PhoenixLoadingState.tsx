import { PhoenixMark } from './PhoenixMark';
import { MasarCopyrightSeal } from './MasarCopyrightSeal';

interface Props {
  label?: string;
  /**
   * Render as a centered full-screen state (shell absent — boot / auth / route
   * fallback). In that mode the minimal MASAR seal sits below the state content;
   * inline usage inside the authenticated shell stays seal-free (the shell footer
   * already carries exactly one seal).
   */
  fullScreen?: boolean;
}

export function PhoenixLoadingState({ label = '...', fullScreen = false }: Props) {
  const content = (
    <div className="nexus-loading" role="status" aria-live="polite">
      <div className="nexus-loading__mark" aria-hidden="true">
        <span className="nexus-loading__orbit" />
        <PhoenixMark size={34} title="" />
      </div>
      <span>{label}</span>
    </div>
  );

  if (!fullScreen) return content;

  return (
    <div className="nexus-state-screen">
      {content}
      <div className="nexus-state__brand">
        <MasarCopyrightSeal variant="minimal" />
      </div>
    </div>
  );
}
