import { describe, it, expect } from 'vitest';
import type { Container } from '@/stores/docker';
import { makeContainer, makeReleaseStatus, makeUpdateStatus } from '@/test/fixtures';
import type { ImageUpdateStatus } from '@/stores/updates';
import {
  buildUpdateUnits,
  composeProjectOf,
  unitLabel,
  unitReleases,
  unitReleaseSummary,
  unitReleaseUrl,
} from '../updateUnits';

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

// --- Release notes ---------------------------------------------------------

const updateStatus = (image: string, overrides: Partial<ImageUpdateStatus> = {}) =>
  makeUpdateStatus(image, true, overrides);
const withRelease = makeReleaseStatus;

describe('unitReleaseSummary', () => {
  it('returns null when nothing is cached', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(unitReleaseSummary(unit, {})).toBeNull();
  });

  it('returns null when the image has an update but no release notes', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(
      unitReleaseSummary(unit, {
        'linuxserver/plex:latest': updateStatus('linuxserver/plex:latest'),
      }),
    ).toBeNull();
  });

  it('joins tag and summary for a single release', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(
      unitReleaseSummary(unit, {
        'linuxserver/plex:latest': withRelease(
          'linuxserver/plex:latest',
          'linuxserver/docker-plex',
          'v1.2.3',
          'Fixed HDR transcode.',
        ),
      }),
    ).toBe('v1.2.3 — Fixed HDR transcode.');
  });

  it('falls back to the tag alone when the summary is empty', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(
      unitReleaseSummary(unit, {
        'linuxserver/plex:latest': withRelease(
          'linuxserver/plex:latest',
          'linuxserver/docker-plex',
          'v1.2.3',
          '',
        ),
      }),
    ).toBe('v1.2.3');
  });

  it('lists repo and tag only when a compose unit spans several repos', () => {
    const db = compose('db', 'postgres:16', 'stack');
    const cache = compose('cache', 'valkey:8', 'stack');
    const web = compose('web', 'nginx:latest', 'stack');
    const all = [db, cache, web];
    const [unit] = buildUpdateUnits(all, all, true);

    expect(
      unitReleaseSummary(unit, {
        'postgres:16': withRelease('postgres:16', 'postgres/postgres', 'REL_16_4'),
        'valkey:8': withRelease('valkey:8', 'valkey-io/valkey', '8.0.2'),
        'nginx:latest': withRelease('nginx:latest', 'nginx/nginx', 'v1.27.0'),
      }),
    ).toBe('postgres REL_16_4 · valkey 8.0.2 · nginx v1.27.0');
  });

  it('collapses the tail into "+N more" past three repos', () => {
    const all = ['a', 'b', 'c', 'd', 'e'].map((n) => compose(n, `img-${n}:1`, 'stack'));
    const [unit] = buildUpdateUnits(all, all, true);

    const updates = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map((n) => [
        `img-${n}:1`,
        withRelease(`img-${n}:1`, `owner/${n}`, `v${n}`),
      ]),
    );

    expect(unitReleaseSummary(unit, updates)).toBe('a va · b vb · c vc · +2 more');
  });

  it('ignores compose members that are not flagged for an update', () => {
    const db = compose('db', 'postgres:16', 'stack');
    const cache = compose('cache', 'valkey:8', 'stack');
    // Only db is flagged, but buildUpdateUnits lists the whole project.
    const units = buildUpdateUnits([db], [db, cache], true);
    expect(units[0].containers).toHaveLength(2);

    expect(
      unitReleaseSummary(units[0], {
        'postgres:16': withRelease('postgres:16', 'postgres/postgres', 'REL_16_4', 'Planner fix.'),
        'valkey:8': withRelease('valkey:8', 'valkey-io/valkey', '8.0.2', 'Should not appear.', {
          update_available: false,
        }),
      }),
    ).toBe('REL_16_4 — Planner fix.');
  });

  it('dedupes two image tags that share one source repo', () => {
    const a = compose('a', 'grafana/grafana:latest', 'stack');
    const b = compose('b', 'grafana/grafana:next', 'stack');
    const all = [a, b];
    const [unit] = buildUpdateUnits(all, all, true);

    const updates = {
      'grafana/grafana:latest': withRelease('grafana/grafana:latest', 'grafana/grafana', 'v11.3.0'),
      'grafana/grafana:next': withRelease('grafana/grafana:next', 'grafana/grafana', 'v11.3.0'),
    };

    expect(unitReleases(unit, updates)).toHaveLength(1);
    expect(unitReleaseSummary(unit, updates)).toBe('v11.3.0 — Some fixes.');
  });
});

describe('unitReleaseUrl', () => {
  it('links to the release page for a single-release unit', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(
      unitReleaseUrl(unit, {
        'linuxserver/plex:latest': withRelease(
          'linuxserver/plex:latest',
          'linuxserver/docker-plex',
          'v1.2.3',
        ),
      }),
    ).toBe('https://github.com/linuxserver/docker-plex/releases/tag/v1.2.3');
  });

  it('falls back to the repo releases index when the release has no url', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);
    const status = withRelease('linuxserver/plex:latest', 'linuxserver/docker-plex', 'v1.2.3');
    status.release!.url = null;

    expect(unitReleaseUrl(unit, { 'linuxserver/plex:latest': status })).toBe(
      'https://github.com/linuxserver/docker-plex/releases',
    );
  });

  it('returns null when a unit pulls several images', () => {
    const db = compose('db', 'postgres:16', 'stack');
    const cache = compose('cache', 'valkey:8', 'stack');
    const all = [db, cache];
    const [unit] = buildUpdateUnits(all, all, true);

    // Two sets of notes; linking to one would misrepresent the other.
    expect(
      unitReleaseUrl(unit, {
        'postgres:16': withRelease('postgres:16', 'postgres/postgres', 'REL_16_4'),
        'valkey:8': withRelease('valkey:8', 'valkey-io/valkey', '8.0.2'),
      }),
    ).toBeNull();
  });

  it('returns null when nothing is cached', () => {
    const plex = container('plex', 'linuxserver/plex:latest');
    const [unit] = buildUpdateUnits([plex], [plex], true);

    expect(unitReleaseUrl(unit, {})).toBeNull();
  });
});
