import { describe, it, expect } from 'vitest';
import { sortByMode, type SortableFields } from '../sortMode';

interface Item extends SortableFields {
  id: string;
}

const items: Item[] = [
  { id: 'b', position: 2, name: 'beta', state: 'exited', created: 300 },
  { id: 'a', position: 0, name: 'Alpha', state: 'running', created: 100 },
  { id: 'c', position: 1, name: 'charlie', state: 'running', created: 200 },
  { id: 'd', position: 3, name: 'app10', state: 'paused' },
  { id: 'e', position: 4, name: 'app9', state: 'created', created: 50 },
];

const ids = (mode: Parameters<typeof sortByMode>[1]) => sortByMode(items, mode, (i) => i).map((i) => i.id);

describe('sortByMode', () => {
  it('manual sorts by position', () => {
    expect(ids('manual')).toEqual(['a', 'c', 'b', 'd', 'e']);
  });

  it('name-asc is case-insensitive and numeric-aware', () => {
    expect(ids('name-asc')).toEqual(['a', 'e', 'd', 'b', 'c']);
  });

  it('name-desc is the reverse of name-asc', () => {
    expect(ids('name-desc')).toEqual(['c', 'b', 'd', 'e', 'a']);
  });

  it('status puts running first and breaks ties by name', () => {
    expect(ids('status')).toEqual(['a', 'c', 'd', 'e', 'b']);
  });

  it('created-asc treats a missing timestamp as 0', () => {
    expect(ids('created-asc')).toEqual(['d', 'e', 'a', 'c', 'b']);
  });

  it('created-desc puts the newest first', () => {
    expect(ids('created-desc')).toEqual(['b', 'c', 'a', 'e', 'd']);
  });

  it('does not mutate the input array', () => {
    const before = items.map((i) => i.id);
    sortByMode(items, 'name-desc', (i) => i);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});
