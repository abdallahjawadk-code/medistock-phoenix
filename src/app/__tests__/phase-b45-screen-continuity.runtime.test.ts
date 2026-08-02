/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearRememberedScreen,
  isScreenRestorable,
  rememberScreen,
  resolveRestoredScreen,
  screenFromPopState,
} from '../screen-continuity';

const USER_A = 'user-a';
const USER_B = 'user-b';

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/continuity?keep=1#anchor');
  vi.restoreAllMocks();
});

describe('PHASE B4 — safe profile-scoped screen continuity', () => {
  it('restores an allowed screen across reload without changing path, query or hash', () => {
    rememberScreen(USER_A, 15, 'replace');
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(15);
    expect(window.location.pathname + window.location.search + window.location.hash)
      .toBe('/continuity?keep=1#anchor');
  });

  it('uses browser history for back/forward without adding a route loop', () => {
    const push = vi.spyOn(window.history, 'pushState');
    rememberScreen(USER_A, 3, 'replace');
    rememberScreen(USER_A, 15, 'push');
    expect(screenFromPopState({ medistockPhoenixScreen: { profileId: USER_A, screen: 3 } }, USER_A, 'warehouse_officer', new Set())).toBe(3);
    expect(screenFromPopState({ medistockPhoenixScreen: { profileId: USER_A, screen: 15 } }, USER_A, 'warehouse_officer', new Set())).toBe(15);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('falls back to the role landing for invalid and unauthorized restored state', () => {
    window.history.replaceState({ medistockPhoenixScreen: { profileId: USER_A, screen: 999 } }, '');
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(21);
    window.history.replaceState({ medistockPhoenixScreen: { profileId: USER_A, screen: 11 } }, '');
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(21);
    window.history.replaceState({ medistockPhoenixScreen: { profileId: USER_A, screen: 14 } }, '');
    expect(resolveRestoredScreen(USER_A, 'outlet_officer', new Set())).toBe(18);
  });

  it('never lets user B inherit user A history or storage', () => {
    rememberScreen(USER_A, 15, 'replace');
    expect(resolveRestoredScreen(USER_B, 'outlet_officer', new Set())).toBe(18);
  });

  it('logout cleanup removes saved screen and history state', () => {
    rememberScreen(USER_A, 15, 'replace');
    clearRememberedScreen(USER_A);
    expect(window.sessionStorage.getItem(`medistock-phoenix-screen:${USER_A}`)).toBeNull();
    expect(window.history.state).toBeNull();
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(21);
  });

  it('preserves existing permissions and keeps every B3-hidden screen non-restorable', () => {
    expect(isScreenRestorable(11, 'institution_admin', new Set())).toBe(true);
    expect(isScreenRestorable(14, 'warehouse_officer', new Set(['users.view']))).toBe(true);
    expect(isScreenRestorable(17, 'warehouse_officer', new Set(['users.edit_scope']))).toBe(true);
    expect(isScreenRestorable(11, 'warehouse_officer', new Set(['users.view']))).toBe(false);
    for (const hidden of [4, 5, 7, 8, 10, 16]) {
      expect(isScreenRestorable(hidden, 'super_admin', new Set(['users.view', 'users.edit_scope']))).toBe(false);
    }
  });
});
