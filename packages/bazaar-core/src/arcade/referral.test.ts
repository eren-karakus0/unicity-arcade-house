import { describe, expect, it } from 'vitest';
import { normalizeCode, referralCode } from './referral.js';

describe('referralCode', () => {
  it('is deterministic and 6 url-safe chars', () => {
    const a = referralCode('02abcdef');
    expect(a).toBe(referralCode('02abcdef'));
    expect(a).toMatch(/^[0-9A-Z]{6}$/);
  });

  it('differs between distinct keys', () => {
    expect(referralCode('key-one')).not.toBe(referralCode('key-two'));
  });
});

describe('normalizeCode', () => {
  it('accepts a clean code and upcases it', () => {
    expect(normalizeCode(' ab12cd ')).toBe('AB12CD');
  });
  it('strips punctuation and whitespace', () => {
    expect(normalizeCode('a1-b2/c3')).toBe('A1B2C3');
  });
  it('rejects too-short, too-long, or non-string input', () => {
    expect(normalizeCode('ab')).toBeUndefined();
    expect(normalizeCode('abcdefghij')).toBeUndefined();
    expect(normalizeCode(123)).toBeUndefined();
    expect(normalizeCode(undefined)).toBeUndefined();
  });
});
