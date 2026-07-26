import type { Container } from '@/stores/docker';

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
