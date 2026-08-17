import type { Container } from '@/stores/docker';
import type { ImageUpdateStatus } from '@/stores/updates';

/**
 * A minimal running container, with every field of the `Container` type
 * populated so specs only have to state what they actually care about.
 *
 * Shared so that adding a field to `Container` is a one-line change here
 * rather than an edit in every spec that builds one.
 */
export function makeContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: 'abc123',
    name: 'test-container',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 2 hours',
    command: '/entrypoint.sh',
    ports: [],
    hostPorts: [],
    mounts: [],
    networkSettings: {},
    created: Date.now() / 1000,
    icon: null,
    managed: 'dockerman',
    webui: null,
    labels: {},
    autostart: false,
    autostartDelay: 0,
    ...overrides,
  };
}

/**
 * One image's update-check status, with `local_digest`/`remote_digest`
 * derived from `updateAvailable` so specs don't have to keep them consistent
 * by hand.
 *
 * Shared for the same reason as `makeContainer`: `ImageUpdateStatus` is
 * produced by three PHP builders and consumed by three specs, so a new field
 * should cost one edit here rather than one per spec.
 */
export function makeUpdateStatus(
  image: string,
  updateAvailable: boolean,
  overrides: Partial<ImageUpdateStatus> = {},
): ImageUpdateStatus {
  return {
    image,
    local_digest: `${image}@sha256:local`,
    remote_digest: updateAvailable ? 'sha256:remote' : 'sha256:local',
    update_available: updateAvailable,
    checked_at: 1700000000,
    error: null,
    source_url: null,
    source_repo: null,
    release: null,
    ...overrides,
  };
}

/**
 * An update-check status carrying a cached GitHub release, with the
 * `source_url`, `source_repo`, and `release.url` all derived from one repo
 * slug so they can't drift apart inside a fixture.
 */
export function makeReleaseStatus(
  image: string,
  repo: string,
  tag: string,
  summary = 'Some fixes.',
  overrides: Partial<ImageUpdateStatus> = {},
): ImageUpdateStatus {
  return makeUpdateStatus(image, true, {
    source_url: `https://github.com/${repo}`,
    source_repo: repo,
    release: {
      tag,
      name: tag,
      published_at: 1699990000,
      url: `https://github.com/${repo}/releases/tag/${tag}`,
      summary,
      fetched_at: 1700000000,
    },
    ...overrides,
  });
}
