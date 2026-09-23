import { describe, it, expect } from 'vitest';
import { withStableOrder } from '../docker';
import { makeContainer } from '@/test/fixtures';

const mount = (Destination: string, Source = `/mnt/user/appdata${Destination}`) => ({ Source, Destination, Type: 'bind', RW: true });
const port = (PrivatePort: number, Type = 'tcp', PublicPort?: number) => ({ IP: '0.0.0.0', PrivatePort, PublicPort, Type });

describe('withStableOrder', () => {
  it('sorts mounts by container path, whatever order Docker sent', () => {
    const a = withStableOrder(makeContainer({ mounts: [mount('/data'), mount('/config'), mount('/media')] }));
    const b = withStableOrder(makeContainer({ mounts: [mount('/media'), mount('/data'), mount('/config')] }));
    expect(a.mounts.map((m) => m.Destination)).toEqual(['/config', '/data', '/media']);
    expect(b.mounts).toEqual(a.mounts);
  });

  it('sorts ports by container port, then protocol, then host port', () => {
    const c = withStableOrder(makeContainer({ ports: [port(8080, 'udp'), port(443, 'tcp', 8443), port(8080, 'tcp'), port(443, 'tcp', 443)] }));
    expect(c.ports.map((p) => `${p.PrivatePort}/${p.Type}:${p.PublicPort ?? ''}`)).toEqual(['443/tcp:443', '443/tcp:8443', '8080/tcp:', '8080/udp:']);
  });

  it('does not change the container it was given', () => {
    const original = makeContainer({ mounts: [mount('/b'), mount('/a')] });
    withStableOrder(original);
    expect(original.mounts.map((m) => m.Destination)).toEqual(['/b', '/a']);
  });
});
