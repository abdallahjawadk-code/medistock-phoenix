import { describe, it, expect } from 'vitest';
import {
  normalizeUsername, validateUsername, localUsernameToAuthEmail,
  isLocalAuthEmail, resolveLoginIdentifier, LOCAL_AUTH_DOMAIN,
} from '../username';

describe('normalizeUsername', () => {
  it('trims and lowercases', () => {
    expect(normalizeUsername('  Ali.Pharmacy  ')).toBe('ali.pharmacy');
  });
});

describe('validateUsername', () => {
  const valid = ['ali.pharmacy', 'abc', 'a1_b-2.c', 'x'.repeat(32)];
  const invalid = ['', 'ab', 'x'.repeat(33), 'Ali Pharmacy', 'ali@pharmacy', 'علي', 'ali#1', ' '];

  valid.forEach(u => {
    it(`accepts "${u}"`, () => {
      expect(validateUsername(u)).toBe(true);
    });
  });

  invalid.forEach(u => {
    it(`rejects "${u}"`, () => {
      expect(validateUsername(u)).toBe(false);
    });
  });

  it('is case-insensitive (uppercase normalizes to valid lowercase)', () => {
    expect(validateUsername('Ali.Pharmacy')).toBe(true);
  });
});

describe('localUsernameToAuthEmail', () => {
  it('builds the synthetic internal auth email', () => {
    expect(localUsernameToAuthEmail('ali.pharmacy')).toBe(`ali.pharmacy@${LOCAL_AUTH_DOMAIN}`);
  });

  it('normalizes (trim + lowercase) before building the email', () => {
    expect(localUsernameToAuthEmail('  Ali.Pharmacy  ')).toBe(`ali.pharmacy@${LOCAL_AUTH_DOMAIN}`);
  });

  it('uses the non-deliverable .invalid domain', () => {
    expect(LOCAL_AUTH_DOMAIN).toBe('local.medistock.invalid');
  });
});

describe('isLocalAuthEmail', () => {
  it('detects a synthetic local-auth email', () => {
    expect(isLocalAuthEmail(`ali.pharmacy@${LOCAL_AUTH_DOMAIN}`)).toBe(true);
  });

  it('rejects a real email', () => {
    expect(isLocalAuthEmail('ali@example.com')).toBe(false);
  });

  it('rejects null/undefined', () => {
    expect(isLocalAuthEmail(null)).toBe(false);
    expect(isLocalAuthEmail(undefined)).toBe(false);
  });
});

describe('resolveLoginIdentifier', () => {
  it('passes a real email through unchanged', () => {
    expect(resolveLoginIdentifier('ali@example.com')).toBe('ali@example.com');
  });

  it('maps a bare username to the synthetic internal email', () => {
    expect(resolveLoginIdentifier('ali.pharmacy')).toBe(`ali.pharmacy@${LOCAL_AUTH_DOMAIN}`);
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveLoginIdentifier('  ali.pharmacy  ')).toBe(`ali.pharmacy@${LOCAL_AUTH_DOMAIN}`);
  });
});
