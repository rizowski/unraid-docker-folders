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
    const withInvalidZone = formatTimestamp(FIXED_EPOCH, 'Not/ARealZone');
    const withoutZone = formatTimestamp(FIXED_EPOCH);

    expect(withInvalidZone).toBe(withoutZone);
  });

  it.each([undefined, null])('renders in the browser zone when the zone is %s', (zone) => {
    const expected = new Date(FIXED_EPOCH * 1000).toLocaleString();
    expect(formatTimestamp(FIXED_EPOCH, zone)).toBe(expected);
  });
});
