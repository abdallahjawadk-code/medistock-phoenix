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
    expect(body).toContain('unit?: string | null;');
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
