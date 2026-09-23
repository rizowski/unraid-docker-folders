/**
 * Filesystem layout and allowed roots for Compose, ported from the constants
 * near the top of `include/config.php` and `ComposeManager.php`.
 *
 * Every one of these is a real, root-writable path on a production Unraid box
 * (`/boot/config/...`, `/usr/lib/docker/...`), none of which exist on a
 * developer machine or in CI. Everything that touches disk in this module
 * reads its paths from here rather than from a literal, and this is supplied
 * through Nest's DI the same way `DatabaseService` takes `DB_PATH_TOKEN`
 * (see `db/database.service.ts`): a production default, overridable only by
 * tests, so a spec can point every path at a `mkdtemp()` directory instead of
 * `/boot`.
 */

/** Same literal `settings.service.ts` and `database.service.ts` are built from. */
const CONFIG_DIR = '/boot/config/plugins/unraid-docker-folders-modern';

export interface ComposePathsConfig {
    /** `CONFIG_DIR` in `config.php`. Holds the plugin's own SQLite database. */
    readonly configDir: string;
    /** `COMPOSE_STACKS_DIR`: self-contained copies of imported/created stacks. */
    readonly stacksDir: string;
    /** `COMPOSE_PLUGIN_PROJECTS`: where dcflachs/compose_plugin keeps projects. */
    readonly pluginProjectsDir: string;
    /** `COMPOSE_PLUGIN_DIR`: presence of this directory means that plugin is installed. */
    readonly pluginDir: string;
    /** `ComposeManager::COMPOSE_BINARY_PATH`. */
    readonly binaryPath: string;
    /** `ComposeManager::COMPOSE_VERSION`, the release installed by `installComposeBinary`. */
    readonly binaryVersion: string;
    /** `ComposeManager::COMPOSE_SHA256`, checked before the downloaded binary is trusted. */
    readonly binarySha256: string;
}

export const DEFAULT_COMPOSE_PATHS: ComposePathsConfig = {
    configDir: CONFIG_DIR,
    stacksDir: `${CONFIG_DIR}/compose-stacks`,
    pluginProjectsDir: '/boot/config/plugins/compose.manager/projects',
    pluginDir: '/usr/local/emhttp/plugins/compose.manager',
    binaryPath: '/usr/lib/docker/cli-plugins/docker-compose',
    binaryVersion: '2.32.4',
    binarySha256: 'ed1917fb54db184192ea9d0717bcd59e3662ea79db48bff36d3475516c480a6b',
};

/** Overrides the filesystem layout. Only the tests supply one. */
export const COMPOSE_PATHS_TOKEN = 'DOCKER_FOLDERS_COMPOSE_PATHS';

/**
 * Roots a Compose-related path is allowed to resolve under, derived from a
 * `ComposePathsConfig` the same way `COMPOSE_ALLOWED_ROOTS` /
 * `EXPORT_ALLOWED_ROOTS` are derived from `CONFIG_DIR` / `COMPOSE_STACKS_DIR`
 * in `config.php`. `/mnt` covers Unraid user shares and appdata, which is
 * where stacks and exports genuinely live.
 *
 * A stack's own `working_dir` is allowed in addition to `composeAllowedRoots`
 * for an env-file path, but it is computed per call (it varies per stack),
 * not listed here — same reasoning as the PHP comment on `COMPOSE_ALLOWED_ROOTS`.
 */
export function composeAllowedRoots(paths: ComposePathsConfig): string[] {
    return ['/mnt', paths.stacksDir];
}

export function exportAllowedRoots(paths: ComposePathsConfig): string[] {
    return ['/mnt', paths.configDir];
}

/** Recognised compose file names, in lookup order. `ComposeManager::COMPOSE_FILENAMES`. */
export const COMPOSE_FILENAMES = [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
] as const;
