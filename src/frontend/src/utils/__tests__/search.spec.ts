import { describe, it, expect } from 'vitest';
import { containerMatchesSearch } from '../search';

describe('containerMatchesSearch', () => {
  it('matches everything on an empty or blank query', () => {
    expect(containerMatchesSearch('', 'plex')).toBe(true);
    expect(containerMatchesSearch('   ', 'plex')).toBe(true);
  });

  it('matches the name case-insensitively', () => {
    expect(containerMatchesSearch('PLE', 'plex')).toBe(true);
  });

  it('matches the image', () => {
    expect(containerMatchesSearch('linuxserver', 'media', 'linuxserver/plex:latest')).toBe(true);
  });

  it('rejects a query in neither', () => {
    expect(containerMatchesSearch('sonarr', 'plex', 'linuxserver/plex')).toBe(false);
  });
});
