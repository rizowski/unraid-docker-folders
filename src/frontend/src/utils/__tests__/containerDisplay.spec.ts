import { describe, it, expect, vi, afterEach } from 'vitest';
import { containerStatus, containerEditUrl, openContainerTerminal } from '../containerDisplay';

describe('containerStatus', () => {
  it('marks a healthy running container as success', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours (healthy)' }, true)).toEqual({
      halo: 'status-halo-success',
      tooltip: 'Running (healthy)',
    });
  });

  it('marks a running container with no health check as info', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours' }, true).halo).toBe('status-halo-info');
  });

  it('ignores health when the setting is off', () => {
    expect(containerStatus({ state: 'running', status: 'Up 2 hours' }, false)).toEqual({
      halo: 'status-halo-success',
      tooltip: 'Running',
    });
  });

  it.each([
    ['paused', 'status-halo-warning', 'Paused'],
    ['exited', 'status-halo-error', 'Exited'],
    ['created', 'status-halo-muted', 'Created'],
    ['restarting', 'status-halo-muted', 'Restarting'],
  ])('maps %s', (state, halo, tooltip) => {
    expect(containerStatus({ state, status: '' }, true)).toEqual({ halo, tooltip });
  });
});

describe('containerEditUrl', () => {
  it('points a dockerman container at its user template', () => {
    expect(containerEditUrl({ managed: 'dockerman', name: 'plex' })).toBe(
      '/Docker/UpdateContainer?xmlTemplate=edit:/boot/config/plugins/dockerMan/templates-user/my-plex.xml',
    );
  });

  it('returns null for an unmanaged container', () => {
    expect(containerEditUrl({ managed: null, name: 'plex' })).toBeNull();
  });
});

describe('openContainerTerminal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the log terminal URL without a parent openTerminal', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openContainerTerminal('my app', 'logs');
    expect(open).toHaveBeenCalledWith('/logterminal/my%20app.log/', '_blank');
  });
});
