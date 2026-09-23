/**
 * GraphQL backend: the Unraid API at `/graphql`.
 *
 * Auth needs no API key and nothing to provision. Unraid's nginx serves
 * `location /graphql` with `allow all`, so it does not gate the endpoint; the
 * API authenticates internally. `AuthService.validateCookiesWithCsrfToken`
 * wants a valid `unraid_*` session cookie, which the browser sends on its own,
 * plus a CSRF token in the `x-csrf-token` header. Verified on Unraid 7.3.2 /
 * API 4.35.1: without the header the API answers "Invalid CSRF token", and
 * with it the same request gets as far as "No user session found".
 *
 * Do not carry the PHP path's form-encoded token across. That exists only
 * because `apiFetch()` replaces `options.headers` wholesale. The header is the
 * supported route here.
 *
 * This backend is partial on purpose. It overrides only what the plugin
 * implements and delegates the rest to PHP, so the two can be compared one
 * domain at a time instead of all at once. Today that is the folder read and
 * write paths. Export and import still go to PHP, because they carry the
 * whole configuration file rather than one folder.
 */

import { getCsrfToken } from '@/utils/csrf';
import type { Container } from '@/stores/docker';
import type { ContainerStats } from '@/stores/stats';
import type { ImageUpdateStatus, ReleaseNote } from '@/stores/updates';
import type { AdoptConfig, AdoptFields } from '@/utils/unraidHandoff';
import type {
  ContainerAssociation,
  Folder,
  FolderCreateData,
  FolderUpdateData,
} from '@/types/folder';
import type { SortMode } from '@/types/folder';
import type {
  BackupEntry,
  Schedule,
  ScheduleHistoryEntry,
  ScheduleRunnerState,
} from '@/types/schedule';
import type {
  ComposeFileVersion,
  ComposeFileVersionDetail,
  ComposeStack,
  ComposeStatus,
  ComposeValidationError,
} from '@/types/compose';
import { phpBackend } from './php';
import { graphqlLive } from './graphqlLive';
import { graphqlStreams } from './graphqlStreams';
import type { Backend, BackendResult, ContainerAction } from './types';

const GRAPHQL_URL = '/graphql';

/**
 * How long the boot probe waits before giving up.
 *
 * A stopped API answers fast, with a 502 from nginx, and falls back cleanly.
 * A hung socket does not answer at all, and the app mounts only after
 * `initBackend()` resolves, so without this the page renders nothing. The
 * fallback exists so that GraphQL mode costs users nothing when it is
 * unavailable, and a blank page is a cost.
 *
 * `AbortSignal.timeout` is newer than the build target, hence the controller.
 */
const PROBE_TIMEOUT_MS = 5_000;

/** What the plugin's `dockerFolderLayout` query answers with. */
interface GqlFolderMember {
  id: number;
  containerId: string;
  containerName: string;
  position: number;
}

interface GqlFolder {
  id: number;
  name: string;
  icon: string | null;
  color: string | null;
  position: number;
  collapsed: boolean;
  composeProject: string | null;
  sortMode: string;
  createdAt: number;
  updatedAt: number;
  containers: GqlFolderMember[];
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string }[];
}

/**
 * Run an operation and normalize it into a BackendResult.
 *
 * A GraphQL error is a failure even though the transport answered 200, so
 * `ok` follows the payload rather than the status line, and the first error
 * message becomes `error`.
 */
