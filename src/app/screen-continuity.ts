import { institutionsScreenAccess, roleLandingScreen } from '@/shared/authz/screen-access';

const STORAGE_PREFIX = 'medistock-phoenix-screen:';
const HISTORY_KEY = 'medistockPhoenixScreen';

interface ScreenHistoryState {
  [HISTORY_KEY]: { profileId: string; screen: number };
}

/** Restoration allow-list only; this does not change any direct screen gate. */
export function isScreenRestorable(
  screen: number,
  role: string | null | undefined,
  permissions: ReadonlySet<string>,
): boolean {
  if (![3, 6, 11, 13, 14, 15, 17, 18, 19, 21].includes(screen)) return false;
  if (screen === 11) return institutionsScreenAccess(role) !== false;
  if (screen === 14) return role === 'super_admin' || permissions.has('users.view');
  if (screen === 17) return role === 'super_admin' || permissions.has('users.edit_scope');
  return true;
}

function storageKey(profileId: string): string {
  return `${STORAGE_PREFIX}${profileId}`;
}

function historyScreen(state: unknown, profileId: string): number | null | undefined {
  if (state === null || typeof state !== 'object') return undefined;
  const value = (state as Partial<ScreenHistoryState>)[HISTORY_KEY];
  if (value === undefined) return undefined;
  if (!value || value.profileId !== profileId || !Number.isInteger(value.screen)) return null;
  return value.screen;
}

function storedScreen(profileId: string): number | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(profileId));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : null;
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
  const fromHistory = historyScreen(window.history.state, profileId);
  const candidate = fromHistory === undefined ? storedScreen(profileId) : fromHistory;
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
  const candidate = historyScreen(state, profileId);
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
  try {
    window.sessionStorage.setItem(storageKey(profileId), String(screen));
  } catch {
    // Privacy-restricted browsers keep history/in-memory navigation working.
  }
  if (mode === 'storage-only') return;
  const state: ScreenHistoryState = { [HISTORY_KEY]: { profileId, screen } };
  // No URL argument: pathname, query and hash stay byte-for-byte unchanged.
  if (mode === 'push') window.history.pushState(state, '');
  else window.history.replaceState(state, '');
}

export function clearRememberedScreen(profileId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(storageKey(profileId));
  } catch {
    // Nothing else is required for restricted storage.
  }
  window.history.replaceState(null, '');
}
