import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const authenticatedApp = readFileSync(join(ROOT, 'src/app/AuthenticatedApp.tsx'), 'utf8');
const serviceWorker = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

describe('authenticated network review deep-link', () => {
  it('opens only the requested network screen and keeps the normal production default', () => {
    expect(authenticatedApp).toContain("requested === 'network' || requested === '17'");
    expect(authenticatedApp).toContain('? 17 : DEFAULT_AUTHENTICATED_SCREEN');
    expect(authenticatedApp).toContain('const DEFAULT_AUTHENTICATED_SCREEN = 12');
  });

  it('still routes the selected screen through the authorization guard', () => {
    expect(authenticatedApp).toContain('<ScreenAuthzGuard screen={screen}>');
    expect(authenticatedApp).toContain('{screenContent()}');
  });

  it('invalidates the previous cached visual shell', () => {
    expect(serviceWorker).toContain("const CACHE_VERSION = 'medistock-shell-v2'");
    expect(serviceWorker).not.toContain("const CACHE_VERSION = 'medistock-shell-v1'");
  });
});
