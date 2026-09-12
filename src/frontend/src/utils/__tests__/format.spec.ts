import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '../format';

describe('formatTimestamp', () => {
  // 2026-01-15 12:00:00 UTC
  const FIXED_EPOCH = 1768478400;

  it('renders differently for different explicit timezones', () => {
    const utc = formatTimestamp(FIXED_EPOCH, 'UTC');
    const nyc = formatTimestamp(FIXED_EPOCH, 'America/New_York');

    expect(utc).not.toBe(nyc);
  });

  it('falls back to the no-zone rendering for an unrecognized zone rather than throwing', () => {
    expect(() => formatTimestamp(FIXED_EPOCH, 'Not/ARealZone')).not.toThrow();

    const withInvalidZone = formatTimestamp(FIXED_EPOCH, 'Not/ARealZone');
    const withoutZone = formatTimestamp(FIXED_EPOCH);

    expect(withInvalidZone).toBe(withoutZone);
  });

  it('is unchanged for a call with no timezone argument', () => {
    const expected = new Date(FIXED_EPOCH * 1000).toLocaleString();
    expect(formatTimestamp(FIXED_EPOCH)).toBe(expected);
  });

  it('treats a null timezone the same as no timezone', () => {
    const expected = new Date(FIXED_EPOCH * 1000).toLocaleString();
    expect(formatTimestamp(FIXED_EPOCH, null)).toBe(expected);
  });
});
