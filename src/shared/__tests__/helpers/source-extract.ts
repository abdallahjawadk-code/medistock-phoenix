/**
 * SOURCE-EXTRACT-A — semantic, bounded source extraction for static tests (test-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * A large family of tests in this repo asserts on *source text* rather than on
 * rendered components (see `outlet-report-field-selector.test.ts`,
 * `quantity-overwrite-guard.test.ts`, …). That convention is deliberate and is
 * not what this module changes. What it changes is *how* those tests carve a
 * region of source out before asserting on it.
 *
 * The original pattern was:
 *
 *     const start = src.indexOf('function printReport()');
 *     const body  = src.slice(start, start + 400);   // magic character window
 *
 * Two independent defects follow from that shape:
 *
 *   1. THE WINDOW IS A GUESS. `start + 400` has no relationship to where the
 *      function actually ends. Adding a comment or a line inside the function
 *      silently pushes the assertion target out of the window, and the test
 *      fails with `expected '…' to contain '…'` while the invariant it guards
 *      is perfectly intact. Equally bad in the other direction: the window can
 *      overshoot into the *next* function, so the test passes on evidence that
 *      came from code it was never meant to inspect.
 *
 *   2. A MISSING ANCHOR DEGRADES SILENTLY. `indexOf` returns `-1` on a miss,
 *      and `-1` is a perfectly legal argument to `slice`. So a failed anchor
 *      does not report "anchor not found" — it reports a bizarre downstream
 *      assertion against a 4-character string, or an `expected -1 to be greater
 *      than -1` comparison. The observed CI failure
 *      `expected 'asyn' to contain 'Array.from(selectedFields)…'` is exactly
 *      this: `indexOf('\n  }\n')` missed, `end` collapsed to `start + 4`, and
 *      the "evidence" became the first four characters of `async`.
 *
 * The anchors that missed in CI did so because several sources in this repo are
 * committed with CRLF (`git ls-files --eol` reports `i/crlf` for
 * `EditorScreen.tsx`, `StatusCenterScreen.tsx`, `StatusEditorScreen.tsx`,
 * `OutletAvailabilityReportModal.tsx`, `strings.ts`) while the anchors were
 * written with `\n`. That is a real defect in the extraction layer, not
 * environmental noise to be waived: a test that guards a business invariant
 * must report on that invariant, and must do so identically on every platform.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE GUARANTEES
 * ─────────────────────────────────────────────────────────────────────────────
 *   • Sources are read newline-normalized, so a region and every anchor are
 *     byte-identical regardless of how the file was checked out.
 *   • Every anchor lookup THROWS a named, actionable error when it misses. An
 *     absent anchor can never decay into a passing test or into a misleading
 *     assertion about unrelated text.
 *   • Region bounds are derived from the code's own bracket structure, so a
 *     region is exactly one construct — never a truncated prefix of it, and
 *     never a spill into the following construct.
 *
 * This module only *locates* text. It makes no judgement about any business or
 * safety rule; the assertions in the test files remain the sole authority on
 * what the source must say.
 *
 * Read-only: nothing here writes to disk.
 */
import { readFileSync } from 'fs';

/** Bracket pairs the balanced scanner understands. */
const CLOSER_FOR: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/**
 * Read a source file with newlines normalized to `\n`.
 *
 * Every extraction helper below assumes normalized input, and every anchor in
 * the test files is written with `\n`. Normalizing once at read time is what
 * makes CRLF- and LF-checked-out trees produce identical results.
 */
export function readSourceFile(absPath: string): string {
  return readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Index of `anchor` in `src`, or a thrown error naming the anchor that missed.
 *
 * This is the single reason a mistyped or stale anchor now fails loudly instead
 * of silently producing a `-1`-seeded slice.
 */
export function anchorIndex(src: string, anchor: string, from = 0): number {
  const idx = src.indexOf(anchor, from);
  if (idx === -1) {
    throw new Error(
      `source-extract: anchor not found: ${JSON.stringify(anchor)}\n` +
        'The source no longer contains this text. Either the guarded code moved ' +
        '(update the anchor) or the invariant was removed (that is a real regression).',
    );
  }
  return idx;
}

/** Whether `src` contains `anchor` — for tests that assert on presence itself. */
export function hasAnchor(src: string, anchor: string): boolean {
  return src.includes(anchor);
}

/**
 * Walk `src` from `i` past any string literal, template literal or comment that
 * starts there, returning the index just after it. Returns `i` unchanged when
 * nothing special starts at `i`.
 *
 * Bracket counting must ignore brackets that live inside quotes and comments,
 * or a region ending would be picked from a `'}'` in a string. Template
 * literals are scanned as a unit, which deliberately also swallows any `${…}`
 * interpolation — safe here because no anchor targets the inside of one.
 */
function skipNonCode(src: string, i: number): number {
  const c = src[i];
  const next = src[i + 1];

  if (c === '/' && next === '/') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }
  if (c === '/' && next === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      // An unterminated quote would otherwise run to EOF; a newline ends the
      // two non-template forms, matching how the parser would recover.
      if (c !== '`' && src[j] === '\n') return j;
      j++;
    }
    return src.length;
  }
  return i;
}

