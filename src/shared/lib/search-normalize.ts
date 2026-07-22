/**
 * SMART-SEARCH-HOTFIX-A — bilingual search normalization + match highlighting.
 *
 * Pure text utilities (no DOM, no network) shared by the command palette's
 * institution search. Arabic text is matched insensitively to the variants an
 * operator actually types: hamza seats (أ إ آ ٱ → ا), taa marbuta (ة → ه),
 * final yaa (ى → ي), hamza carriers (ؤ → و, ئ → ي), and with every haraka /
 * shadda / sukun / dagger-alif / tatweel stripped. English matches
 * case-insensitively. NFKC folds presentation forms first.
 */

/** Harakat + shadda/sukun (U+064B–U+0652), dagger alif (U+0670), tatweel (U+0640). */
const STRIP = /[ً-ْٰـ]/;

/** Normalize ONE character (post-NFKC, post-lowercase); '' means "dropped". */
function normalizeChar(ch: string): string {
  if (STRIP.test(ch)) return '';
  switch (ch) {
    case 'أ': case 'إ': case 'آ': case 'ٱ': return 'ا';
    case 'ؤ': return 'و';
    case 'ئ': return 'ي';
    case 'ى': return 'ي';
    case 'ة': return 'ه';
    default: return ch;
  }
}

/** Canonical, match-ready form of any Arabic/English text. */
export function normalizeSearchText(input: string): string {
  let out = '';
  for (const ch of input.normalize('NFKC').toLowerCase()) out += normalizeChar(ch);
  return out.trim();
}

export interface MatchRange {
  /** Match start/end (exclusive) as indices into the ORIGINAL string. */
  start: number;
  end: number;
}

/**
 * Locate `query` inside `text` under normalization, and map the hit back to a
 * character range of the ORIGINAL string so the UI can highlight exactly what
 * the operator sees. Returns null when there is no match. The index map is
 * built per call — inputs here are short labels, not documents.
 */
export function findNormalizedMatch(text: string, query: string): MatchRange | null {
  const q = normalizeSearchText(query);
  if (!q) return null;

  // Build the normalized string alongside a map from each normalized char to
  // the index of the original char that produced it. NFKC can merge or split
  // characters; we walk the ORIGINAL string so map indices stay original.
  let norm = '';
  const map: number[] = [];
  let originalIndex = 0;
  for (const ch of text) {
    const folded = ch.normalize('NFKC').toLowerCase();
    for (const f of folded) {
      const n = normalizeChar(f);
      if (n !== '') {
        norm += n;
        map.push(originalIndex);
      }
    }
    originalIndex += ch.length;
  }

  const hit = norm.indexOf(q);
  if (hit === -1) return null;
  const lastNormIndex = hit + q.length - 1;
  const startOriginal = map[hit];
  // End = start of the original char after the last matched one.
  const endOriginal = lastNormIndex + 1 < map.length ? map[lastNormIndex + 1] : text.length;
  return { start: startOriginal, end: endOriginal };
}

/** True when `query` matches `text` under normalization. */
export function normalizedIncludes(text: string, query: string): boolean {
  return findNormalizedMatch(text, query) !== null;
}
