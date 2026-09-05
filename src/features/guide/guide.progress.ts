/**
 * INTERACTIVE-GUIDE-IG1 — local, NON-IDENTIFYING tour progress (AD-06).
 *
 * What is stored, exhaustively: a schema version, the tour id, the step id,
 * the completed tour ids, and a coarse timestamp.
 *
 * What is deliberately NOT stored, and must never be added here: a user id, an
 * organization id, a material, batch, stock, patient or visit identifier, a
 * screen number tied to a record, or any text that was visible on screen. The
 * guide is a UI aid; its persistence must stay uninteresting to anyone who
 * reads it out of a shared workstation's browser storage.
 *
 * Every read is defensive. A corrupt, truncated, foreign, older or NEWER
 * schema resolves to "no progress" and is not migrated by guesswork — a
 * forward-version value is left untouched on disk rather than overwritten,
 * so an older tab cannot destroy a newer tab's state.
 */

export const GUIDE_PROGRESS_STORAGE_KEY = 'medistock.phoenix.guide.progress';

/** Bump ONLY when the stored shape changes. A mismatch resets, never migrates. */
export const GUIDE_PROGRESS_SCHEMA_VERSION = 1;

export interface GuideProgress {
  /** The tour currently in progress, or null when none is open. */
  tourId: string | null;
  /** The step within `tourId`, or null. Never an index — indices shift. */
  stepId: string | null;
  /** Tour ids finished at least once. */
  completedTourIds: string[];
  /** Milliseconds since the epoch. Coarse, and about the guide only. */
  updatedAt: number;
}

export const EMPTY_PROGRESS: GuideProgress = {
  tourId: null,
  stepId: null,
  completedTourIds: [],
  updatedAt: 0,
};

interface StoredProgress extends GuideProgress {
  v: number;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function sanitize(parsed: unknown): GuideProgress | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<StoredProgress>;
  if (candidate.v !== GUIDE_PROGRESS_SCHEMA_VERSION) return null;
  if (!isStringOrNull(candidate.tourId ?? null)) return null;
  if (!isStringOrNull(candidate.stepId ?? null)) return null;

  const completed = Array.isArray(candidate.completedTourIds)
    ? candidate.completedTourIds.filter((id): id is string => typeof id === 'string')
    : [];
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? candidate.updatedAt
    : 0;

  return {
    tourId: candidate.tourId ?? null,
    stepId: candidate.stepId ?? null,
    completedTourIds: completed,
    updatedAt,
  };
}

/** Read stored progress. Any unreadable or unrecognised value reads as empty. */
export function readGuideProgress(): GuideProgress {
  if (typeof window === 'undefined') return EMPTY_PROGRESS;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(GUIDE_PROGRESS_STORAGE_KEY);
  } catch {
    return EMPTY_PROGRESS;
  }
  if (!raw) return EMPTY_PROGRESS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_PROGRESS;
  }
  return sanitize(parsed) ?? EMPTY_PROGRESS;
}

/** Persist progress. Storage being unavailable never breaks the guide. */
export function writeGuideProgress(progress: GuideProgress): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      GUIDE_PROGRESS_STORAGE_KEY,
      JSON.stringify({ v: GUIDE_PROGRESS_SCHEMA_VERSION, ...progress } satisfies StoredProgress),
    );
  } catch {
    // The tour still runs; only "resume after reload" is lost.
  }
}

/** Forget everything the guide remembers. Offered permanently in the Help Center. */
export function clearGuideProgress(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(GUIDE_PROGRESS_STORAGE_KEY);
  } catch {
    // Nothing to clean up in a restricted storage environment.
  }
}

/** Record where a tour currently stands. */
export function rememberPosition(previous: GuideProgress, tourId: string, stepId: string): GuideProgress {
  return { ...previous, tourId, stepId, updatedAt: Date.now() };
}

/** Record a tour as finished and close it out. */
export function rememberCompletion(previous: GuideProgress, tourId: string): GuideProgress {
  const completedTourIds = previous.completedTourIds.includes(tourId)
    ? previous.completedTourIds
    : [...previous.completedTourIds, tourId];
  return { tourId: null, stepId: null, completedTourIds, updatedAt: Date.now() };
}

/** Close the tour without marking it complete (the operator left it). */
export function rememberClosed(previous: GuideProgress): GuideProgress {
  return { ...previous, updatedAt: Date.now() };
}
