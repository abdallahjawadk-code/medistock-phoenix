import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, '../notifications.service.ts'), 'utf8');

describe('notification unread-count DB pressure guard', () => {
  it('deduplicates overlapping unread-count callers without a persistent result cache', () => {
    expect(source).toContain('let unreadCountInFlight: Promise<number> | null = null;');
    expect(source).toContain('if (unreadCountInFlight) return unreadCountInFlight;');
    expect(source).toContain('if (unreadCountInFlight === request) unreadCountInFlight = null;');
    expect(source).not.toMatch(/unreadCountCache|unreadCountExpires|UNREAD.*TTL/i);
  });

  it('waits while the browser document is hidden and resumes on visibilitychange', () => {
    expect(source).toContain("typeof document === 'undefined' || !document.hidden");
    expect(source).toContain("document.addEventListener('visibilitychange', onVisibilityChange);");
    expect(source).toContain("document.removeEventListener('visibilitychange', onVisibilityChange);");
    expect(source).toContain('await waitUntilDocumentVisible();');
  });

  it('keeps the RPC name and fresh visible request path unchanged', () => {
    expect(source).toContain("supabase.rpc('phoenix_notifications_unread_count')");
    expect(source).toContain("if (error) throw error;");
    expect(source).toContain("return typeof data === 'number' ? data : Number(data ?? 0);");
  });
});
