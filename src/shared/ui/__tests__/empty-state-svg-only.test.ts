import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const emptyState = read('shared/ui/PhoenixEmptyState.tsx');

// W1: no production surface may render a raw emoji as an icon. PhoenixEmptyState
// is the shared empty-state primitive; any emoji key must map to a PhoenixIcon,
// and an unmapped key must fall back to an SVG — never a <span>{emoji}</span>.
describe('empty state renders SVG glyphs only (no raw emoji)', () => {
  it('resolves to a PhoenixIcon name with a non-emoji SVG fallback', () => {
    expect(emptyState).toContain("EMPTY_ICON_MAP[icon] ?? 'status'");
    expect(emptyState).toContain('<PhoenixIcon name={iconName}');
    // the old raw-emoji fallback must be gone
    expect(emptyState).not.toContain('<span aria-hidden="true">{icon}</span>');
  });

  it('maps the previously-unmapped keys (route/scope/clock) so nothing falls through visibly', () => {
    for (const key of ['🔀', '🧭', '🕘']) expect(emptyState).toContain(`'${key}'`);
  });
});
