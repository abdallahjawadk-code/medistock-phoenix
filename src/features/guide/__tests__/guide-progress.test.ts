// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PROGRESS,
  GUIDE_PROGRESS_SCHEMA_VERSION,
  GUIDE_PROGRESS_STORAGE_KEY,
  clearGuideProgress,
  readGuideProgress,
  rememberClosed,
  rememberCompletion,
  rememberPosition,
  writeGuideProgress,
} from '../guide.progress';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('guide progress — round trip', () => {
  it('reads empty progress when nothing is stored', () => {
    expect(readGuideProgress()).toEqual(EMPTY_PROGRESS);
  });

  it('writes and reads back a position', () => {
    writeGuideProgress(rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'shell.language'));
    const stored = readGuideProgress();
    expect(stored.tourId).toBe('guide.tour.orientation');
    expect(stored.stepId).toBe('shell.language');
    expect(stored.updatedAt).toBeGreaterThan(0);
  });

  it('records completion and closes the tour out', () => {
    const finished = rememberCompletion(
      rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'closing'),
      'guide.tour.orientation',
    );
    expect(finished.tourId).toBeNull();
    expect(finished.stepId).toBeNull();
    expect(finished.completedTourIds).toEqual(['guide.tour.orientation']);
  });

  it('does not double-record a tour completed twice', () => {
    const once = rememberCompletion(EMPTY_PROGRESS, 'guide.tour.orientation');
    const twice = rememberCompletion(once, 'guide.tour.orientation');
    expect(twice.completedTourIds).toEqual(['guide.tour.orientation']);
  });

  it('keeps the position when the operator merely leaves the tour', () => {
    const left = rememberClosed(rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'shell.language'));
    expect(left.tourId).toBe('guide.tour.orientation');
    expect(left.stepId).toBe('shell.language');
  });

  it('clears everything on reset', () => {
    writeGuideProgress(rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'welcome'));
    clearGuideProgress();
    expect(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY)).toBeNull();
    expect(readGuideProgress()).toEqual(EMPTY_PROGRESS);
  });
});

describe('guide progress — hostile storage', () => {
  it.each([
    ['not JSON at all', 'definitely-not-json'],
    ['a JSON primitive', '"a string"'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['an older schema', JSON.stringify({ v: 0, tourId: 't', stepId: 's', completedTourIds: [], updatedAt: 1 })],
    ['a FUTURE schema', JSON.stringify({ v: 999, tourId: 't', stepId: 's', completedTourIds: [], updatedAt: 1 })],
    ['a wrong-typed tourId', JSON.stringify({ v: 1, tourId: 42, stepId: 's', completedTourIds: [], updatedAt: 1 })],
  ])('resets safely for %s', (_label, raw) => {
    window.localStorage.setItem(GUIDE_PROGRESS_STORAGE_KEY, raw);
    expect(() => readGuideProgress()).not.toThrow();
    expect(readGuideProgress()).toEqual(EMPTY_PROGRESS);
  });

  it('drops non-string entries out of completedTourIds rather than failing', () => {
    window.localStorage.setItem(GUIDE_PROGRESS_STORAGE_KEY, JSON.stringify({
      v: GUIDE_PROGRESS_SCHEMA_VERSION,
      tourId: null,
      stepId: null,
      completedTourIds: ['ok', 7, null, 'also-ok'],
      updatedAt: 5,
    }));
    expect(readGuideProgress().completedTourIds).toEqual(['ok', 'also-ok']);
  });

  it('leaves a FUTURE schema on disk instead of overwriting it on read', () => {
    // A newer tab may have written it. Reading resets in memory; it must not
    // destroy state this build does not understand.
    const future = JSON.stringify({ v: 999, tourId: 't', stepId: 's', completedTourIds: [], updatedAt: 1 });
    window.localStorage.setItem(GUIDE_PROGRESS_STORAGE_KEY, future);
    readGuideProgress();
    expect(window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY)).toBe(future);
  });

  it('survives storage that throws on read and on write', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readGuideProgress()).toEqual(EMPTY_PROGRESS);
    expect(() => writeGuideProgress(EMPTY_PROGRESS)).not.toThrow();
    expect(() => clearGuideProgress()).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('guide progress — privacy (AD-06)', () => {
  /**
   * The whole point of this module. If a future change adds an identifier to
   * the stored object, this fails: the serialised payload is compared against
   * an exhaustive key allow-list, not scanned for known-bad names.
   */
  it('persists ONLY the declared non-identifying keys', () => {
    writeGuideProgress(rememberCompletion(
      rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'closing'),
      'guide.tour.orientation',
    ));
    const raw = window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort())
      .toEqual(['completedTourIds', 'stepId', 'tourId', 'updatedAt', 'v']);
  });

  it('writes nothing that looks like a user, organization or record identifier', () => {
    writeGuideProgress(rememberPosition(EMPTY_PROGRESS, 'guide.tour.orientation', 'dashboard.kpis'));
    const raw = window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY) ?? '';
    for (const forbidden of [
      /user/i, /profile/i, /organization/i, /org[_-]?id/i, /material/i,
      /batch/i, /patient/i, /visit/i, /stock/i, /email/i,
      // A UUID anywhere in this payload would be a record identity.
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    ]) {
      expect(forbidden.test(raw), `guide progress leaked ${forbidden}`).toBe(false);
    }
  });
});
