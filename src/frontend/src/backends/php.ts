/**
 * PHP backend: the plugin's own `api/*.php` endpoints.
 *
 * This is a faithful move of the calls that used to live in the stores. The
 * URLs, methods, and body shapes are unchanged, so behavior in PHP mode is
 * identical to before the seam existed.
 *
 * CSRF handling stays in `apiFetch`: the token rides in a form-encoded body
 * field because Unraid's `local_prepend.php` reads `$_POST['csrf_token']`.
 * The GraphQL backend does not inherit that; it sends an `x-csrf-token`
 * header, which is what the Unraid API actually wants.
 */

import { apiFetch, getCsrfToken } from '@/utils/csrf';
import type {
  FolderCreateData,
  FolderExportConfig,
  FolderUpdateData,
} from '@/types/folder';
import { runSseStream } from './sse';
import type { Backend, BackendResult, ContainerAction, ErrorBody } from './types';

const API_BASE = '/plugins/unraid-docker-folders-modern/api';

const enc = encodeURIComponent;

/**
 * Run a request and normalize it into a BackendResult.
 *
 * A non-2xx still parses the body, because several endpoints return their
 * error message there and the stores read it. A transport failure or an
 * unparseable body becomes `ok: false` with `status: 0` so no caller is
 * obliged to try/catch.
 */
async function request<T>(url: string, options: RequestInit = {}): Promise<BackendResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(url, options);
  } catch {
    return { ok: false, status: 0, data: {} as T, error: 'The server did not respond.' };
  }

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    // Some endpoints answer with an empty body on success.
    data = {} as T;
  }

  if (response.ok) {
    return { ok: true, status: response.status, data };
  }

  return { ok: false, status: response.status, data, error: errorMessage(data, response.status) };
}

/**
 * Read a failure message off a PHP error body.
 *
 * The endpoints are not consistent: most answer `{error: true, message: "..."}`
 * but some put the text in `error` itself. Fall back to the status line, which
 * is honest here because PHP really does answer 4xx and 5xx on a failure.
 */
function errorMessage(data: unknown, status: number): string {
  const body = (data ?? {}) as ErrorBody;
  if (typeof body.message === 'string' && body.message) return body.message;
  if (typeof body.error === 'string' && body.error) return body.error;
  return `HTTP ${status}`;
}

