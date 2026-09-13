import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeLocalStorageGet, safeLocalStorageSet } from '../safeStorage';

describe('safeStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage?.clear();
  });

  it('reads back a value it wrote', () => {
    safeLocalStorageSet('safe-storage-test', 'value');
    expect(safeLocalStorageGet('safe-storage-test')).toBe('value');
  });

  it('returns null for a missing key', () => {
    expect(safeLocalStorageGet('safe-storage-missing')).toBeNull();
  });

  it('returns null when localStorage throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(safeLocalStorageGet('safe-storage-test')).toBeNull();
  });

  it('does not throw when localStorage throws on write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => safeLocalStorageSet('safe-storage-test', 'value')).not.toThrow();
  });
});
