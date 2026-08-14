import { isScreenAuthorized, roleLandingScreen } from '@/shared/authz/screen-access';

const STORAGE_PREFIX = 'medistock-phoenix-screen:';
const EPOCH_PREFIX = 'medistock-phoenix-continuity-epoch:';
const HISTORY_KEY = 'medistockPhoenixScreen';
const volatileEpochs = new Map<string, string>();

interface ScreenHistoryState {
  [HISTORY_KEY]: { profileId: string; epoch: string; screen: number };
}

/**
 * Restoration allow-list, intersected with the canonical screen authorization.
 *
 * R1.1-U (U-B corrective, C2): the per-screen gates that used to be duplicated
 * here now live in ONE place, isScreenAuthorized, so restoration can no longer
 * drift from the route guard. That drift was the defect: a facility-scoped role
 * was steered away from screen 21 by roleLandingScreen, yet a persisted session,
 * a refresh or a Back button restored it anyway — an authorization decision
 * being made by "the page happens to render empty" rather than by a gate.
 *
 * The first line remains a genuine restoration allow-list: a screen may be
 * authorized and still not be worth restoring into.
 */
export function isScreenRestorable(
  screen: number,
  role: string | null | undefined,
  permissions: ReadonlySet<string>,
): boolean {
  if (![3, 6, 11, 13, 14, 15, 17, 18, 19, 21].includes(screen)) return false;
  return isScreenAuthorized(screen, role, permissions);
}

function storageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId}`;
}

function epochKey(profileId: string): string {
  return `${EPOCH_PREFIX}${profileId}`;
}

function createEpoch(): string | null {
  try {
    const values = new Uint32Array(4);
    window.crypto.getRandomValues(values);
    return Array.from(values, value => value.toString(16).padStart(8, '0')).join('');
  } catch {
    return null;
  }
}

function currentEpoch(profileId: string): string | null {
  try {
    const stored = window.sessionStorage.getItem(epochKey(profileId));
    if (stored) {
      volatileEpochs.set(profileId, stored);
      return stored;
    }
  } catch {
    // The in-memory epoch keeps history useful in this document only. A reload
    // loses it and therefore fails closed to the role landing.
  }
  return volatileEpochs.get(profileId) ?? null;
}

function ensureEpoch(profileId: string): string | null {
  const existing = currentEpoch(profileId);
  if (existing) return existing;
  const epoch = createEpoch();
  if (!epoch) return null;
  volatileEpochs.set(profileId, epoch);
  try {
    window.sessionStorage.setItem(epochKey(profileId), epoch);
  } catch {
    // See currentEpoch: this epoch remains valid only for this document.
  }
  return epoch;
}

function historyScreen(
  state: unknown,
  profileId: string,
  epoch: string | null,
): number | null | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const value = (state as Partial<ScreenHistoryState>)[HISTORY_KEY];
  if (value === undefined) return undefined;
  if (
    !value ||
    epoch === null ||
    value.profileId !== profileId ||
    value.epoch !== epoch ||
    !Number.isInteger(value.screen)
  ) return null;
  return value.screen;
}

function storedScreen(profileId: string, epoch: string | null): number | null {
  if (epoch === null) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(profileId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { epoch?: unknown; screen?: unknown };
    return parsed.epoch === epoch && Number.isInteger(parsed.screen)
      ? parsed.screen as number
      : null;
  } catch {
    return null;
  }
}

export function resolveRestoredScreen(
  profileId: string,
  role: string | null | undefined,
  permissions: ReadonlySet<string>,
): number {
  const landing = roleLandingScreen(role);
  if (typeof window === 'undefined') return landing;
  const epoch = currentEpoch(profileId);
  const fromHistory = historyScreen(window.history.state, profileId, epoch);
  const candidate = fromHistory === undefined ? storedScreen(profileId, epoch) : fromHistory;
  return candidate !== null && candidate !== undefined && isScreenRestorable(candidate, role, permissions)
    ? candidate
    : landing;
}

export function screenFromPopState(
  state: unknown,
  profileId: string,
  role: string | null | undefined,
  permissions: ReadonlySet<string>,
): number {
  const candidate = historyScreen(state, profileId, currentEpoch(profileId));
  return candidate !== null && candidate !== undefined && isScreenRestorable(candidate, role, permissions)
    ? candidate
    : roleLandingScreen(role);
}

export function rememberScreen(
  profileId: string,
  screen: number,
  mode: 'push' | 'replace' | 'storage-only',
): void {
  if (typeof window === 'undefined') return;
  const epoch = ensureEpoch(profileId);
  if (epoch === null) return;
  try {
    window.sessionStorage.setItem(storageKey(profileId), JSON.stringify({ epoch, screen }));
  } catch {
    // Privacy-restricted browsers keep history/in-memory navigation working.
  }
  if (mode === 'storage-only') return;
  const state: ScreenHistoryState = { [HISTORY_KEY]: { profileId, epoch, screen } };
  // No URL argument: pathname, query and hash stay byte-for-byte unchanged.
  if (mode === 'push') window.history.pushState(state, '');
  else window.history.replaceState(state, '');
}

export function clearRememberedScreen(profileId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(storageKey(profileId));
    window.sessionStorage.removeItem(epochKey(profileId));
  } catch {
    // Nothing else is required for restricted storage.
  }
  volatileEpochs.delete(profileId);
  window.history.replaceState(null, '');
}
