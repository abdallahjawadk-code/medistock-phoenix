/**
 * BUGFIX-REPORTS-DATES-PORT-CLEAR-A
 *
 * Stable, locale-independent date/time formatting for the RTL Arabic UI.
 *
 * Why not `Date.prototype.toLocaleString('ar', ...)`: in an RTL (Arabic)
 * layout, a slash/colon-separated digit string embedded without an explicit
 * LTR override is subject to the Unicode Bidi Algorithm, which can visually
 * reorder the separated digit groups (e.g. "2026/7/3" rendering as
 * "3/7/2026" or worse, concatenating groups into something like
 * "32026/7/"). `toLocaleString('ar', ...)` also depends on the runtime's
 * ICU data for the 'ar' locale, which is inconsistent across browsers/build
 * targets and can silently produce different digit sets (Western vs.
 * Arabic-Indic) or ordering.
 *
 * These helpers sidestep both problems: they build a fixed-order string by
 * hand (never locale-formatted), so the VALUE itself is always stable and
 * safe to place directly in a CSV cell. Callers must still render the
 * result inside a `dir="ltr"` element (or a printed-HTML tag with
 * `dir="ltr"`) — a stable digit string can still visually reorder if left
 * in RTL flow without that override.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYY/MM/DD` (ar) or `YYYY-MM-DD` (en). Returns '—' for null/invalid input. */
export function formatStableDate(iso: string | Date | null | undefined, lang: 'ar' | 'en'): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return lang === 'ar' ? `${y}/${m}/${day}` : `${y}-${m}-${day}`;
}

/** `YYYY/MM/DD hh:mm:ss ص|م` (ar) or `YYYY-MM-DD hh:mm:ss AM|PM` (en). Returns '—' for null/invalid input. */
export function formatStableDateTime(iso: string | Date | null | undefined, lang: 'ar' | 'en'): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  const datePart = formatStableDate(d, lang);
  const h = d.getHours();
  const min = pad2(d.getMinutes());
  const sec = pad2(d.getSeconds());
  const period = lang === 'ar' ? (h < 12 ? 'ص' : 'م') : (h < 12 ? 'AM' : 'PM');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${datePart} ${pad2(h12)}:${min}:${sec} ${period}`;
}
