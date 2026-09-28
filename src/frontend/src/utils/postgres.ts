import { parseImageRef } from './imageRegistry';

/**
 * Image names that run a Postgres server. The last path segment of the
 * repository must equal one of these. A substring match would also catch
 * tools such as `postgres-exporter` and `postgres-backup-local`, which have
 * no server to dump.
 *
 * This is only a hint for the form before the server answers. The server
 * decides from the container's env (PG_MAJOR, BITNAMI_APP_NAME).
 */
const POSTGRES_IMAGE_NAMES = new Set([
  'postgres',
  'postgresql',
  'postgis',
  'timescaledb',
  'timescaledb-ha',
  'pgvector',
  'pgvecto-rs',
  'vectorchord',
]);

export function isPostgresImage(image: string | null | undefined): boolean {
  const ref = parseImageRef(image ?? '');
  if (!ref) return false;
  const name = ref.path.slice(ref.path.lastIndexOf('/') + 1).toLowerCase();
  return POSTGRES_IMAGE_NAMES.has(name);
}
