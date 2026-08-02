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
    const firstState = window.history.state;
    rememberScreen(USER_A, 15, 'push');
    const secondState = window.history.state;
    expect(screenFromPopState(firstState, USER_A, 'warehouse_officer', new Set())).toBe(3);
    expect(screenFromPopState(secondState, USER_A, 'warehouse_officer', new Set())).toBe(15);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('falls back to the role landing for invalid and unauthorized restored state', () => {
    rememberScreen(USER_A, 999, 'replace');
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(21);
    rememberScreen(USER_A, 11, 'replace');
    expect(resolveRestoredScreen(USER_A, 'warehouse_officer', new Set())).toBe(21);
    rememberScreen(USER_A, 14, 'replace');
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

  it('rejects every history entry from the previous session, even for the same user', () => {
    rememberScreen(USER_A, 15, 'replace');
    const previousSessionState = window.history.state;

    clearRememberedScreen(USER_A);
    rememberScreen(USER_A, 21, 'replace');

    expect(screenFromPopState(
      previousSessionState,
      USER_A,
      'warehouse_officer',
      new Set(),
    )).toBe(21);
  });

  it('fails closed to the role landing when continuity storage is restricted', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked');
    });

    expect(resolveRestoredScreen(USER_A, 'outlet_officer', new Set())).toBe(18);
    rememberScreen(USER_A, 15, 'replace');
    expect(resolveRestoredScreen(USER_A, 'outlet_officer', new Set())).toBe(15);

    clearRememberedScreen(USER_A);
    expect(screenFromPopState(window.history.state, USER_A, 'outlet_officer', new Set())).toBe(18);

    getItem.mockRestore();
    setItem.mockRestore();
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