async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<BackendResult<T>> {
  const controller = timeoutMs === undefined ? null : new AbortController();
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': getCsrfToken(),
      },
      body: JSON.stringify({ query, variables }),
      signal: controller?.signal,
    });
  } catch {
    // An abort lands here too, which is the behavior we want: a timed-out
    // probe is a failed probe.
    return { ok: false, status: 0, data: {} as T, error: 'The Unraid API did not respond.' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  let body: GqlResponse<T>;
  try {
    body = (await response.json()) as GqlResponse<T>;
  } catch {
    // nginx answers a stopped API with an HTML 502, so there is no GraphQL
    // error to read and the status line is all that happened.
    return {
      ok: false,
      status: response.status,
      data: {} as T,
      error: `The Unraid API answered HTTP ${response.status}.`,
    };
  }

  if (body.errors?.length || !body.data) {
    return {
      ok: false,
      status: response.status,
      data: {} as T,
      error: body.errors?.[0]?.message ?? 'GraphQL request failed',
    };
  }

  return { ok: true, status: response.status, data: body.data };
}

/** The fields every mutation that answers with a folder selects. */
const FOLDER_FIELDS = `
  id
  name
  icon
  color
  position
  collapsed
  composeProject
  sortMode
  createdAt
  updatedAt
  containers {
    id
    containerId
    containerName
    position
  }
`;

const CREATE_FOLDER = `
  mutation CreateDockerFolder($input: DockerFolderCreateInput!) {
    createDockerFolder(input: $input) { ${FOLDER_FIELDS} }
  }
`;

const UPDATE_FOLDER = `
  mutation UpdateDockerFolder($id: Int!, $input: DockerFolderUpdateInput!) {
    updateDockerFolder(id: $id, input: $input) { ${FOLDER_FIELDS} }
  }
`;

const DELETE_FOLDER = `
  mutation DeleteDockerFolder($id: Int!) {
    deleteDockerFolder(id: $id)
  }
`;

const ADD_CONTAINER = `
  mutation AddContainerToDockerFolder($folderId: Int!, $containerId: String!, $containerName: String!) {
    addContainerToDockerFolder(
      folderId: $folderId
      containerId: $containerId
      containerName: $containerName
    ) { ${FOLDER_FIELDS} }
  }
`;

const REMOVE_CONTAINER = `
  mutation RemoveContainerFromDockerFolder($containerName: String!) {
    removeContainerFromDockerFolder(containerName: $containerName)
  }
`;

const REORDER_CONTAINERS = `
  mutation ReorderDockerFolderContainers($folderId: Int!, $containerIds: [String!]!) {
    reorderDockerFolderContainers(folderId: $folderId, containerIds: $containerIds) {
      ${FOLDER_FIELDS}
    }
  }
`;

const REORDER_FOLDERS = `
  mutation ReorderDockerFolders($folderIds: [Int!]!) {
    reorderDockerFolders(folderIds: $folderIds)
  }
`;

const REORDER_UNFOLDERED = `
  mutation ReorderUnfolderedDockerContainers($containerNames: [String!]!) {
    reorderUnfolderedDockerContainers(containerNames: $containerNames)
  }
`;

/**
 * The container actions, one mutation each.
 *
 * These call the plugin rather than upstream's `docker.mutations`, which is a
 * correction to the plan. On the Unraid API version users have (4.35.1) there
 * is no `restart` mutation at all, upstream's `start` leaves a paused
 * container paused, its `remove` always forces, and none of them can clear the
 * folder membership the removed container leaves behind. See the plugin's
 * `ContainerService` for the full reasoning.
 *
 * Each answers a bare boolean, which is all the store reads before it
 * refetches.
 */
const CONTAINER_ACTIONS: Record<Exclude<ContainerAction, 'remove'>, string> = {
  start: `
    mutation StartDockerContainer($id: String!) {
      startDockerContainer(id: $id)
    }
  `,
  resume: `
    mutation ResumeDockerContainer($id: String!) {
      resumeDockerContainer(id: $id)
    }
  `,
  stop: `
    mutation StopDockerContainer($id: String!) {
      stopDockerContainer(id: $id)
    }
  `,
  restart: `
    mutation RestartDockerContainer($id: String!) {
      restartDockerContainer(id: $id)
    }
  `,
};

const REMOVE_DOCKER_CONTAINER = `
  mutation RemoveDockerContainer($id: String!, $removeImage: Boolean) {
    removeDockerContainer(id: $id, removeImage: $removeImage)
  }
`;

const LAYOUT_QUERY = `
  query DockerFolderLayout {
    dockerFolderLayout {
      unfolderedOrder
      folders { ${FOLDER_FIELDS} }
    }
  }
`;

const PROBE_QUERY = `
  query DockerFoldersInfo {
    dockerFoldersInfo {
      version
      databaseReadable
    }
  }
`;

/** The plugin speaks camelCase; the app's own types are the PHP column names. */
function toFolder(folder: GqlFolder): Folder {
  return {
    id: folder.id,
    name: folder.name,
    icon: folder.icon,
    color: folder.color,
    position: folder.position,
    collapsed: folder.collapsed,
    compose_project: folder.composeProject,
    sort_mode: folder.sortMode as SortMode,
    created_at: folder.createdAt,
    updated_at: folder.updatedAt,
    containers: folder.containers.map(
      (member): ContainerAssociation => ({
        id: member.id,
        container_id: member.containerId,
        container_name: member.containerName,
        folder_id: folder.id,
        position: member.position,
      }),
    ),
  };
}

/**
 * Ask the plugin whether it is loaded and can read its database.
 *
 * A plugin can be installed and silently not loaded, and safe mode disables
 * plugin loading outright, so GraphQL mode has to prove itself before the app
 * commits to it.
 */
export async function probeGraphqlBackend(): Promise<{ ok: boolean; reason: string }> {
  const { ok, error, data } = await gql<{
    dockerFoldersInfo: { version: string; databaseReadable: boolean };
  }>(PROBE_QUERY, undefined, PROBE_TIMEOUT_MS);

  if (!ok) {
    return { ok: false, reason: error || 'The GraphQL probe failed.' };
  }
  if (!data.dockerFoldersInfo.databaseReadable) {
    return { ok: false, reason: 'The plugin cannot read its database.' };
  }
  return { ok: true, reason: `plugin ${data.dockerFoldersInfo.version}` };
}

/**
 * Reshape a successful result and pass a failed one straight through.
 *
 * Every operation here answers in the plugin's shape and has to hand the app
 * its own shape back. Rebuilding the result by hand at each one drops `error`,
 * which is how a store ends up with no message to show.
 */
function mapResult<A, B>(result: BackendResult<A>, toApp: (data: A) => B): BackendResult<B> {
  if (!result.ok) {
    return { ok: false, status: result.status, data: {} as B, error: result.error };
  }
  return { ok: true, status: result.status, data: toApp(result.data) };
}

/**
 * PHP's `errorResponse()` answers a failure as `{error: true, message}`, and a
 * few stores read `data.message` directly rather than the outer `error` field
 * (compose file reads, compose/schedule create). `mapResult` alone leaves
 * `data` empty on failure, so those callers would see `undefined` instead of
 * the PHP-shaped message. Use this wherever that matters.
 */
function toErrorBody(result: BackendResult<unknown>): { error: true; message: string | undefined } {
  return { error: true, message: result.error };
}

const CONTAINER_LIST = `
  query DockerFoldersContainerList {
    dockerFoldersContainerList {
      containers {
        id name image state status command created networkMode
        privileged capAdd exposedPorts user imageUser puid pgid umask
        icon managed webui autostart autostartDelay
        ports { ip privatePort publicPort type }
        hostPorts { hostIp hostPort containerPort type }
        mounts { type source destination rw }
        networkSettings { name ipAddress }
        labels { key value }
      }
      dismissals { containerName findingType }
    }
  }
`;

const DISMISS_FINDING = `
  mutation DismissDockerFoldersFinding($containerName: String!, $findingType: String!) {
    dismissDockerFoldersFinding(containerName: $containerName, findingType: $findingType)
  }
`;

const RESTORE_FINDING = `
  mutation RestoreDockerFoldersFinding($containerName: String!, $findingType: String!) {
    restoreDockerFoldersFinding(containerName: $containerName, findingType: $findingType)
  }
`;

const EXPORT_FOLDERS = `
  query DockerFoldersExport {
    dockerFoldersExport
  }
`;

const IMPORT_FOLDERS = `
  mutation ImportDockerFolders($configJson: String!) {
    importDockerFolders(configJson: $configJson) {
      success foldersCreated containersAssigned errors
    }
  }
`;

const PATH_SUGGESTIONS = `
  query DockerFoldersPathSuggestions($scope: String, $path: String, $container: String, $project: String) {
    dockerFoldersPathSuggestions(scope: $scope, path: $path, container: $container, project: $project) {
      base
      entries { name path }
      hasSqlite
    }
  }
`;

const CRON_BACKED_SETTINGS = new Set(['update_check_schedule', 'enable_update_checks']);

const SETTINGS = `
  query DockerFoldersSettings {
    dockerFoldersSettings { key value }
  }
`;

const SET_SETTING = `
  mutation SetDockerFoldersSetting($input: DockerFoldersSettingInput!) {
    setDockerFoldersSetting(input: $input) { key value }
  }
`;

interface GqlContainer extends Omit<Container, 'ports' | 'mounts' | 'networkSettings' | 'labels'> {
  ports: { ip: string | null; privatePort: number; publicPort: number | null; type: string }[];
  mounts: { type: string; source: string; destination: string; rw: boolean }[];
  networkSettings: { name: string; ipAddress: string }[];
  labels: { key: string; value: string }[];
}

/**
 * Rebuild the REST shape the stores already read.
 *
 * GraphQL has no map type, so the plugin sends labels and networks as lists
 * of pairs, and it names Docker's fields in camelCase. The stores were written
 * against `containers.php`, which passes Docker's own shapes through, so this
 * puts both back. `IP` and `PublicPort` are left off entirely when absent,
 * because that is what Docker's JSON does for an unpublished port and what the
 * port-conflict code was written against.
 */
function toContainer(c: GqlContainer): Container {
  return {
    ...c,
    ports: c.ports.map((port) => ({
      ...(port.ip === null ? {} : { IP: port.ip }),
      PrivatePort: port.privatePort,
      ...(port.publicPort === null ? {} : { PublicPort: port.publicPort }),
      Type: port.type,
    })) as Container['ports'],
    mounts: c.mounts.map((m) => ({ Type: m.type, Source: m.source, Destination: m.destination, RW: m.rw })),
    networkSettings: Object.fromEntries(
      c.networkSettings.map((n) => [n.name, { IPAddress: n.ipAddress }]),
    ),
    labels: Object.fromEntries(c.labels.map((l) => [l.key, l.value])),
  };
}

// ─── Container extras: logs, live stats, autostart, adopt fields ────────

const CONTAINER_LOGS = `
  query DockerFoldersContainerLogs($id: String!, $tail: Int) {
    dockerFoldersContainerLogs(id: $id, tail: $tail) {
      logs
      error
      message
    }
  }
`;

const CONTAINER_STATS = `
  query DockerFoldersContainerStats($ids: [String!]!) {
    dockerFoldersContainerStats(ids: $ids) {
      id
      stats {
        cpuPercent memoryUsage memoryLimit memoryPercent blockRead blockWrite
        netRx netTx pids restartCount startedAt imageSize logSize
      }
    }
  }
`;

const SET_AUTOSTART = `
  mutation SetDockerFoldersAutostart($name: String!, $enabled: Boolean!, $delay: Int) {
    setDockerFoldersAutostart(name: $name, enabled: $enabled, delay: $delay) {
      success
      autostart
      autostartDelay
    }
  }
`;

const CONTAINER_ADOPT_FIELDS = `
  query DockerFoldersAdoptFields($id: String!) {
    dockerFoldersAdoptFields(id: $id) {
      fields { key value }
      configs { name target default mode description type display required mask value }
      unmapped
      imageEnvKnown
      portsPublished
      networkDriver
      managed
    }
  }
`;

/** `DockerFoldersContainerStats`'s fields are already the app's own camelCase names — no remap needed. */
interface GqlContainerStatsEntry {
  id: string;
  stats: ContainerStats | null;
}

interface GqlAdoptConfig {
  name: string;
  target: string;
  default: string;
  mode: string;
  description: string;
  type: string;
  display: string;
  required: string;
  mask: string;
  value: string;
}

interface GqlAdoptFields {
  fields: { key: string; value: string }[];
  configs: GqlAdoptConfig[];
  unmapped: string[];
  imageEnvKnown: boolean;
  portsPublished: boolean;
  networkDriver: string;
  managed: string | null;
}

/**
 * `AdoptConfig`'s ten attributes match Unraid's own `<Config>` XML exactly
 * (`Name`, `Target`, ...), which is why `buildAdoptForm` in `unraidHandoff.ts`
 * reads them PascalCase. The resolver spells the same ten lowercase for
 * GraphQL (see `container-extras.resolver.ts`'s comment on the remap it does
 * the other way), so this undoes that.
 */
function toAdoptConfig(c: GqlAdoptConfig): AdoptConfig {
  return {
    Name: c.name,
    Target: c.target,
    Default: c.default,
    Mode: c.mode,
    Description: c.description,
    Type: c.type,
    Display: c.display,
    Required: c.required,
    Mask: c.mask,
    Value: c.value,
  };
}

/** `fields` travels as a list of pairs over GraphQL; `unraidHandoff.ts` wants the flat map `postToXML` reads. */
function toAdoptFields(data: GqlAdoptFields): AdoptFields {
  return {
    fields: Object.fromEntries(data.fields.map((f) => [f.key, f.value])),
    configs: data.configs.map(toAdoptConfig),
    unmapped: data.unmapped,
    imageEnvKnown: data.imageEnvKnown,
    portsPublished: data.portsPublished,
    networkDriver: data.networkDriver,
    managed: data.managed,
  };
}

// ─── Image updates ────────────────────────────────────────────────────────

const IMAGE_UPDATE_FIELDS = `
  image
  localDigest
  remoteDigest
  updateAvailable
  checkedAt
  error
  sourceUrl
  sourceRepo
  release { tag name publishedAt url summary fetchedAt }
`;

const CACHED_IMAGE_UPDATES = `
  query DockerFoldersImageUpdates {
    dockerFoldersImageUpdates { ${IMAGE_UPDATE_FIELDS} }
  }
`;

const CHECK_IMAGE_UPDATES = `
  mutation CheckDockerFoldersImageUpdates($images: [String!]) {
    checkDockerFoldersImageUpdates(images: $images) { ${IMAGE_UPDATE_FIELDS} }
  }
`;

interface GqlReleaseNote {
  tag: string | null;
  name: string | null;
  publishedAt: number | null;
  url: string | null;
  summary: string;
  fetchedAt: number;
}

interface GqlImageUpdateStatus {
  image: string;
  localDigest: string | null;
  remoteDigest: string | null;
  updateAvailable: boolean;
  checkedAt: number;
  error: string | null;
  sourceUrl: string | null;
  sourceRepo: string | null;
  release: GqlReleaseNote | null;
}

function toReleaseNote(r: GqlReleaseNote): ReleaseNote {
  return {
    tag: r.tag,
    name: r.name,
    published_at: r.publishedAt,
    url: r.url,
    summary: r.summary,
    fetched_at: r.fetchedAt,
  };
}

function toImageUpdateStatus(row: GqlImageUpdateStatus): ImageUpdateStatus {
  return {
    image: row.image,
    local_digest: row.localDigest,
    remote_digest: row.remoteDigest,
    update_available: row.updateAvailable,
    checked_at: row.checkedAt,
    error: row.error,
    source_url: row.sourceUrl,
    source_repo: row.sourceRepo,
    release: row.release ? toReleaseNote(row.release) : null,
  };
}

/** Keyed the way `updates.php`'s `handleGet`/`handlePost` key their `updates` map: by image reference. */
function toUpdatesMap(rows: GqlImageUpdateStatus[]): Record<string, ImageUpdateStatus> {
  return Object.fromEntries(rows.map((row) => [row.image, toImageUpdateStatus(row)]));
}

// ─── Schedules ──────────────────────────────────────────────────────────

/** What `dockerFoldersSchedules` answers with, one row. */
interface GqlSchedule {
  id: number;
  name: string;
  targetType: string;
  targetId: string;
  action: string;
  cronExpression: string;
  enabled: boolean;
  backupConfigJson: string | null;
  lastRunAt: number | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface GqlScheduleRunner {
  lastTick: number | null;
  stale: boolean;
  staleAfter: number;
  cronInstalled: boolean;
  repaired: boolean;
}

interface GqlScheduleHistoryEntry {
  id: number;
  scheduleId: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  message: string | null;
  backupFile: string | null;
  backupSize: number | null;
}

const SCHEDULE_FIELDS = `
  id name targetType targetId action cronExpression enabled backupConfigJson
  lastRunAt lastRunStatus lastRunMessage nextRunAt createdAt updatedAt
`;

const RUNNER_FIELDS = `lastTick stale staleAfter cronInstalled repaired`;

/** One document for both queries, so the store's single `list()` call is one request. */
const SCHEDULE_LIST = `
  query DockerFoldersScheduleList {
    dockerFoldersSchedules { ${SCHEDULE_FIELDS} }
    dockerFoldersScheduleRunner { ${RUNNER_FIELDS} }
  }
`;

const CREATE_SCHEDULE = `
  mutation CreateDockerFoldersSchedule($input: DockerFoldersScheduleInput!) {
    createDockerFoldersSchedule(input: $input)
  }
`;

const UPDATE_SCHEDULE = `
  mutation UpdateDockerFoldersSchedule($id: Int!, $input: DockerFoldersScheduleInput!) {
    updateDockerFoldersSchedule(id: $id, input: $input)
  }
`;

const DELETE_SCHEDULE = `
  mutation DeleteDockerFoldersSchedule($id: Int!) {
    deleteDockerFoldersSchedule(id: $id)
  }
`;

const TOGGLE_SCHEDULE = `
  mutation ToggleDockerFoldersSchedule($id: Int!, $enabled: Boolean!) {
    toggleDockerFoldersSchedule(id: $id, enabled: $enabled)
  }
`;

const BULK_TOGGLE_SCHEDULES = `
  mutation BulkToggleDockerFoldersSchedules($updates: [DockerFoldersScheduleToggle!]!) {
    bulkToggleDockerFoldersSchedules(updates: $updates)
  }
`;

const BULK_DELETE_SCHEDULES = `
  mutation BulkDeleteDockerFoldersSchedules($ids: [Int!]!) {
    bulkDeleteDockerFoldersSchedules(ids: $ids)
  }
`;

const RUN_SCHEDULE = `
  mutation RunDockerFoldersSchedule($id: Int!) {
    runDockerFoldersSchedule(id: $id) { success scheduleId status message }
  }
`;

const SCHEDULE_HISTORY = `
  query DockerFoldersScheduleHistory($id: Int!, $limit: Int) {
    dockerFoldersScheduleHistory(id: $id, limit: $limit) {
      id scheduleId startedAt finishedAt status message backupFile backupSize
    }
  }
`;

const SCHEDULE_BACKUPS = `
  query DockerFoldersBackups($targetType: String!, $targetId: String!) {
    dockerFoldersBackups(targetType: $targetType, targetId: $targetId) {
      path filename size createdAt
    }
  }
`;

const DELETE_BACKUP = `
  mutation DeleteDockerFoldersBackup($path: String!) {
    deleteDockerFoldersBackup(path: $path)
  }
`;

function toSchedule(row: GqlSchedule): Schedule {
  return {
    id: row.id,
    name: row.name,
    target_type: row.targetType as Schedule['target_type'],
    target_id: row.targetId,
    action: row.action as Schedule['action'],
    cron_expression: row.cronExpression,
    enabled: row.enabled,
    // The column is JSON text on both backends; only this edge parses it.
    backup_config: row.backupConfigJson ? (JSON.parse(row.backupConfigJson) as Schedule['backup_config']) : null,
    last_run_at: row.lastRunAt,
    last_run_status: row.lastRunStatus as Schedule['last_run_status'],
    last_run_message: row.lastRunMessage,
    next_run_at: row.nextRunAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toRunnerState(r: GqlScheduleRunner): ScheduleRunnerState {
  return {
    last_tick: r.lastTick,
    stale: r.stale,
    stale_after: r.staleAfter,
    cron_installed: r.cronInstalled,
    repaired: r.repaired,
  };
}

function toHistoryEntry(row: GqlScheduleHistoryEntry): ScheduleHistoryEntry {
  return {
    id: row.id,
    schedule_id: row.scheduleId,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    status: row.status as ScheduleHistoryEntry['status'],
    message: row.message,
    backup_file: row.backupFile,
    backup_size: row.backupSize,
  };
}

/**
 * Every field the store may send, only when it named it. `backup_config` is
 * stringified into the JSON column the plugin (and PHP) actually stores;
 * `JSON.stringify` drops the rest when `undefined`, matching PHP's `isset()`.
 */
function toScheduleInput(body: Partial<Schedule>) {
  return {
    name: body.name,
    targetType: body.target_type,
    targetId: body.target_id,
    action: body.action,
    cronExpression: body.cron_expression,
    enabled: body.enabled,
    // `!= null` (not `!== undefined`): PHP's `isset()`/`empty()` treat an
    // explicit `null` the same as "not sent", and a stray `JSON.stringify(null)`
    // would otherwise send the *string* "null", which the plugin stores as a
    // truthy value instead of leaving the column alone.
    backupConfigJson: body.backup_config != null ? JSON.stringify(body.backup_config) : undefined,
  };
}

// ─── Compose ────────────────────────────────────────────────────────────

interface GqlComposeStack {
  projectName: string;
  workingDir: string | null;
  composeFile: string | null;
  envFile: string | null;
  autostart: boolean;
  autostartForceRecreate: boolean;
  description: string | null;
  importedFrom: string | null;
  servicesRunning: number;
  servicesTotal: number;
  serviceNames: string[];
}

interface GqlComposeStatus {
  composeAvailable: boolean;
  composeVersion: string | null;
  composePluginInstalled: boolean;
  managementEnabled: boolean;
  composePluginDataExists: boolean;
}

interface GqlComposeActionResult {
  success: boolean;
  output: string | null;
  error: string | null;
}

interface GqlComposeFileVersion {
  id: number;
  fileType: string;
  filePath: string;
  contentHash: string;
  createdAt: number;
}

const COMPOSE_STATUS_FIELDS = `composeAvailable composeVersion composePluginInstalled managementEnabled composePluginDataExists`;

const COMPOSE_STATUS = `
  query DockerFoldersComposeStatus {
    dockerFoldersComposeStatus { ${COMPOSE_STATUS_FIELDS} }
  }
`;

const COMPOSE_STACKS = `
  query DockerFoldersComposeStacks {
    dockerFoldersComposeStacks {
      projectName workingDir composeFile envFile autostart autostartForceRecreate
      description importedFrom servicesRunning servicesTotal serviceNames
    }
  }
`;

const INSTALL_COMPOSE_BINARY = `
  mutation InstallDockerFoldersComposeBinary {
    installDockerFoldersComposeBinary { success error status { ${COMPOSE_STATUS_FIELDS} } }
  }
`;

/** One mutation per action, keyed the same way `CONTAINER_ACTIONS` is above. */
const COMPOSE_STACK_ACTIONS: Record<'up' | 'down' | 'stop' | 'restart' | 'pull', string> = {
  up: `
    mutation BringUpDockerFoldersComposeStack($project: String!, $forceRecreate: Boolean) {
      bringUpDockerFoldersComposeStack(project: $project, forceRecreate: $forceRecreate) { success output error }
    }
  `,
  down: `
    mutation BringDownDockerFoldersComposeStack($project: String!) {
      bringDownDockerFoldersComposeStack(project: $project) { success output error }
    }
  `,
  stop: `
    mutation StopDockerFoldersComposeStack($project: String!) {
      stopDockerFoldersComposeStack(project: $project) { success output error }
    }
  `,
  restart: `
    mutation RestartDockerFoldersComposeStack($project: String!) {
      restartDockerFoldersComposeStack(project: $project) { success output error }
    }
  `,
  pull: `
    mutation PullDockerFoldersComposeStack($project: String!) {
      pullDockerFoldersComposeStack(project: $project) { success output error }
    }
  `,
};

const COMPOSE_ACTION_FIELD: Record<'up' | 'down' | 'stop' | 'restart' | 'pull', string> = {
  up: 'bringUpDockerFoldersComposeStack',
  down: 'bringDownDockerFoldersComposeStack',
  stop: 'stopDockerFoldersComposeStack',
  restart: 'restartDockerFoldersComposeStack',
  pull: 'pullDockerFoldersComposeStack',
};

const VALIDATE_COMPOSE = `
  mutation ValidateDockerFoldersComposeContent($project: String!, $content: String) {
    validateDockerFoldersComposeContent(project: $project, content: $content) {
      success output errors { line column message }
    }
  }
`;

const GET_COMPOSE_FILE = `
  query DockerFoldersComposeFile($project: String!) {
    dockerFoldersComposeFile(project: $project) { content path }
  }
`;

const GET_COMPOSE_ENV = `
  query DockerFoldersComposeEnv($project: String!) {
    dockerFoldersComposeEnv(project: $project) { content path }
  }
`;

const SAVE_COMPOSE_FILE = `
  mutation SaveDockerFoldersComposeFile($project: String!, $content: String!) {
    saveDockerFoldersComposeFile(project: $project, content: $content) { content path }
  }
`;

const SAVE_COMPOSE_ENV = `
  mutation SaveDockerFoldersComposeEnv($project: String!, $content: String!) {
    saveDockerFoldersComposeEnv(project: $project, content: $content) { content path }
  }
`;

const SET_COMPOSE_ENV_PATH = `
  mutation SetDockerFoldersComposeEnvPath($project: String!, $path: String!) {
    setDockerFoldersComposeEnvPath(project: $project, path: $path)
  }
`;

const SET_COMPOSE_AUTOSTART = `
  mutation SetDockerFoldersComposeAutostart($project: String!, $input: DockerFoldersComposeAutostartInput!) {
    setDockerFoldersComposeAutostart(project: $project, input: $input)
  }
`;

const COMPOSE_LOGS = `
  query DockerFoldersComposeLogs($project: String!, $tail: Int) {
    dockerFoldersComposeLogs(project: $project, tail: $tail) { output error }
  }
`;

const IMPORT_COMPOSE_STACKS = `
  mutation ImportDockerFoldersComposeStacks {
    importDockerFoldersComposeStacks { success stacksImported stacksSkipped errors }
  }
`;

const CREATE_COMPOSE_STACK = `
  mutation CreateDockerFoldersComposeStack($input: DockerFoldersComposeCreateInput!) {
    createDockerFoldersComposeStack(input: $input) { success error projectName }
  }
`;

const COMPOSE_FILE_VERSIONS = `
  query DockerFoldersComposeFileVersions($project: String!, $fileType: String) {
    dockerFoldersComposeFileVersions(project: $project, fileType: $fileType) {
      id fileType filePath contentHash createdAt
    }
  }
`;

const COMPOSE_FILE_VERSION = `
  query DockerFoldersComposeFileVersion($project: String!, $versionId: Int!) {
    dockerFoldersComposeFileVersion(project: $project, versionId: $versionId) {
      id fileType filePath contentHash createdAt content
    }
  }
`;

const RESTORE_COMPOSE_VERSION = `
  mutation RestoreDockerFoldersComposeFileVersion($project: String!, $versionId: Int!) {
    restoreDockerFoldersComposeFileVersion(project: $project, versionId: $versionId) { content path }
  }
`;

function toComposeStatus(s: GqlComposeStatus): ComposeStatus {
  return {
    compose_available: s.composeAvailable,
    compose_version: s.composeVersion,
    compose_plugin_installed: s.composePluginInstalled,
    management_enabled: s.managementEnabled,
    compose_plugin_data_exists: s.composePluginDataExists,
  };
}

function toComposeStack(s: GqlComposeStack): ComposeStack {
  return {
    project_name: s.projectName,
    working_dir: s.workingDir,
    compose_file: s.composeFile,
    env_file: s.envFile,
    autostart: s.autostart,
    autostart_force_recreate: s.autostartForceRecreate,
    description: s.description,
    imported_from: s.importedFrom,
    services_running: s.servicesRunning,
    services_total: s.servicesTotal,
    service_names: s.serviceNames,
  };
}

function toComposeFileVersion(v: GqlComposeFileVersion): ComposeFileVersion {
  return {
    id: v.id,
    file_type: v.fileType as ComposeFileVersion['file_type'],
    file_path: v.filePath,
    content_hash: v.contentHash,
    created_at: v.createdAt,
  };
}

export const graphqlBackend: Backend = {
  ...phpBackend,
  kind: 'graphql',

  containers: {
    list: async () =>
      mapResult(
        await gql<{
          dockerFoldersContainerList: {
            containers: GqlContainer[];
            dismissals: { containerName: string; findingType: string }[];
          };
        }>(CONTAINER_LIST),
        (data) => ({
          containers: data.dockerFoldersContainerList.containers.map(toContainer),
          dismissals: data.dockerFoldersContainerList.dismissals.map((d) => ({
            container_name: d.containerName,
            finding_type: d.findingType,
          })),
        }),
      ),

    setFindingDismissed: async (action, containerName, findingType) =>
      mapResult(
        await gql<Record<string, boolean>>(
          action === 'dismiss-finding' ? DISMISS_FINDING : RESTORE_FINDING,
          { containerName, findingType },
        ),
        () => ({}),
      ),

    action: async (action, id, body) => {
      if (action === 'remove') {
        return mapResult(
          await gql<{ removeDockerContainer: boolean }>(REMOVE_DOCKER_CONTAINER, {
            id,
            removeImage: body?.remove_image === true,
          }),
          () => ({}),
        );
      }
      return mapResult(
        await gql<Record<string, boolean>>(CONTAINER_ACTIONS[action], { id }),
        () => ({}),
      );
    },

    // The seam passes a container *name* here (ContainerCard.vue reads
    // `container.name`), where the resolver's argument is called `id`.
    // Dockerode — and Docker's own `/containers/{id}/...` routes underneath
    // it — resolve either a name or an id with no format check, the same way
    // `DockerClient::getContainerLogs`/`inspectContainerRaw` do in PHP, so
    // this is not a mismatch.
    logs: async (name, tail) =>
      mapResult(
        await gql<{ dockerFoldersContainerLogs: { logs: string; error: boolean; message: string | null } }>(
          CONTAINER_LOGS,
          { id: name, tail },
        ),
        (data) => ({
          logs: data.dockerFoldersContainerLogs.logs,
          error: data.dockerFoldersContainerLogs.error,
          message: data.dockerFoldersContainerLogs.message ?? undefined,
        }),
      ),

    adoptFields: async (name) => {
      const result = await gql<{ dockerFoldersAdoptFields: GqlAdoptFields }>(CONTAINER_ADOPT_FIELDS, {
        id: name,
      });
      if (!result.ok) {
        // `containers.php` 404s a missing container; the resolver throws
        // NotFoundException instead, which `gql()` already turned into
        // `ok: false` with the message in `error`. ContainerCard.vue's
        // openAdopt() reads `failure` off that, same as the PHP path.
        return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      }
      return { ok: true, status: result.status, data: toAdoptFields(result.data.dockerFoldersAdoptFields) };
    },

    setAutostart: async (name, body) =>
      mapResult(
        await gql<{
          setDockerFoldersAutostart: { success: boolean; autostart: boolean; autostartDelay: number | null };
        }>(SET_AUTOSTART, { name, enabled: body.enabled, delay: body.delay ?? null }),
        (data) => ({
          success: data.setDockerFoldersAutostart.success,
          autostart: data.setDockerFoldersAutostart.autostart,
          // PHP's `jsonResponse` includes `autostartDelay: null` (not omitted)
          // when no delay was sent; pass the resolver's null straight through
          // rather than coercing it to undefined, which would drop the key.
          autostartDelay: data.setDockerFoldersAutostart.autostartDelay,
        }),
      ),
  },

  folders: {
    ...phpBackend.folders,

    list: async () =>
      mapResult(
        await gql<{ dockerFolderLayout: { folders: GqlFolder[]; unfolderedOrder: string[] } }>(
          LAYOUT_QUERY,
        ),
        (data) => ({
          folders: data.dockerFolderLayout.folders.map(toFolder),
          unfoldered_order: data.dockerFolderLayout.unfolderedOrder,
        }),
      ),

    create: async (body: FolderCreateData) =>
      mapResult(
        await gql<{ createDockerFolder: GqlFolder }>(CREATE_FOLDER, {
          input: {
            name: body.name,
            icon: body.icon ?? null,
            color: body.color ?? null,
          },
        }),
        (data) => ({ folder: toFolder(data.createDockerFolder) }),
      ),

    update: async (id: number, body: FolderUpdateData) =>
      mapResult(
        await gql<{ updateDockerFolder: GqlFolder }>(UPDATE_FOLDER, {
          id,
          // Only what the caller named. The plugin leaves an absent column
          // alone, the same way PHP's `isset` checks do.
          input: {
            name: body.name,
            icon: body.icon,
            color: body.color,
            position: body.position,
            collapsed: body.collapsed,
            sortMode: body.sort_mode,
          },
        }),
        (data) => ({ folder: toFolder(data.updateDockerFolder) }),
      ),

    remove: async (id: number) =>
      mapResult(await gql<{ deleteDockerFolder: boolean }>(DELETE_FOLDER, { id }), () => ({})),

    addContainer: async (folderId, body) =>
      mapResult(
        await gql<{ addContainerToDockerFolder: GqlFolder }>(ADD_CONTAINER, {
          folderId,
          containerId: body.container_id,
          containerName: body.container_name,
        }),
        (data) => ({ folder: toFolder(data.addContainerToDockerFolder) }),
      ),

    removeContainer: async (body) =>
      mapResult(
        await gql<{ removeContainerFromDockerFolder: boolean }>(REMOVE_CONTAINER, {
          containerName: body.container_name,
        }),
        () => ({}),
      ),

    reorderContainers: async (folderId, body) =>
      mapResult(
        await gql<{ reorderDockerFolderContainers: GqlFolder }>(REORDER_CONTAINERS, {
          folderId,
          containerIds: body.container_ids,
        }),
        (data) => ({ folder: toFolder(data.reorderDockerFolderContainers) }),
      ),

    reorderFolders: async (body) =>
      mapResult(
        await gql<{ reorderDockerFolders: boolean }>(REORDER_FOLDERS, {
          folderIds: body.folder_ids,
        }),
        () => ({}),
      ),

    // The file travels as JSON text both ways, because it is a file format:
    // an export from either backend has to import into the other unchanged.
    exportConfig: async () =>
      mapResult(await gql<{ dockerFoldersExport: string }>(EXPORT_FOLDERS), (data) =>
        JSON.parse(data.dockerFoldersExport),
      ),

    importConfig: async (body) =>
      mapResult(
        await gql<{
          importDockerFolders: {
            success: boolean;
            foldersCreated: number;
            containersAssigned: number;
            errors: string[];
          };
        }>(IMPORT_FOLDERS, { configJson: JSON.stringify(body) }),
        (data) => ({
          success: data.importDockerFolders.success,
          folders_created: data.importDockerFolders.foldersCreated,
          containers_assigned: data.importDockerFolders.containersAssigned,
          errors: data.importDockerFolders.errors,
        }),
      ),

    reorderUnfoldered: async (body) =>
      mapResult(
        await gql<{ reorderUnfolderedDockerContainers: string[] }>(REORDER_UNFOLDERED, {
          containerNames: body.container_names,
        }),
        (data) => ({ unfoldered_order: data.reorderUnfolderedDockerContainers }),
      ),
  },

  schedules: {
    list: async () =>
      mapResult(
        await gql<{ dockerFoldersSchedules: GqlSchedule[]; dockerFoldersScheduleRunner: GqlScheduleRunner }>(
          SCHEDULE_LIST,
        ),
        (data) => ({
          schedules: data.dockerFoldersSchedules.map(toSchedule),
          runner: toRunnerState(data.dockerFoldersScheduleRunner),
        }),
      ),

    create: async (body) => {
      const result = await gql<{ createDockerFoldersSchedule: number }>(CREATE_SCHEDULE, {
        input: toScheduleInput(body),
      });
      if (!result.ok) return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      return { ok: true, status: result.status, data: { id: result.data.createDockerFoldersSchedule } };
    },

    update: async (id, body) =>
      mapResult(
        await gql<{ updateDockerFoldersSchedule: boolean }>(UPDATE_SCHEDULE, { id, input: toScheduleInput(body) }),
        () => ({}),
      ),

    remove: async (id) =>
      mapResult(await gql<{ deleteDockerFoldersSchedule: boolean }>(DELETE_SCHEDULE, { id }), () => ({})),

    toggle: async (id, body) =>
      mapResult(
        await gql<{ toggleDockerFoldersSchedule: boolean }>(TOGGLE_SCHEDULE, { id, enabled: body.enabled }),
        () => ({}),
      ),

    bulkToggle: async (body) =>
      mapResult(
        await gql<{ bulkToggleDockerFoldersSchedules: number }>(BULK_TOGGLE_SCHEDULES, { updates: body.updates }),
        () => ({}),
      ),

    bulkDelete: async (body) =>
      mapResult(
        await gql<{ bulkDeleteDockerFoldersSchedules: number }>(BULK_DELETE_SCHEDULES, { ids: body.ids }),
        () => ({}),
      ),

    run: async (id) =>
      mapResult(
        await gql<{
          runDockerFoldersSchedule: { success: boolean; scheduleId: number; status: string; message: string };
        }>(RUN_SCHEDULE, { id }),
        (data) => ({
          success: data.runDockerFoldersSchedule.success,
          message: data.runDockerFoldersSchedule.message,
        }),
      ),

    history: async (id, limit) =>
      mapResult(
        await gql<{ dockerFoldersScheduleHistory: GqlScheduleHistoryEntry[] }>(SCHEDULE_HISTORY, { id, limit }),
        (data) => ({ history: data.dockerFoldersScheduleHistory.map(toHistoryEntry) }),
      ),

    backups: async (targetType, targetId) =>
      mapResult(
        await gql<{
          dockerFoldersBackups: { path: string; filename: string; size: number; createdAt: number }[];
        }>(SCHEDULE_BACKUPS, { targetType, targetId }),
        (data) => ({
          backups: data.dockerFoldersBackups.map(
            (b): BackupEntry => ({ path: b.path, filename: b.filename, size: b.size, created_at: b.createdAt }),
          ),
        }),
      ),

    deleteBackup: async (body) =>
      mapResult(await gql<{ deleteDockerFoldersBackup: boolean }>(DELETE_BACKUP, { path: body.path }), () => ({})),
  },

  compose: {
    status: async () =>
      mapResult(await gql<{ dockerFoldersComposeStatus: GqlComposeStatus }>(COMPOSE_STATUS), (data) =>
        toComposeStatus(data.dockerFoldersComposeStatus),
      ),

    list: async () =>
      mapResult(await gql<{ dockerFoldersComposeStacks: GqlComposeStack[] }>(COMPOSE_STACKS), (data) => ({
        stacks: data.dockerFoldersComposeStacks.map(toComposeStack),
      })),

    installBinary: async () => {
      const result = await gql<{
        installDockerFoldersComposeBinary: { success: boolean; error: string | null; status: GqlComposeStatus | null };
      }>(INSTALL_COMPOSE_BINARY);
      if (!result.ok) return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      const install = result.data.installDockerFoldersComposeBinary;
      if (!install.success) {
        // `api/compose.php` 500s when `installComposeBinary()` reports
        // failure; the mutation answers the same failure without throwing, so
        // convert it here to keep the store's `!ok` branch working.
        const message = install.error ?? 'Failed to install Docker Compose';
        return { ok: false, status: result.status, data: { error: true, message }, error: message };
      }
      return {
        ok: true,
        status: result.status,
        data: { status: install.status ? toComposeStatus(install.status) : undefined },
      };
    },

    stackAction: async (project, action, body) => {
      const variables: Record<string, unknown> = { project };
      if (action === 'up') variables.forceRecreate = body?.force_recreate === true;
      const result = await gql<Record<string, GqlComposeActionResult>>(COMPOSE_STACK_ACTIONS[action], variables);
      if (!result.ok) {
        // The management-disabled gate throws a GraphQL error rather than
        // answering `success: false` (see the resolver's per-action table).
        // The store's stackUp/Down/Stop/Restart read `data.message` on
        // failure, same as PHP's `errorResponse()` body, so put it there too.
        return { ok: false, status: result.status, data: { success: false, message: result.error }, error: result.error };
      }
      const r = result.data[COMPOSE_ACTION_FIELD[action]];
      return {
        ok: true,
        status: result.status,
        data: { success: r.success, output: r.output ?? undefined, error: r.error ?? undefined },
      };
    },

    validate: async (project, content) =>
      mapResult(
        await gql<{
          validateDockerFoldersComposeContent: {
            success: boolean;
            output: string;
            errors: { line: number; column: number | null; message: string }[];
          };
        }>(VALIDATE_COMPOSE, { project, content: content ?? null }),
        (data) => ({
          success: data.validateDockerFoldersComposeContent.success,
          output: data.validateDockerFoldersComposeContent.output,
          errors: data.validateDockerFoldersComposeContent.errors.map(
            (e): ComposeValidationError => ({ line: e.line, column: e.column ?? undefined, message: e.message }),
          ),
        }),
      ),

    getFile: async (project) => {
      const result = await gql<{ dockerFoldersComposeFile: { content: string; path: string } }>(GET_COMPOSE_FILE, {
        project,
      });
      if (!result.ok) {
        // The plugin throws NotFoundException for a missing file; PHP answers
        // the same case with `{error: true, message}` and the store reads
        // `data.message`, not the outer `error`, so mirror that shape.
        return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      }
      const file = result.data.dockerFoldersComposeFile;
      return { ok: true, status: result.status, data: { content: file.content, path: file.path } };
    },

    saveFile: async (project, body) => {
      const result = await gql<{ saveDockerFoldersComposeFile: { content: string; path: string } }>(
        SAVE_COMPOSE_FILE,
        { project, content: String(body.content ?? '') },
      );
      if (!result.ok) return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      return { ok: true, status: result.status, data: {} };
    },

    getEnv: async (project) => {
      // An absent env file is not an error on either backend — the resolver
      // only throws for a real read failure — so this only differs from
      // `getFile` in which query it runs.
      const result = await gql<{ dockerFoldersComposeEnv: { content: string; path: string } }>(GET_COMPOSE_ENV, {
        project,
      });
      if (!result.ok) {
        return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      }
      const file = result.data.dockerFoldersComposeEnv;
      return { ok: true, status: result.status, data: { content: file.content, path: file.path } };
    },

    saveEnv: async (project, body) => {
      const result = await gql<{ saveDockerFoldersComposeEnv: { content: string; path: string } }>(
        SAVE_COMPOSE_ENV,
        { project, content: String(body.content ?? '') },
      );
      if (!result.ok) return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      return { ok: true, status: result.status, data: {} };
    },

    setEnvPath: async (project, body) =>
      mapResult(
        await gql<{ setDockerFoldersComposeEnvPath: boolean }>(SET_COMPOSE_ENV_PATH, {
          project,
          path: String(body.path ?? ''),
        }),
        () => ({}),
      ),

    setAutostart: async (project, body) =>
      mapResult(
        await gql<{ setDockerFoldersComposeAutostart: boolean }>(SET_COMPOSE_AUTOSTART, {
          project,
          input: { enabled: body.enabled === true, forceRecreate: body.force_recreate === true },
        }),
        () => ({}),
      ),

    logs: async (project, tail) =>
      mapResult(
        await gql<{ dockerFoldersComposeLogs: { output: string | null; error: string | null } }>(COMPOSE_LOGS, {
          project,
          tail,
        }),
        (data) => ({
          output: data.dockerFoldersComposeLogs.output ?? undefined,
          error: data.dockerFoldersComposeLogs.error ?? undefined,
        }),
      ),

    importStacks: async () =>
      mapResult(
        await gql<{
          importDockerFoldersComposeStacks: {
            success: boolean;
            stacksImported: number;
            stacksSkipped: number;
            errors: string[];
          };
        }>(IMPORT_COMPOSE_STACKS),
        (data) => ({
          success: data.importDockerFoldersComposeStacks.success,
          stacks_imported: data.importDockerFoldersComposeStacks.stacksImported,
          stacks_skipped: data.importDockerFoldersComposeStacks.stacksSkipped,
          errors: data.importDockerFoldersComposeStacks.errors,
        }),
      ),

    create: async (body) => {
      const result = await gql<{
        createDockerFoldersComposeStack: { success: boolean; error: string | null; projectName: string | null };
      }>(CREATE_COMPOSE_STACK, {
        input: {
          projectName: body.project_name,
          composeContent: body.compose_content,
          envContent: body.env_content,
        },
      });
      if (!result.ok) return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      const stack = result.data.createDockerFoldersComposeStack;
      if (!stack.success) {
        // `api/compose.php` 400s when `createStack()` reports failure; the
        // mutation answers the same failure without throwing, so convert it.
        const message = stack.error ?? 'Failed to create stack';
        return { ok: false, status: result.status, data: { error: true, message }, error: message };
      }
      return { ok: true, status: result.status, data: { success: true, project_name: stack.projectName } };
    },

    fileVersions: async (project, fileType) =>
      mapResult(
        await gql<{ dockerFoldersComposeFileVersions: GqlComposeFileVersion[] }>(COMPOSE_FILE_VERSIONS, {
          project,
          fileType,
        }),
        (data) => ({ versions: data.dockerFoldersComposeFileVersions.map(toComposeFileVersion) }),
      ),

    fileVersion: async (project, versionId) => {
      const result = await gql<{ dockerFoldersComposeFileVersion: GqlComposeFileVersion & { content: string } }>(
        COMPOSE_FILE_VERSION,
        { project, versionId },
      );
      if (!result.ok) {
        return { ok: false, status: result.status, data: toErrorBody(result), error: result.error };
      }
      const v = result.data.dockerFoldersComposeFileVersion;
      const version: ComposeFileVersionDetail = { ...toComposeFileVersion(v), content: v.content };
      return { ok: true, status: result.status, data: { version } };
    },

    restoreVersion: async (project, body) =>
      mapResult(
        await gql<{ restoreDockerFoldersComposeFileVersion: { content: string; path: string } }>(
          RESTORE_COMPOSE_VERSION,
          { project, versionId: Number(body.version_id) },
        ),
        () => ({}),
      ),
  },

  settings: {
    getAll: async () =>
      mapResult(await gql<{ dockerFoldersSettings: { key: string; value: string | null }[] }>(SETTINGS), (data) => ({
        settings: Object.fromEntries(
          data.dockerFoldersSettings.map((row) => [row.key, row.value ?? '']),
        ),
      })),

    set: async (key, value) => {
      // These two rewrite the update-check cron line on the PHP side, and the
      // plugin does not own that job yet. Sending them here would store the
      // value and silently leave the old schedule running.
      if (CRON_BACKED_SETTINGS.has(key)) return phpBackend.settings.set(key, value);
      return mapResult(
        await gql<Record<string, unknown>>(SET_SETTING, { input: { key, value } }),
        () => ({}),
      );
    },
  },

  stats: {
    get: async (ids) =>
      mapResult(
        await gql<{ dockerFoldersContainerStats: GqlContainerStatsEntry[] }>(CONTAINER_STATS, { ids }),
        (data) => ({
          stats: Object.fromEntries(data.dockerFoldersContainerStats.map((entry) => [entry.id, entry.stats])),
        }),
      ),
  },

  updates: {
    getCached: async () =>
      mapResult(
        await gql<{ dockerFoldersImageUpdates: GqlImageUpdateStatus[] }>(CACHED_IMAGE_UPDATES),
        (data) => ({ updates: toUpdatesMap(data.dockerFoldersImageUpdates) }),
      ),

    check: async (body) => {
      // The store sends `{images: string[]}` for a targeted check, or nothing
      // for "check everything running" — `updates.php`'s own distinction.
      // `images: undefined` drops the variable from the JSON body entirely,
      // which is what the mutation's nullable arg treats as "not restricted".
      const images = Array.isArray(body?.images)
        ? body.images.filter((img): img is string => typeof img === 'string' && img !== '')
        : undefined;
      return mapResult(
        await gql<{ checkDockerFoldersImageUpdates: GqlImageUpdateStatus[] }>(CHECK_IMAGE_UPDATES, { images }),
        (data) => ({ updates: toUpdatesMap(data.checkDockerFoldersImageUpdates) }),
      );
    },
  },

  paths: {
    list: async (params) =>
      mapResult(
        await gql<{
          dockerFoldersPathSuggestions: {
            base: string;
            entries: { name: string; path: string }[];
            hasSqlite: boolean;
          };
        }>(PATH_SUGGESTIONS, {
          scope: params.scope,
          path: params.path,
          container: params.container,
          project: params.project,
        }),
        (data) => ({
          base: data.dockerFoldersPathSuggestions.base,
          entries: data.dockerFoldersPathSuggestions.entries,
          has_sqlite: data.dockerFoldersPathSuggestions.hasSqlite,
        }),
      ),
  },

  // Overrides the `...phpBackend` spread above — without this, GraphQL mode
  // would silently keep using PHP's SSE streams for the three progress
  // modals (still correct, just not the transport this mode exists to
  // exercise).
  streams: graphqlStreams,

  live: graphqlLive,
};
