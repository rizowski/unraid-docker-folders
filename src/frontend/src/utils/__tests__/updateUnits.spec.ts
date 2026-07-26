import { describe, it, expect } from 'vitest';
import type { Container } from '@/stores/docker';
import { makeContainer } from '@/test/fixtures';
import { buildUpdateUnits, composeProjectOf, unitLabel } from '../updateUnits';

function container(
  name: string,
  image: string,
  labels: Record<string, string> = {},
): Container {
  return makeContainer({ id: `id-${name}`, name, image, labels });
}

function compose(name: string, image: string, project: string): Container {
  return container(name, image, { 'com.docker.compose.project': project });
}

/** Every container ID across all units, for disjointness checks. */
function allUnitContainerIds(units: ReturnType<typeof buildUpdateUnits>): string[] {
  return units.flatMap((u) => u.containers.map((c) => c.id));
}

describe('composeProjectOf', () => {
  it('reads the compose project label', () => {
    expect(composeProjectOf(compose('web', 'nginx', 'blog'))).toBe('blog');
  });

  it('returns null for non-compose containers', () => {
    expect(composeProjectOf(container('plex', 'linuxserver/plex:latest'))).toBeNull();
  });
});

describe('buildUpdateUnits', () => {
  it('groups non-compose containers by image', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const sonarr = container('sonarr', 'linuxserver/sonarr:latest');
    const all = [plex, sonarr];

    const units = buildUpdateUnits(all, all, true);

    expect(units).toHaveLength(2);
    expect(units.every((u) => u.kind === 'image')).toBe(true);
    expect(units.map(unitLabel).sort()).toEqual([
      'linuxserver/plex:latest',
      'linuxserver/sonarr:latest',
    ]);
  });

  it('includes siblings sharing an image, even when not individually flagged', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const plexKids = container('plex-kids', 'linuxserver/plex:latest');
    const all = [plex, plexKids];

    // Only `plex` was flagged, but pulling the image recreates both.
    const units = buildUpdateUnits([plex], all, true);

    expect(units).toHaveLength(1);
    expect(units[0].containers.map((c) => c.name).sort()).toEqual(['plex', 'plex-kids']);
  });

  it('claims compose containers into a per-project unit', () => {
    const web = compose('web', 'nginx:latest', 'blog');
    const db = compose('db', 'postgres:16', 'blog');
    const all = [web, db];

    const units = buildUpdateUnits([web], all, true);

    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe('compose');
    expect(unitLabel(units[0])).toBe('blog');
    // `compose up` acts on the whole stack, so both members are listed.
    expect(units[0].containers.map((c) => c.name).sort()).toEqual(['db', 'web']);
  });

  it('never places a container in two units when an image spans compose and standalone', () => {
    const composed = compose('blog-cache', 'redis:7', 'blog');
    const standalone = container('cache', 'redis:7');
    const all = [composed, standalone];

    const units = buildUpdateUnits(all, all, true);

    const ids = allUnitContainerIds(units);
    expect(new Set(ids).size).toBe(ids.length);

    const composeUnit = units.find((u) => u.kind === 'compose');
    const imageUnit = units.find((u) => u.kind === 'image');
    expect(composeUnit?.containers.map((c) => c.name)).toEqual(['blog-cache']);
    // The image unit must not steal the compose-owned container.
    expect(imageUnit?.containers.map((c) => c.name)).toEqual(['cache']);
  });

  it('falls back to image units when compose management is disabled', () => {
    const web = compose('web', 'nginx:latest', 'blog');
    const db = compose('db', 'postgres:16', 'blog');
    const all = [web, db];

    const units = buildUpdateUnits(all, all, false);

    expect(units.every((u) => u.kind === 'image')).toBe(true);
    expect(units.map(unitLabel).sort()).toEqual(['nginx:latest', 'postgres:16']);
  });

  it('returns no units for an empty update set', () => {
    expect(buildUpdateUnits([], [container('plex', 'plex:latest')], true)).toEqual([]);
  });

  it('gives each unit a stable, distinct id', () => {
    const web = compose('web', 'nginx:latest', 'blog');
    const plex = container('plex', 'linuxserver/plex:latest');
    const all = [web, plex];

    const units = buildUpdateUnits(all, all, true);

    expect(units.map((u) => u.id).sort()).toEqual([
      'compose:blog',
      'image:linuxserver/plex:latest',
    ]);
  });
});