/**
 * The region starting at `anchor` and ending at the bracket that closes the
 * first `{`, `(` or `[` opened at or after the anchor.
 *
 * This is the semantic replacement for `slice(start, start + N)`: the returned
 * text is exactly the anchored construct — a function body, a `useMemo(…)`
 * call, an array/object literal, a JSX expression container — with no guessed
 * width. Brackets inside strings and comments are not counted.
 *
 * @param anchor  Text that begins the construct, e.g. `'function printReport()'`.
 */
export function balancedBlockAt(src: string, anchor: string, from = 0): string {
  const start = anchorIndex(src, anchor, from);

  // Where to begin looking for the construct's opening bracket. An anchor that
  // already ends with one (`… FieldDefinition[] = [`) names that bracket, so it
  // is the bracket to balance. Otherwise the anchor is a prefix such as
  // `function toggleField(key: string)` whose own parentheses must be stepped
  // over so the *body* brace is balanced rather than the parameter list.
  const lastChar = anchor[anchor.length - 1];
  let i = lastChar in CLOSER_FOR ? start + anchor.length - 1 : start + anchor.length;
  let opener = '';
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] in CLOSER_FOR) { opener = src[i]; break; }
    i++;
  }
  if (!opener) {
    throw new Error(
      `source-extract: no opening bracket found after anchor ${JSON.stringify(anchor)}`,
    );
  }

  const closer = CLOSER_FOR[opener];
  let depth = 0;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] === opener) depth++;
    else if (src[i] === closer) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  throw new Error(
    `source-extract: unbalanced ${opener}${closer} after anchor ${JSON.stringify(anchor)}`,
  );
}

/**
 * The initializer of the `const`/`let` declaration named by `anchor`.
 *
 * `balancedBlockAt(src, 'const AVAIL_EXPORT_COLUMNS')` would balance the `[]`
 * of the *type annotation* (`: AvailExportColumnDef[]`) and return an empty
 * pair. This helper steps over the annotation to the declaration's `=` and
 * balances the value that follows, so a caller does not have to restate a long
 * inline type just to pin the region — and cannot get a silently empty one.
 *
 * @param anchor  The declaration head, e.g. `'const AVAIL_EXPORT_COLUMNS'`.
 */
export function declarationValueAt(src: string, anchor: string, from = 0): string {
  const start = anchorIndex(src, anchor, from);
  let i = start + anchor.length;

  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i];
    if (c in CLOSER_FOR) { i = matchingBracketEnd(src, i); continue; }
    if (c === '=' && src[i + 1] !== '=' && src[i + 1] !== '>') break;
    if (c === ';' || c === '\n' && src[i - 1] === ';') {
      throw new Error(
        `source-extract: ${JSON.stringify(anchor)} has no initializer`,
      );
    }
    i++;
  }
  if (i >= src.length) {
    throw new Error(`source-extract: no '=' found after ${JSON.stringify(anchor)}`);
  }

  // Balance the value itself, starting from the first bracket after '='.
  let j = i + 1;
  while (j < src.length) {
    const skipped = skipNonCode(src, j);
    if (skipped !== j) { j = skipped; continue; }
    if (src[j] in CLOSER_FOR) {
      return src.slice(start, matchingBracketEnd(src, j));
    }
    j++;
  }
  throw new Error(
    `source-extract: no bracketed value found after ${JSON.stringify(anchor)}`,
  );
}

