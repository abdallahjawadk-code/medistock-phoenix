/**
 * STAGE-G-G3.1 — frontend contract for canonical authenticated availability.
 *
 * Migration 179 makes the read model return one row per canonical physical
 * identity, each carrying its own `unit` and a deterministic non-null
 * `row_key`. Two things in InstitutionScreen had to follow, and both are
 * guarded here as source contracts:
 *
 *  1. The quantity label must use the PHYSICAL row unit. It previously used
 *     `centralOf(r.local_items)?.unit` — the CATALOGUE unit — which is why a
 *     merged "5 box + 3 strip" row rendered as "8 tablet". There must be no
 *     fallback in either direction.
 *  2. The React key must be `row_key`, never `id`. `id` is the
 *     item_availability UUID: it is NULL for stock-only rows (a pre-existing
 *     null-key defect) and 179 can legitimately return two unit-distinct rows
 *     that share one item_availability row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const readSrc = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const screen = readSrc('features/institutions/InstitutionScreen.tsx');

describe('G3.1 · authenticated availability unit + row identity (frontend)', () => {
  it('labels the physical quantity with the physical row unit', () => {
    expect(screen).toContain('{r.quantity} {r.unit ?? \'\'}');
  });

  it('never falls back to the catalogue unit for a physical quantity', () => {
    // Neither direction, and not via the centralOf() helper either.
    expect(screen).not.toMatch(/\{r\.quantity\}\s*\{ci\?\.unit/);
    expect(screen).not.toMatch(/r\.unit\s*\?\?\s*ci\?\.unit/);
    expect(screen).not.toMatch(/ci\?\.unit\s*\?\?\s*r\.unit/);
    expect(screen).not.toMatch(/r\.unit\s*\|\|\s*ci\?\.unit/);
    expect(screen).not.toMatch(/centralOf\([^)]*\)\?\.unit\s*\?\?\s*r\.unit/);
  });

  it('keys availability rows on row_key, with no id or index fallback', () => {
    expect(screen).toContain('key={r.row_key}');
    expect(screen).not.toContain('key={r.id}');
    expect(screen).not.toMatch(/key=\{r\.row_key\s*\?\?/);
    expect(screen).not.toMatch(/key=\{r\.id\s*\?\?/);
    expect(screen).not.toMatch(/key=\{(idx|i|index)\}/);
  });

  it('types the additive server fields on the shared AvailRow contract', () => {
    const start = screen.indexOf('export interface AvailRow');
    const body = screen.slice(start, screen.indexOf('}', screen.indexOf('local_items', start)));
    expect(body).toContain('row_key: string;');
    // `unit` is published on EVERY row by 179 — the key is always present and
    // only its value is nullable, so it must not be declared optional.
    expect(body).toContain('unit: string | null;');
    expect(body).not.toContain('unit?:');
    // `id` is the item_availability UUID and is NULL for stock-only rows. It
    // was declared `string`, which made every honest null check look like dead
    // code to the compiler.
    // Scoped to AvailRow's OWN fields: the nested local_items.id really is a
    // non-null local-item UUID and is not what this contract is about.
    const own = body.slice(0, body.indexOf('local_items'));
    expect(own).toContain('id: string | null;');
    expect(own).not.toMatch(/^\s*id: string;/m);
  });

  it('still renders a null physical unit as quantity alone, inventing nothing', () => {
    // `?? ''` is an empty render, not a catalogue substitution.
    expect(screen).toContain("{r.unit ?? ''}");
    expect(screen).not.toMatch(/r\.unit\s*\?\?\s*'(?!')/);
  });

  it('keeps centralOf for catalogue display only, not for physical quantity', () => {
    // The catalogue item is still the fallback source for the material TITLE —
    // that is unchanged 176 behaviour and must not be removed by G3.1.
    expect(screen).toContain('outletMaterialTitle(r, ci, lang)');
    expect(screen).toContain('function centralOf(');
  });
});

/**
 * "Remove from outlet" is a CATALOGUE VISIBILITY action: it stamps removed_at on
 * an item_availability row via migration 084. A stock-only row has id === null —
 * there is no catalogue row to stamp — so the action cannot be executed
 * honestly and must not be offered. Migration 084/086 semantics are unchanged:
 * catalogue visibility is still not a physical stock correction.
 */
describe('G3.1 · catalogue-visibility removal is withheld from stock-only rows', () => {
  const service = readSrc('shared/supabase/services/availability.service.ts');

  it('offers the visibility action only when there IS a catalogue row', () => {
    expect(screen).toContain('{canRemove && r.id !== null && (');
    // The unguarded form must not come back.
    expect(screen).not.toMatch(/\{canRemove && \(\s*\n\s*<button/);
  });

  it('guards the RPC call itself, not just the button', () => {
    const fn = screen.slice(screen.indexOf('async function onConfirmRemove'),
                            screen.indexOf('await setAvailabilityVisibility'));
    expect(fn).toContain('if (removeTarget.id === null)');
    // The guard must precede the call, so no future call path can reach
    // migration 084 with a null id.
    expect(screen.indexOf('if (removeTarget.id === null)'))
      .toBeLessThan(screen.indexOf('await setAvailabilityVisibility'));
  });

  it('never coerces, asserts or invents an id to make the call type-check', () => {
    expect(screen).not.toMatch(/setAvailabilityVisibility\(\s*removeTarget\.id!/);
    expect(screen).not.toMatch(/setAvailabilityVisibility\(\s*removeTarget\.id\s*(\?\?|\|\|)/);
    expect(screen).not.toMatch(/setAvailabilityVisibility\(\s*String\(/);
    expect(screen).not.toMatch(/setAvailabilityVisibility\(\s*removeTarget\.row_key/);
    expect(screen).toContain("await setAvailabilityVisibility(removeTarget.id, true, 'removed_from_outlet')");
  });

  it('keeps the service signature non-nullable, so the compiler is a real gate', () => {
    // With AvailRow.id typed `string | null`, this signature is what makes the
    // null guard load-bearing rather than decorative: remove the guard and
    // `npm run typecheck` fails.
    expect(service).toMatch(/export async function setAvailabilityVisibility\(\s*\n\s*itemAvailabilityId: string,/);
  });

  it('withholds only the action — the stock-only row itself stays readable', () => {
    // Details still open for every row, including stock-only ones…
    expect(screen).toContain('onClick={() => setDetailsRow(r)}');
    // …and nothing deletes physical stock or manufactures a catalogue row to
    // make the button work.
    expect(screen).not.toMatch(/upsertAvailability\([^)]*removeTarget/);
    expect(screen).not.toMatch(/deleteOutletStock|correctOutletStock/);
  });
});