/** POST with a JSON body, which apiFetch re-wraps as a form-encoded `payload` field. */
function post<T>(url: string, body?: unknown): Promise<BackendResult<T>> {
  return request<T>(url, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const phpBackend: Backend = {
  kind: 'php',

  containers: {
    list: () => request(`${API_BASE}/containers.php`),
    action: (action: ContainerAction, id: string, body?: Record<string, unknown>) =>
      post(`${API_BASE}/containers.php?action=${action}&id=${id}`, body),
    setAutostart: (name, body) =>
      post(`${API_BASE}/containers.php?action=autostart&name=${enc(name)}`, body),
    logs: (name, tail) =>
      request(`${API_BASE}/containers.php?action=logs&id=${enc(name)}&tail=${tail}`),
    adoptFields: (name) =>
      request(`${API_BASE}/containers.php?action=adopt-fields&id=${enc(name)}`),
    setFindingDismissed: (action, containerName, findingType) =>
      post(`${API_BASE}/containers.php?action=${action}`, {
        container_name: containerName,
        finding_type: findingType,
      }),
  },

  folders: {
    list: () => request(`${API_BASE}/folders.php`),
    create: (body: FolderCreateData) => post(`${API_BASE}/folders.php`, body),
    update: (id, body: FolderUpdateData) =>
      request(`${API_BASE}/folders.php?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    remove: (id) => request(`${API_BASE}/folders.php?id=${id}`, { method: 'DELETE' }),
    addContainer: (folderId, body) =>
      post(`${API_BASE}/folders.php?id=${folderId}&action=add_container`, body),
    removeContainer: (body) => post(`${API_BASE}/folders.php?action=remove_container`, body),
    reorderContainers: (folderId, body) =>
      post(`${API_BASE}/folders.php?id=${folderId}&action=reorder_containers`, body),
    reorderUnfoldered: (body) => post(`${API_BASE}/folders.php?action=reorder_unfoldered`, body),
    reorderFolders: (body) => post(`${API_BASE}/folders.php?action=reorder_folders`, body),
    exportConfig: () => request(`${API_BASE}/folders.php?action=export`),
    importConfig: (body: FolderExportConfig) => post(`${API_BASE}/folders.php?action=import`, body),
  },

  settings: {
    getAll: () => request(`${API_BASE}/settings.php`),
    set: (key, value) => post(`${API_BASE}/settings.php`, { key, value }),
  },

  stats: {
    get: (ids) => request(`${API_BASE}/stats.php?ids=${ids.join(',')}`),
  },

  schedules: {
    list: () => request(`${API_BASE}/schedules.php`),
    create: (body) => post(`${API_BASE}/schedules.php`, body),
    update: (id, body) =>
      request(`${API_BASE}/schedules.php?id=${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    remove: (id) => request(`${API_BASE}/schedules.php?id=${id}`, { method: 'DELETE' }),
    toggle: (id, body) => post(`${API_BASE}/schedules.php?action=toggle&id=${id}`, body),
    bulkToggle: (body) => post(`${API_BASE}/schedules.php?action=bulk_toggle`, body),
    bulkDelete: (body) => post(`${API_BASE}/schedules.php?action=bulk_delete`, body),
    run: (id) => post(`${API_BASE}/schedules.php?action=run&id=${id}`),
    history: (id, limit) =>
      request(`${API_BASE}/schedules.php?action=history&id=${id}&limit=${limit}`),
    backups: (targetType, targetId) =>
      request(
        `${API_BASE}/schedules.php?action=backups&target_type=${enc(targetType)}&target_id=${enc(targetId)}`,
      ),
    deleteBackup: (body) => post(`${API_BASE}/schedules.php?action=delete_backup`, body),
  },

  compose: {
    status: () => request(`${API_BASE}/compose.php?action=status`),
    list: () => request(`${API_BASE}/compose.php?action=list`),
    installBinary: () => post(`${API_BASE}/compose.php?action=install_binary`),
    stackAction: (project, action, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=${action}`, body),
    validate: (project, content) =>
      post(
        `${API_BASE}/compose.php?project=${enc(project)}&action=validate`,
        content !== undefined ? { content } : undefined,
      ),
    getFile: (project) => request(`${API_BASE}/compose.php?project=${enc(project)}&action=file`),
    saveFile: (project, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=save_file`, body),
    getEnv: (project) => request(`${API_BASE}/compose.php?project=${enc(project)}&action=env`),
    saveEnv: (project, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=save_env`, body),
    setEnvPath: (project, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=set_env_path`, body),
    setAutostart: (project, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=autostart`, body),
    logs: (project, tail) =>
      request(`${API_BASE}/compose.php?project=${enc(project)}&action=logs&tail=${tail}`),
    importStacks: (body) => post(`${API_BASE}/compose.php?action=import`, body),
    create: (body) => post(`${API_BASE}/compose.php?action=create`, body),
    fileVersions: (project, fileType) =>
      request(
        `${API_BASE}/compose.php?project=${enc(project)}&action=versions&file_type=${fileType}`,
      ),
    fileVersion: (project, versionId) =>
      request(
        `${API_BASE}/compose.php?project=${enc(project)}&action=version&version_id=${versionId}`,
      ),
    restoreVersion: (project, body) =>
      post(`${API_BASE}/compose.php?project=${enc(project)}&action=restore_version`, body),
  },

  updates: {
    getCached: () => request(`${API_BASE}/updates.php`),
    check: (body) => post(`${API_BASE}/updates.php?action=check`, body),
  },

  paths: {
    list: (params) => request(`${API_BASE}/paths.php?${new URLSearchParams(params).toString()}`),
  },

  streams: {
    pull: (image, opts, onEvent, signal) => {
      const body = new URLSearchParams();
      const token = getCsrfToken();
      if (token) body.append('csrf_token', token);
      if (opts.containerIds && opts.containerIds.length > 0) {
        body.append('containers', opts.containerIds.join(','));
      }
      if (opts.recreate) body.append('recreate', '1');
      return runSseStream(`${API_BASE}/pull.php?image=${enc(image)}`, body, onEvent, signal);
    },
    compose: (project, action, opts, onEvent, signal) => {
      const body = new URLSearchParams();
      const token = getCsrfToken();
      if (token) body.append('csrf_token', token);
      if (action === 'up' && opts.forceRecreate) body.append('force_recreate', '1');
      return runSseStream(
        `${API_BASE}/compose-stream.php?action=${action}&project=${enc(project)}`,
        body,
        onEvent,
        signal,
      );
    },
  },
};
