import { describe, it, expect } from 'vitest';
import { imageRegistryUrl, parseImageRef } from '@/utils/imageRegistry';

describe('parseImageRef', () => {
  it('reads a bare official image', () => {
    expect(parseImageRef('nginx:1.25')).toEqual({ host: null, path: 'nginx', tag: '1.25' });
  });

  it('reads a namespaced Docker Hub image', () => {
    expect(parseImageRef('linuxserver/plex:latest')).toEqual({
      host: null,
      path: 'linuxserver/plex',
      tag: 'latest',
    });
  });

  it('treats a first segment with a dot as the registry host', () => {
    expect(parseImageRef('ghcr.io/home-assistant/home-assistant:stable')).toEqual({
      host: 'ghcr.io',
      path: 'home-assistant/home-assistant',
      tag: 'stable',
    });
  });

  it('does not mistake a registry port for a tag', () => {
    // The colon sits before the last slash, so it belongs to the host.
    expect(parseImageRef('myreg:5000/team/app')).toEqual({
      host: 'myreg:5000',
      path: 'team/app',
      tag: null,
    });
    expect(parseImageRef('myreg:5000/team/app:v2')).toEqual({
      host: 'myreg:5000',
      path: 'team/app',
      tag: 'v2',
    });
  });

  it('drops a digest', () => {
    expect(parseImageRef('linuxserver/plex@sha256:abc123')).toEqual({
      host: null,
      path: 'linuxserver/plex',
      tag: null,
    });
  });

  it('defaults a missing tag to null', () => {
    expect(parseImageRef('redis')).toEqual({ host: null, path: 'redis', tag: null });
  });

  it('returns null for nothing', () => {
    expect(parseImageRef('')).toBeNull();
    expect(parseImageRef('   ')).toBeNull();
  });
});

describe('imageRegistryUrl', () => {
  it('sends an official image to its Docker Hub tag list', () => {
    expect(imageRegistryUrl('nginx:1.25')).toBe('https://hub.docker.com/_/nginx/tags?name=1.25');
  });

  it('sends a namespaced image to its Docker Hub tag list', () => {
    expect(imageRegistryUrl('linuxserver/plex:latest')).toBe(
      'https://hub.docker.com/r/linuxserver/plex/tags?name=latest',
    );
  });

  it('strips an explicit docker.io host', () => {
    expect(imageRegistryUrl('docker.io/grafana/grafana:latest')).toBe(
      'https://hub.docker.com/r/grafana/grafana/tags?name=latest',
    );
  });

  it('sends lscr.io to Docker Hub, because lscr.io has no page', () => {
    expect(imageRegistryUrl('lscr.io/linuxserver/sabnzbd:latest')).toBe(
      'https://hub.docker.com/r/linuxserver/sabnzbd/tags?name=latest',
    );
  });

  it('sends ghcr.io to the GitHub package page', () => {
    expect(imageRegistryUrl('ghcr.io/home-assistant/home-assistant:stable')).toBe(
      'https://github.com/orgs/home-assistant/packages/container/package/home-assistant',
    );
  });

  it('sends quay.io to its repository page', () => {
    expect(imageRegistryUrl('quay.io/prometheus/busybox:latest')).toBe(
      'https://quay.io/repository/prometheus/busybox',
    );
  });

  it('sends a GitLab registry image to the project container registry', () => {
    expect(imageRegistryUrl('registry.gitlab.com/group/project:1.0')).toBe(
      'https://gitlab.com/group/project/container_registry',
    );
  });

  it('falls back to the host for an unknown registry', () => {
    expect(imageRegistryUrl('registry.example.com/team/app:v1')).toBe(
      'https://registry.example.com/team/app',
    );
  });

  it('omits the tag when the reference carries none', () => {
    expect(imageRegistryUrl('redis')).toBe('https://hub.docker.com/_/redis');
  });

  it('escapes a tag that needs it', () => {
    expect(imageRegistryUrl('linuxserver/plex:1.0+build')).toBe(
      'https://hub.docker.com/r/linuxserver/plex/tags?name=1.0%2Bbuild',
    );
  });

  it('returns null for nothing', () => {
    expect(imageRegistryUrl('')).toBeNull();
  });
});