/**
 * The body of the function named by `anchor`, from the anchor through the brace
 * that closes the body.
 *
 * Distinct from {@link balancedBlockAt} because a function declaration has a
 * parameter list in the way: balancing the first bracket after
 * `function PortAvailabilitySection` would return its destructured props, not
 * the code under test. This helper steps over any parameter list, generic
 * arguments and return-type annotation, then balances the body brace.
 *
 * Use this for `function foo`, `async function foo`, `export async function
 * foo` anchors; use {@link balancedBlockAt} for calls, literals and JSX.
 */
export function functionBodyAt(src: string, anchor: string, from = 0): string {
  const start = anchorIndex(src, anchor, from);
  let i = start + anchor.length;

  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i];
    // Parameter list / tuple or array types in the signature: step over whole.
    if (c === '(' || c === '[') { i = matchingBracketEnd(src, i); continue; }
    if (c === '{') {
      const end = matchingBracketEnd(src, i);
      return src.slice(start, end);
    }
    if (c === ';') {
      throw new Error(
        `source-extract: ${JSON.stringify(anchor)} has no body (declaration only)`,
      );
    }
    i++;
  }
  throw new Error(`source-extract: no function body found after ${JSON.stringify(anchor)}`);
}

/**
 * The signature (parameter list) of the function named by `anchor`, excluding
 * its body.
 *
 * Matters most for negative assertions such as "PortCard does not receive an
 * actorRole prop": with a fixed character window, a window that is too short
 * makes `not.toContain` pass for the wrong reason, and one that is too long
 * reaches into the body and can fail for the wrong reason. Bounding on the
 * parameter list means the assertion can only be about the parameter list.
 */
export function signatureAt(src: string, anchor: string, from = 0): string {
  const start = anchorIndex(src, anchor, from);
  let i = start + anchor.length;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] === '(') return src.slice(start, matchingBracketEnd(src, i));
    if (src[i] === '{') break;
    i++;
  }
  throw new Error(`source-extract: no parameter list found for ${JSON.stringify(anchor)}`);
}

/**
 * The single statement beginning at `anchor`, up to its terminating `;`.
 *
 * For multi-line expressions that are not a single bracketed construct — a
 * `const canSubmit = a && (b || c) && …;` chain, for example — where balancing
 * one bracket would stop at the first parenthesised group and a fixed window
 * would cut the chain at an arbitrary point. Semicolons inside brackets,
 * strings and comments do not terminate the statement.
 */
export function statementAt(src: string, anchor: string, from = 0): string {
  const start = anchorIndex(src, anchor, from);
  let i = start + anchor.length;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] in CLOSER_FOR) { i = matchingBracketEnd(src, i); continue; }
    if (src[i] === ';') return src.slice(start, i + 1);
    i++;
  }
  throw new Error(`source-extract: no ';' terminating statement at ${JSON.stringify(anchor)}`);
}

/**
 * The contiguous comment block immediately above the line containing `anchor`.
 *
 * Replaces `slice(idx - 700, idx)` for the tests that assert a deployment or
 * safety note is documented next to the code it governs. A fixed look-back
 * window either misses a comment that grew past it or picks up unrelated code
 * above it; walking whole comment lines returns exactly the attached block, and
 * throws when there is none — which is what "the note was deleted" should look
 * like.
 */
export function precedingComment(src: string, anchor: string, from = 0): string {
  const idx = anchorIndex(src, anchor, from);
  const lines = src.slice(0, idx).split('\n');
  lines.pop(); // partial line holding the anchor

  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    const isComment =
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.endsWith('*/');
    if (!isComment) break;
    collected.unshift(lines[i]);
  }
  if (collected.length === 0) {
    throw new Error(
      `source-extract: no comment block immediately above ${JSON.stringify(anchor)}`,
    );
  }
  return collected.join('\n');
}

/**
 * The region from `startAnchor` up to and including `endAnchor`.
 *
 * For constructs whose end is a literal token rather than a bracket (for
 * example a `const … = [` … `];` declaration). Both anchors are required to
 * exist, and `endAnchor` is searched only *after* `startAnchor`, so the region
 * can never invert or be drawn from an earlier unrelated match.
 */
export function blockBetween(src: string, startAnchor: string, endAnchor: string): string {
  const start = anchorIndex(src, startAnchor);
  const end = anchorIndex(src, endAnchor, start + startAnchor.length);
  return src.slice(start, end + endAnchor.length);
}

/**
 * The opening JSX tag that encloses `anchor`.
 *
 * Replaces the `slice(idx - 300, idx)` "look backwards a few hundred characters
 * and hope the tag is in there" pattern used to assert on a sibling prop of a
 * known prop (e.g. that the element carrying `onClick={exportXlsx}` also
 * carries `disabled={…}`). The tag is located by scanning back to the `<` that
 * opens it, so the result is the whole tag and nothing from the tag before it.
 */
