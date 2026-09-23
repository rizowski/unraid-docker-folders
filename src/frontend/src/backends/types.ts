/**
 * The backend seam.
 *
 * Every store calls this interface instead of `apiFetch` directly, so the
 * transport can be swapped without touching store logic. Two implementations
 * exist: `php.ts` talks to the plugin's own `api/*.php` endpoints, and
 * `graphql.ts` talks to the Unraid API at `/graphql`.
 *
 * Methods return a result rather than throwing. That mirrors `response.ok`
 * plus a parsed body exactly, which lets every store keep the control flow it
 * already had: some read an error message off a non-ok body, some return a
 * boolean, some set an `error` ref. A throwing interface would have forced all
 * three into one shape and changed behavior.
 *
 * A transport-level failure (network down, invalid JSON) surfaces as
 * `ok: false` with `status: 0`, so callers never have to try/catch to stay
 * correct. Stores may still catch, and several do.
 */

import type { Container, SecurityDismissal } from '@/stores/docker';
import type { AdoptFields } from '@/utils/unraidHandoff';
import type { ContainerStats } from '@/stores/stats';
import type { ImageUpdateStatus } from '@/stores/updates';
import type {
  BackupEntry,
  PathSuggestion,
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
import type {
  Folder,
  FolderCreateData,
  FolderExportConfig,
  FolderImportResult,
  FolderUpdateData,
} from '@/types/folder';

/** Which transport the app talks to. */
export type BackendMode = 'php' | 'graphql';

export interface BackendResult<T = unknown> {
  /** True when the request succeeded. */
  ok: boolean;
  /**
   * HTTP status, or 0 when the request never completed.
   *
   * Diagnostics only. Do not build user-facing text out of it: GraphQL answers
   * 200 for an application error, so "HTTP 200" would name a success on a
   * failed call. Read `error` instead.
   */
  status: number;
  /** Parsed response body. `{}` when there was nothing to parse. */
  data: T;
  /**
   * Why the request failed, in words. Undefined when it succeeded.
   *
   * Both backends set this on every failure, each from what its own transport
   * gives: PHP's `message` or `error` body field, GraphQL's first `errors[]`
   * entry, or the status line when neither said anything. That keeps failure
   * text correct in every store without the store knowing which backend
   * answered.
   */
  error?: string;
}

/** Shape PHP uses for its error replies. Stores read `message` off non-ok results. */
export interface ErrorBody {
  error?: boolean | string;
  message?: string;
}

/** Endpoints that echo the affected folder back. */
export interface FolderBody extends ErrorBody {
  folder?: Folder;
}

/** What the up/down/stop/restart actions answer with. */
export interface ComposeActionBody extends ErrorBody {
  success: boolean;
  output?: string;
  error?: string;
}

/** `compose.php` file reads: content plus the resolved path, or a message. */
export interface ComposeFileBody extends ErrorBody {
  content?: string | null;
  path?: string | null;
}

/** `compose.php?action=logs` answers with combined output, not a log array. */
export interface ComposeLogsBody {
  output?: string;
  error?: string;
}

export interface ComposeValidateBody {
  success?: boolean;
  errors?: ComposeValidationError[];
  output?: string;
}

export type ContainerAction = 'start' | 'resume' | 'stop' | 'restart' | 'remove';

/** Accepting a security finding, and undoing that. */
export type FindingAction = 'dismiss-finding' | 'restore-finding';

export interface Backend {
  /** Which implementation this is. Used for diagnostics and the fallback banner. */
  readonly kind: BackendMode;

  containers: {
    list(): Promise<BackendResult<{ containers?: Container[]; dismissals?: SecurityDismissal[] }>>;
    /**
     * Start, resume, stop, restart or remove one container.
     *
     * `remove_image` is the only body field any caller sends, and only on
     * `remove`, so it is named rather than left in an untyped bag: GraphQL has
     * to spell each variable out, where PHP just forwarded the JSON.
     */
    action(
      action: ContainerAction,
      id: string,
      body?: { remove_image?: boolean },
    ): Promise<BackendResult<ErrorBody>>;
    /**
     * `delay` is only ever sent from the delay-confirm modal; PHP's own
     * `containers.php?action=autostart` branch treats an absent `delay` the
     * same as an absent key (`isset($data['delay'])`), which is why it is
     * optional here rather than `number | null`.
     */
    setAutostart(
      name: string,
      body: { enabled: boolean; delay?: number },
    ): Promise<
      BackendResult<ErrorBody & { success?: boolean; autostart?: boolean; autostartDelay?: number | null }>
    >;
    logs(name: string, tail: number): Promise<BackendResult<ErrorBody & { logs?: string }>>;
    adoptFields(name: string): Promise<BackendResult<ErrorBody & Partial<AdoptFields>>>;
    setFindingDismissed(
      action: FindingAction,
      containerName: string,
      findingType: string,
    ): Promise<BackendResult<ErrorBody>>;
  };

  /**
   * Write bodies are spelled out rather than `Record<string, unknown>`. PHP
   * forwards the object as JSON and never looks inside it, so an untyped bag
   * cost nothing there; GraphQL has to name each variable, and an untyped bag
   * turns a misspelled key into an empty argument instead of a type error.
   * The keys stay snake_case, because that is what the PHP endpoints read.
   */
  folders: {
    list(): Promise<BackendResult<{ folders?: Folder[]; unfoldered_order?: string[] }>>;
    create(body: FolderCreateData): Promise<BackendResult<FolderBody>>;
    update(id: number, body: FolderUpdateData): Promise<BackendResult<FolderBody>>;
    remove(id: number): Promise<BackendResult<ErrorBody>>;
    addContainer(
      folderId: number,
      body: { container_id: string; container_name: string },
    ): Promise<BackendResult<FolderBody>>;
    removeContainer(body: { container_name: string }): Promise<BackendResult<ErrorBody>>;
    reorderContainers(
      folderId: number,
      body: { container_ids: string[] },
    ): Promise<BackendResult<FolderBody>>;
    reorderUnfoldered(
      body: { container_names: string[] },
    ): Promise<BackendResult<ErrorBody & { unfoldered_order?: string[] }>>;
    reorderFolders(body: { folder_ids: number[] }): Promise<BackendResult<ErrorBody>>;
    exportConfig(): Promise<BackendResult<FolderExportConfig>>;
    importConfig(body: FolderExportConfig): Promise<BackendResult<FolderImportResult & ErrorBody>>;
  };

  settings: {
    getAll(): Promise<BackendResult<{ settings?: Record<string, string> }>>;
    /** Every setting writes through here. PHP stores all values as strings. */
    set(key: string, value: string): Promise<BackendResult<ErrorBody>>;
  };

  stats: {
    get(ids: string[]): Promise<BackendResult<{ stats?: Record<string, ContainerStats | null> }>>;
  };

  schedules: {
    list(): Promise<BackendResult<{ schedules?: Schedule[]; runner?: ScheduleRunnerState }>>;
    create(body: Partial<Schedule>): Promise<BackendResult<ErrorBody & { id?: number }>>;
    update(id: number, body: Partial<Schedule>): Promise<BackendResult<ErrorBody>>;
    remove(id: number): Promise<BackendResult<ErrorBody>>;
    toggle(id: number, body: { enabled: boolean }): Promise<BackendResult<ErrorBody>>;
    bulkToggle(body: { updates: { id: number; enabled: boolean }[] }): Promise<BackendResult<ErrorBody>>;
    bulkDelete(body: { ids: number[] }): Promise<BackendResult<ErrorBody>>;
    run(id: number): Promise<BackendResult<ErrorBody & { success?: boolean }>>;
    history(id: number, limit: number): Promise<BackendResult<{ history?: ScheduleHistoryEntry[] }>>;
    backups(targetType: string, targetId: string): Promise<BackendResult<{ backups?: BackupEntry[] }>>;
    deleteBackup(body: { path: string }): Promise<BackendResult<ErrorBody>>;
  };

  compose: {
    status(): Promise<BackendResult<ComposeStatus>>;
    list(): Promise<BackendResult<{ stacks?: ComposeStack[] }>>;
    installBinary(): Promise<BackendResult<ErrorBody & { status?: ComposeStatus }>>;
    stackAction(
      project: string,
      action: 'up' | 'down' | 'stop' | 'restart' | 'pull',
      body?: Record<string, unknown>,
    ): Promise<BackendResult<ComposeActionBody>>;
    validate(project: string, content?: string): Promise<BackendResult<ComposeValidateBody>>;
    getFile(project: string): Promise<BackendResult<ComposeFileBody>>;
    saveFile(project: string, body: Record<string, unknown>): Promise<BackendResult<ErrorBody>>;
    getEnv(project: string): Promise<BackendResult<ComposeFileBody>>;
    saveEnv(project: string, body: Record<string, unknown>): Promise<BackendResult<ErrorBody>>;
    setEnvPath(project: string, body: Record<string, unknown>): Promise<BackendResult<ErrorBody>>;
    setAutostart(project: string, body: Record<string, unknown>): Promise<BackendResult<ErrorBody>>;
    logs(project: string, tail: number): Promise<BackendResult<ComposeLogsBody>>;
    importStacks(body: Record<string, unknown>): Promise<BackendResult<ErrorBody & Record<string, unknown>>>;
    create(body: Record<string, unknown>): Promise<BackendResult<ErrorBody & Record<string, unknown>>>;
    fileVersions(
      project: string,
      fileType: 'compose' | 'env',
    ): Promise<BackendResult<{ versions?: ComposeFileVersion[] }>>;
    fileVersion(
      project: string,
      versionId: number,
    ): Promise<BackendResult<ErrorBody & { version?: ComposeFileVersionDetail }>>;
    restoreVersion(project: string, body: Record<string, unknown>): Promise<BackendResult<ErrorBody>>;
  };

  updates: {
    getCached(): Promise<BackendResult<{ updates?: Record<string, ImageUpdateStatus> }>>;
    check(
      body?: Record<string, unknown>,
    ): Promise<BackendResult<{ updates?: Record<string, ImageUpdateStatus> } & ErrorBody>>;
  };

  paths: {
    list(
      params: Record<string, string>,
    ): Promise<BackendResult<{ base?: string; entries?: PathSuggestion[]; has_sqlite?: boolean }>>;
  };

  /**
   * The seam behind the three streaming progress modals
   * (`PullProgressModal`, `BatchPullProgressModal`, `ComposeProgressModal`),
   * which used to talk SSE directly to `pull.php`/`compose-stream.php`.
   * `onEvent` is called once per SSE-equivalent event, in order, with `data`
   * already JSON-parsed — exactly the two arguments each modal's own
   * `handleSSEEvent(event, data)` already expects, so that logic is
   * unchanged by which backend is active.
   *
   * Resolves once the stream's terminal `done` event has been delivered.
   * Rejects on a transport failure (network error, non-2xx HTTP response, a
   * refused GraphQL subscription) with a plain `Error`, or with a
   * `DOMException` named `'AbortError'` when `signal` aborts — the same
   * shape `fetch()` itself throws on abort, so callers keep the
   * `e.name !== 'AbortError'` check they already had.
   */
  streams: {
    /** `pull.php`, or its GraphQL subscription equivalent. */
    pull(
      image: string,
      opts: { containerIds?: string[]; recreate?: boolean },
      onEvent: (event: string, data: unknown) => void,
      signal: AbortSignal,
    ): Promise<void>;
    /** `compose-stream.php`, or its GraphQL subscription equivalent. `forceRecreate` only applies to action 'up'. */
    compose(
      project: string,
      action: 'up' | 'pull',
      opts: { forceRecreate?: boolean },
      onEvent: (event: string, data: unknown) => void,
      signal: AbortSignal,
    ): Promise<void>;
  };

  /**
   * Server push for data the app would otherwise poll. Only the GraphQL
   * backend has it; PHP has nothing to push with, so its callers keep their
   * timers. A caller checks for `live` and polls when it is absent.
   *
   * Each method opens the stream and returns a function that closes it.
   * `onEnd` is called only when the stream ends without the caller closing
   * it: the server finished it, or the connection dropped, or the server
   * refused it. `error` is set in the last two cases. A caller that still
   * wants the data falls back to polling, because a dead stream is silent.
   */
  live?: {
    /** Stats for `ids`, sent at once and then every `intervalMs`. */
    stats(
      ids: string[],
      intervalMs: number,
      handlers: LiveHandlers<Record<string, ContainerStats | null>>,
    ): () => void;
    /**
     * One container's logs: first the last `tail` lines, then each batch of
     * new lines as the container writes them. Every batch has the same shape
     * as `containers.logs`, newest line first. The stream ends normally when
     * the container stops.
     */
    logs(
      name: string,
      tail: number,
      handlers: LiveHandlers<ErrorBody & { logs?: string }>,
    ): () => void;
    /**
     * A stack's `docker compose logs --follow`, replacing `compose.logs`
     * polled every 3s. Unlike `logs` above, batches are NOT self-contained:
     * the first batch is the initial `tail`, and every later batch is text to
     * append, oldest-first — the same order `docker compose logs` itself
     * prints in. A caller keeps its own accumulated string; `output` is never
     * the whole log, only what changed. The stream ends normally when the
     * compose process exits (stack brought down, or an invalid project).
     */
    composeLogs(
      project: string,
      tail: number,
      handlers: LiveHandlers<{ output: string }>,
    ): () => void;
  };
}

export interface LiveHandlers<T> {
  onData: (data: T) => void;
  onEnd: (error?: string) => void;
}
