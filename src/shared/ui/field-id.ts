/**
 * SHARED FIELD ID DERIVATION — one rule for every Phoenix form field.
 *
 * A caller-supplied `id` always wins and is returned verbatim; this helper is
 * only reached when a field has no explicit id of its own.
 *
 * The id it builds keeps a readable label slug as a PREFIX purely so the DOM
 * stays debuggable, but uniqueness comes ENTIRELY from `reactId` — React's
 * `useId()` value, which is unique per component instance and, critically,
 * identical between the server and client render, so hydration does not
 * mismatch. Nothing here derives from an array index, a random number, a
 * timestamp, a mutable module counter, or a business identifier, all of which
 * would be unstable across rerenders, unsafe for SSR, or both.
 *
 * WHY THIS EXISTS. Both `PhoenixInput` and `PhoenixSelect` previously fell back
 * to the label slug ALONE (`id ?? label?.toLowerCase().replace(/\s+/g,'-') ??
 * generatedId`), which made the `useId()` branch unreachable whenever a label
 * was present. Two fields sharing a label — the ordinary result of rendering a
 * form row inside a `.map()` — therefore rendered the same DOM id. That is
 * invalid HTML, and it silently breaks label association for every occurrence
 * after the first, because `getElementById`, the DOM `label.control` property
 * and assistive technology all resolve to the first match in document order.
 */

/** `useId()` wraps its value in colons (`:r0:`), which are not selector-safe. */
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '');

/**
 * Builds a unique, stable, selector-safe DOM id for a labelled field.
 *
 * @param reactId a `useId()` value from the calling component instance
 * @param label   the field's visible label, used only as a readable prefix
 */
export function fieldId(reactId: string, label?: string): string {
  const unique = sanitize(reactId);
  const slug = sanitize((label ?? '').toLowerCase().replace(/\s+/g, '-'));
  return slug ? `${slug}-${unique}` : unique;
}