export function enclosingJsxTag(src: string, anchor: string): string {
  const idx = anchorIndex(src, anchor);
  const open = src.lastIndexOf('<', idx);
  if (open === -1) {
    throw new Error(
      `source-extract: no enclosing JSX tag found for anchor ${JSON.stringify(anchor)}`,
    );
  }
  // Extend to the tag's own '>' so callers see the complete attribute list,
  // including any attribute written after the anchoring one.
  let i = idx;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] === '{') { i = matchingBracketEnd(src, i); continue; }
    if (src[i] === '>') return src.slice(open, i + 1);
    i++;
  }
  return src.slice(open, idx);
}

/** Index just past the bracket matching the one at `openIdx`. */
function matchingBracketEnd(src: string, openIdx: number): number {
  const opener = src[openIdx];
  const closer = CLOSER_FOR[opener];
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const skipped = skipNonCode(src, i);
    if (skipped !== i) { i = skipped; continue; }
    if (src[i] === opener) depth++;
    else if (src[i] === closer) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/**
 * The innermost `<tag>…</tag>` element that encloses `anchor`.
 *
 * Some assertions are about a *field group* rather than a single tag — that the
 * quantity input's edit-mode helper text sits beside the input, for instance.
 * The old `slice(idx - 50, idx + 1200)` form guessed at that grouping; this
 * matches the element's real open/close pair, so the region is the group the
 * markup actually defines. Self-closing tags do not open a nesting level.
 */
export function jsxElementContaining(src: string, anchor: string, tag = 'div'): string {
  const idx = anchorIndex(src, anchor);
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'g');

  // Candidate opening tags before the anchor, innermost (nearest) first.
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null && m.index < idx) starts.push(m.index);

  for (let i = starts.length - 1; i >= 0; i--) {
    const end = jsxElementEnd(src, starts[i], tag);
    if (end > idx) return src.slice(starts[i], end);
  }
  throw new Error(
    `source-extract: no enclosing <${tag}> found for anchor ${JSON.stringify(anchor)}`,
  );
}

/** Index just past the `</tag>` that closes the element opening at `openIdx`. */
function jsxElementEnd(src: string, openIdx: number, tag: string): number {
  const token = new RegExp(`<${tag}(?=[\\s/>])|</${tag}>`, 'g');
  token.lastIndex = openIdx;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(src)) !== null) {
    if (m[0].startsWith('</')) {
      if (--depth === 0) return m.index + m[0].length;
    } else {
      // A self-closing `<tag … />` never opens a level.
      const tagEnd = src.indexOf('>', m.index);
      if (tagEnd !== -1 && src[tagEnd - 1] === '/') continue;
      depth++;
    }
  }
  return src.length;
}

/**
 * The statement beginning at the nearest `outerAnchor` at or before
 * `innerAnchor` — i.e. the statement that *contains* `innerAnchor`.
 *
 * For assertions about a hook's dependency array made from inside its body:
 * `statementAt(src, 'useEffect(')` would find the next effect, not the one the
 * inner anchor lives in. Searching backwards from the inner anchor pins the
 * region to the enclosing statement, so the deps asserted on are unambiguously
 * the deps of the effect that runs the asserted body.
 */
export function statementContaining(
  src: string,
  outerAnchor: string,
  innerAnchor: string,
): string {
  const inner = anchorIndex(src, innerAnchor);
  const outer = src.lastIndexOf(outerAnchor, inner);
  if (outer === -1) {
    throw new Error(
      `source-extract: no ${JSON.stringify(outerAnchor)} before ${JSON.stringify(innerAnchor)}`,
    );
  }
  return statementAt(src, outerAnchor, outer);
}

/**
 * Ordered positions of several anchors, for tests asserting on relative order
 * (e.g. "the removed-row branch is rendered before the default branch").
 *
 * The old form compared raw `indexOf` results, so a missing anchor produced
 * `expected -1 to be greater than -1` — a comparison of two absences that says
 * nothing about ordering. Here every anchor must exist before any comparison is
 * possible, so an ordering test can only fail for genuine ordering reasons.
 */
export function orderedPositions(src: string, anchors: string[]): number[] {
  return anchors.map(a => anchorIndex(src, a));
}
