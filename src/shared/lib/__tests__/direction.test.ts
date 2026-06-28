import { describe, it, expect } from 'vitest';
import { getLanguageDirection } from '../direction';

describe('getLanguageDirection', () => {
  it('returns rtl for ar', () => expect(getLanguageDirection('ar')).toBe('rtl'));
  it('returns rtl for AR (case insensitive)', () => expect(getLanguageDirection('AR')).toBe('rtl'));
  it('returns rtl for padded " ar "', () => expect(getLanguageDirection(' ar ')).toBe('rtl'));
  it('returns ltr for en', () => expect(getLanguageDirection('en')).toBe('ltr'));
  it('returns ltr for unknown locale', () => expect(getLanguageDirection('fr')).toBe('ltr'));
  it('returns ltr for null', () => expect(getLanguageDirection(null)).toBe('ltr'));
  it('returns ltr for undefined', () => expect(getLanguageDirection(undefined)).toBe('ltr'));
  it('returns ltr for empty string', () => expect(getLanguageDirection('')).toBe('ltr'));
});
