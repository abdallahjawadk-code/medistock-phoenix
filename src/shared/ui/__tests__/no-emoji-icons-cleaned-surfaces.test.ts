import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

// Any pictographic emoji / dingbat commonly misused as a UI icon.
const EMOJI = /(\p{Extended_Pictographic}|★|➕|➖|✔|✖)️?/u;

// W1: surfaces that have been converted to the SVG PhoenixIcon system must
// stay emoji-free. This ratchet prevents icon-emoji from regressing back into
// them. (Content screens are converted per-screen in W4 and added here as they
// are cleaned.)
const CLEANED_SURFACES = [
  'features/auth/LoginScreen.tsx',
  'features/auth/ResetPasswordScreen.tsx',
  'shared/ui/PhoenixAppShell.tsx',
  'shared/ui/PhoenixSidebar.tsx',
  'shared/ui/PhoenixMobileDrawer.tsx',
  'shared/ui/PhoenixMobileBottomNav.tsx',
  'shared/ui/CommandPalette.tsx',
  'shared/ui/PhoenixTopbar.tsx',
  // Wave A: shared primitives converted from residual rendered emoji to SVG.
  'shared/ui/PhoenixToast.tsx',
  'shared/ui/PhoenixOrgScope.tsx',
  'shared/ui/WhatsAppContactButton.tsx',
];

describe('cleaned surfaces stay emoji-free (icons are SVG PhoenixIcon)', () => {
  for (const rel of CLEANED_SURFACES) {
    it(`${rel} has no emoji-as-icon`, () => {
      const lines = read(rel).split(/\r?\n/);
      const offenders = lines
        .map((l, i) => ({ n: i + 1, l }))
        .filter(({ l }) => EMOJI.test(l) && !l.trimStart().startsWith('//'))
        .map(({ n, l }) => `${n}: ${l.trim().slice(0, 60)}`);
      expect(offenders, `emoji found in ${rel}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
