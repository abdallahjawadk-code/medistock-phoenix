import { useCallback, useEffect, useState } from 'react';

/**
 * PWA-INSTALL-PROMPT-A
 *
 * Drives the install-prompt UI: listens for the native `beforeinstallprompt`
 * event (Android/Chromium), detects the iOS/Safari fallback case, detects
 * standalone/already-installed mode, and persists a dismissal cooldown in
 * localStorage so the prompt never nags the user.
 */

const DISMISS_STORAGE_KEY = 'phoenix_pwa_install_dismissed_at';
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const mediaMatch = typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mediaMatch || iosStandalone;
}

function readDismissedAt(): number | null {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // localStorage unavailable (private mode / disabled) — treat as never dismissed.
    return null;
  }
}

function isDismissedRecently(): boolean {
  const dismissedAt = readDismissedAt();
  if (dismissedAt === null) return false;
  return Date.now() - dismissedAt < DISMISS_COOLDOWN_MS;
}

/** Conservative iOS Safari detection — excludes other iOS browsers (which are WebKit-based but report their own product tokens). */
function isLikelyIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIosDevice = /iPad|iPhone|iPod/.test(ua)
    || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const isOtherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const isSafari = /Safari/.test(ua) && !isOtherIosBrowser;
  return isIosDevice && isSafari;
}

export interface PwaInstallState {
  /** Native beforeinstallprompt is available (Android/Chromium) and not dismissed/installed. */
  canInstallNative: boolean;
  /** Likely iOS Safari with no native prompt available — show "Add to Home Screen" instructions. */
  showIosInstructions: boolean;
  dismiss: () => void;
  promptInstall: () => Promise<void>;
}

export function usePwaInstallPrompt(): PwaInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandaloneDisplay());
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissedRecently());

  useEffect(() => {
    if (installed) return;

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [installed]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable — dismissal just won't persist across reloads; non-fatal.
    }
    setDismissed(true);
    setDeferredPrompt(null);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    try {
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
      }
    } finally {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const canInstallNative = Boolean(deferredPrompt) && !installed && !dismissed;
  const showIosInstructions = !installed && !dismissed && !deferredPrompt && isLikelyIosSafari();

  return { canInstallNative, showIosInstructions, dismiss, promptInstall };
}
