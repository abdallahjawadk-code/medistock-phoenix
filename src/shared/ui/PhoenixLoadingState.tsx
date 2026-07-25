import { MasarCopyrightSeal } from './MasarCopyrightSeal';
import { PharmacyPulseLoader } from './PharmacyPulseLoader';

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
      {/* نبض الصيدلة — Bowl of Hygieia pulse (PHARMACY-PULSE-LOADER). */}
      <PharmacyPulseLoader size="full" />
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
