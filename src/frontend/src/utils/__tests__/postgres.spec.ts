import { describe, expect, it } from 'vitest';
import { isPostgresImage } from '../postgres';

describe('isPostgresImage', () => {
  it.each([
    'postgres',
    'postgres:16',
    'postgres:16-alpine@sha256:abc',
    'library/postgres:15',
    'docker.io/library/postgres:latest',
    'bitnami/postgresql:16',
    'postgis/postgis:16-3.4',
    'timescale/timescaledb:latest-pg16',
    'timescale/timescaledb-ha:pg16',
    'pgvector/pgvector:pg16',
    'tensorchord/pgvecto-rs:pg16-v0.2.0',
    'ghcr.io/immich-app/postgres:14-vectorchord0.3.0',
    'registry.local:5000/postgres:16',
  ])('matches %s', (image) => {
    expect(isPostgresImage(image)).toBe(true);
  });

  it.each([
    'prometheuscommunity/postgres-exporter',
    'prodrigestivill/postgres-backup-local',
    'dpage/pgadmin4',
    'registry.local:5000/app:postgres',
    'mariadb:11',
    '',
    null,
    undefined,
  ])('does not match %s', (image) => {
    expect(isPostgresImage(image)).toBe(false);
  });
});
