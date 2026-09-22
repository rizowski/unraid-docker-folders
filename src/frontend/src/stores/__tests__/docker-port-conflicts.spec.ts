import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDockerStore, type Container, type HostPortBinding } from '../docker';
import { makeContainer as baseContainer } from '@/test/fixtures';

// Mock apiFetch so instantiating the store never makes real HTTP requests.
vi.mock('@/utils/csrf', () => ({
  apiFetch: vi.fn(),
  getCsrfToken: vi.fn(() => ''),
}));

// These specs address containers by name, so the id doubles as the name. Every
// other field comes from the shared fixture: a private copy of the whole
// `Container` shape drifts silently the next time the type gains a field.
function makeContainer(
  name: string,
  state: string,
  hostPorts: HostPortBinding[],
): Container {
  return baseContainer({
    id: name,
    name,
    image: 'test:latest',
    state,
    status: state === 'running' ? 'Up' : 'Exited',
    command: '',
    hostPorts,
    created: 0,
    managed: null,
  });
}

const tcp = (hostPort: number, hostIp = '0.0.0.0'): HostPortBinding => ({
  hostIp,
  hostPort,
  containerPort: hostPort,
  type: 'tcp',
});

describe('docker store – portConflicts', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('flags a stopped container sharing a host port with a running one', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer('running-grafana', 'running', [tcp(3000)]),
      makeContainer('stopped-grafana', 'exited', [tcp(3000)]),
    ];

    expect(store.getPortConflict('running-grafana')).toBeNull();
    const conflict = store.getPortConflict('stopped-grafana');
    expect(conflict).not.toBeNull();
    expect(conflict!.conflicts).toHaveLength(1);
    expect(conflict!.conflicts[0]).toMatchObject({ hostPort: 3000, type: 'tcp' });
    expect(conflict!.conflicts[0].heldBy).toEqual(['running-grafana']);
  });

  it('does not flag two stopped containers when none is running', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer('a', 'exited', [tcp(8080)]),
      makeContainer('b', 'exited', [tcp(8080)]),
    ];
    expect(store.portConflicts.size).toBe(0);
  });

  it('distinguishes tcp from udp on the same port', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer('pihole', 'running', [{ hostIp: '0.0.0.0', hostPort: 53, containerPort: 53, type: 'udp' }]),
      makeContainer('dnsmasq', 'exited', [{ hostIp: '0.0.0.0', hostPort: 53, containerPort: 53, type: 'tcp' }]),
    ];
    expect(store.getPortConflict('dnsmasq')).toBeNull();
  });

  it('treats wildcard host IPs as overlapping any specific IP', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer('web-a', 'running', [tcp(9000, '192.168.1.10')]),
      makeContainer('web-c', 'exited', [tcp(9000, '0.0.0.0')]),
    ];
    expect(store.getPortConflict('web-c')).not.toBeNull();
  });

  it('does not flag two distinct specific host IPs on the same port', () => {
    const store = useDockerStore();
    store.containers = [
      makeContainer('web-a', 'running', [tcp(9000, '192.168.1.10')]),
      makeContainer('web-b', 'exited', [tcp(9000, '192.168.1.11')]),
    ];
    expect(store.getPortConflict('web-b')).toBeNull();
  });

  it('dedupes holder names across multiple matching bindings', () => {
    const store = useDockerStore();
    store.containers = [
      // running holder binds the same host port on two interfaces
      makeContainer('holder', 'running', [tcp(443, '0.0.0.0'), tcp(443, '::')]),
      makeContainer('stopped', 'exited', [tcp(443)]),
    ];
    const conflict = store.getPortConflict('stopped');
    expect(conflict!.conflicts[0].heldBy).toEqual(['holder']);
  });

  it('counts a random host port that a running container holds', () => {
    // "-p 3000" with no host port: hostPorts is empty, and the port Docker
    // picked only shows in ports[].PublicPort, once per address family.
    const store = useDockerStore();
    const random = baseContainer({
      ...makeContainer('random-port', 'running', []),
      ports: [
        { IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 49153, Type: 'tcp' },
        { IP: '::', PrivatePort: 3000, PublicPort: 49153, Type: 'tcp' },
      ],
    });
    store.containers = [random, makeContainer('fixed', 'exited', [tcp(49153)])];

    expect(store.boundHostPorts.get(49153)).toBe('random-port');
    expect(store.getPortConflict('fixed')!.conflicts[0].heldBy).toEqual(['random-port']);
  });

  it('ignores ports[] on a stopped container', () => {
    const store = useDockerStore();
    const stopped = baseContainer({
      ...makeContainer('stopped', 'exited', []),
      ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 49153, Type: 'tcp' }],
    });
    store.containers = [stopped];

    expect(store.boundHostPorts.has(49153)).toBe(false);
  });
});
