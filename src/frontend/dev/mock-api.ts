/**
 * Mock API middleware for Vite dev server.
 *
 * Provides fake container and folder data so the UI can be tested
 * locally without a running Unraid server.
 *
 * Usage: MOCK_API=1 npm run dev
 */

import type { Plugin } from 'vite';

// --- Mock data ---

let nextFolderId = 5;

const containers = [
  {
    id: 'abc123def456', name: 'plex', image: 'linuxserver/plex:latest', state: 'running',
    status: 'Up 3 days (healthy)', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:32400]/',
    created: Date.now() / 1000 - 259200,
    ports: [{ IP: '0.0.0.0', PrivatePort: 32400, PublicPort: 32400, Type: 'tcp' }],
    mounts: [
      { Source: '/mnt/user/appdata/plex', Destination: '/config', Type: 'bind', RW: true },
      { Source: '/mnt/user/media', Destination: '/media', Type: 'bind', RW: true },
    ],
    networkSettings: { bridge: { IPAddress: '172.17.0.2' } },
    labels: { 'net.unraid.docker.support': 'https://forums.unraid.net/topic/40463-support-linuxserverio-plex-media-server/' },
  },
  {
    id: 'bcd234efg567', name: 'sonarr', image: 'linuxserver/sonarr:latest', state: 'running',
    status: 'Up 3 days (healthy)', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:8989]/',
    created: Date.now() / 1000 - 259200,
    ports: [{ IP: '0.0.0.0', PrivatePort: 8989, PublicPort: 8989, Type: 'tcp' }],
    mounts: [
      { Source: '/mnt/user/appdata/sonarr', Destination: '/config', Type: 'bind', RW: true },
      { Source: '/mnt/user/media/tv', Destination: '/tv', Type: 'bind', RW: true },
      { Source: '/mnt/user/downloads', Destination: '/downloads', Type: 'bind', RW: true },
    ],
    networkSettings: { bridge: { IPAddress: '172.17.0.3' } },
    labels: { 'com.docker.compose.project': 'media-stack', 'net.unraid.docker.support': 'https://forums.unraid.net/topic/79530-support-linuxserverio-sonarr/', 'net.unraid.docker.shell': '/bin/bash' },
  },
  {
    id: 'cde345fgh678', name: 'radarr', image: 'linuxserver/radarr:latest', state: 'running',
    status: 'Up 3 days', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:7878]/',
    created: Date.now() / 1000 - 259200,
    ports: [{ IP: '0.0.0.0', PrivatePort: 7878, PublicPort: 7878, Type: 'tcp' }],
    mounts: [
      { Source: '/mnt/user/appdata/radarr', Destination: '/config', Type: 'bind', RW: true },
      { Source: '/mnt/user/media/movies', Destination: '/movies', Type: 'bind', RW: true },
    ],
    networkSettings: { bridge: { IPAddress: '172.17.0.4' } },
    labels: { 'com.docker.compose.project': 'media-stack' },
  },
  {
    id: 'def456ghi789', name: 'sabnzbd', image: 'linuxserver/sabnzbd:latest', state: 'running',
    status: 'Up 2 days', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:8080]/',
    created: Date.now() / 1000 - 172800,
    ports: [{ IP: '0.0.0.0', PrivatePort: 8080, PublicPort: 8080, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/sabnzbd', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.5' } },
    labels: { 'com.docker.compose.project': 'media-stack' },
  },
  {
    id: 'efg567hij890', name: 'nginx-proxy', image: 'jwilder/nginx-proxy:latest', state: 'running',
    status: 'Up 5 days', icon: null, managed: 'dockerman', webui: null,
    created: Date.now() / 1000 - 432000,
    ports: [
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 80, Type: 'tcp' },
      { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 443, Type: 'tcp' },
    ],
    mounts: [{ Source: '/var/run/docker.sock', Destination: '/tmp/docker.sock', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.6' } },
    labels: {},
  },
  {
    id: 'fgh678ijk901', name: 'mariadb', image: 'linuxserver/mariadb:latest', state: 'running',
    status: 'Up 5 days (healthy)', icon: null, managed: 'dockerman', webui: null,
    created: Date.now() / 1000 - 432000,
    ports: [{ IP: '0.0.0.0', PrivatePort: 3306, PublicPort: 3306, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/mariadb', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.7' } },
    labels: { 'com.docker.compose.project': 'db-stack' },
  },
  {
    id: 'ghi789jkl012', name: 'redis', image: 'redis:7-alpine', state: 'exited',
    status: 'Exited (0) 2 hours ago', icon: null, managed: null, webui: null,
    created: Date.now() / 1000 - 86400,
    ports: [{ IP: '', PrivatePort: 6379, Type: 'tcp' }],
    mounts: [],
    networkSettings: {},
    labels: { 'com.docker.compose.project': 'db-stack' },
  },
  {
    id: 'hij890klm123', name: 'minecraft', image: 'itzg/minecraft-server:latest', state: 'exited',
    status: 'Exited (0) 1 day ago', icon: null, managed: 'dockerman', webui: null,
    created: Date.now() / 1000 - 604800,
    ports: [{ IP: '0.0.0.0', PrivatePort: 25565, PublicPort: 25565, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/minecraft', Destination: '/data', Type: 'bind', RW: true }],
    networkSettings: {},
    labels: {},
  },
  {
    id: 'ijk901lmn234', name: 'homeassistant', image: 'ghcr.io/home-assistant/home-assistant:stable', state: 'running',
    status: 'Up 1 day', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:8123]/',
    created: Date.now() / 1000 - 86400,
    ports: [{ IP: '0.0.0.0', PrivatePort: 8123, PublicPort: 8123, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/homeassistant', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { host: { IPAddress: '' } },
    labels: { 'net.unraid.docker.support': 'https://forums.unraid.net/topic/98822-support-home-assistant/', 'net.unraid.docker.project': 'https://www.home-assistant.io/' },
  },
  {
    id: 'jkl012mno345', name: 'grafana', image: 'grafana/grafana:latest', state: 'running',
    status: 'Up 4 days', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:3000]/',
    created: Date.now() / 1000 - 345600,
    ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/grafana', Destination: '/var/lib/grafana', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.10' } },
    labels: {},
  },
];

const folders: any[] = [
  {
    id: 1,
    name: 'Media',
    icon: '🎬',
    color: '#e91e63',
    position: 0,
    collapsed: false,
    compose_project: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 1, container_id: 'abc123def456', container_name: 'plex', folder_id: 1, position: 0 },
    ],
  },
  {
    id: 2,
    name: 'Infrastructure',
    icon: '🔧',
    color: '#2196f3',
    position: 1,
    collapsed: false,
    compose_project: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 4, container_id: 'efg567hij890', container_name: 'nginx-proxy', folder_id: 2, position: 0 },
    ],
  },
  {
    id: 3,
    name: 'media-stack',
    icon: 'layer-group',
    color: '#ff8c2f',
    position: 2,
    collapsed: false,
    compose_project: 'media-stack',
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 2, container_id: 'bcd234efg567', container_name: 'sonarr', folder_id: 3, position: 0 },
      { id: 3, container_id: 'cde345fgh678', container_name: 'radarr', folder_id: 3, position: 1 },
      { id: 6, container_id: 'def456ghi789', container_name: 'sabnzbd', folder_id: 3, position: 2 },
    ],
  },
  {
    id: 4,
    name: 'db-stack',
    icon: 'layer-group',
    color: '#ff8c2f',
    position: 3,
    collapsed: false,
    compose_project: 'db-stack',
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 5, container_id: 'fgh678ijk901', container_name: 'mariadb', folder_id: 4, position: 0 },
      { id: 7, container_id: 'ghi789jkl012', container_name: 'redis', folder_id: 4, position: 1 },
    ],
  },
];

// --- Helpers ---

function json(res: any, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      // Handle form-encoded (csrf_token=...&payload=...) or direct JSON
      if (body.includes('payload=')) {
        const params = new URLSearchParams(body);
        const payload = params.get('payload');
        resolve(payload ? JSON.parse(payload) : {});
      } else if (body.startsWith('{') || body.startsWith('[')) {
        resolve(JSON.parse(body));
      } else {
        resolve({});
      }
    });
  });
}

function parseUrl(url: string) {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) };
}

// --- Route handlers ---

async function handleContainers(req: any, res: any, params: Record<string, string>) {
  if (req.method === 'GET') {
    return json(res, { containers, count: containers.length, cached: false });
  }

  if (req.method === 'POST') {
    const { action, id } = params;
    const container = containers.find((c) => c.id === id);
    if (!container) return json(res, { error: true, message: 'Container not found' }, 404);

    switch (action) {
      case 'start':
        container.state = 'running';
        container.status = 'Up 1 second';
        break;
      case 'stop':
        container.state = 'exited';
        container.status = 'Exited (0) just now';
        break;
      case 'restart':
        container.status = 'Up 1 second';
        break;
      case 'remove':
        const idx = containers.indexOf(container);
        if (idx !== -1) containers.splice(idx, 1);
        // Also remove from any folder
        for (const f of folders) {
          f.containers = f.containers.filter((c: any) => c.container_id !== id);
        }
        return json(res, { success: true, message: 'Container removed', container: null });
    }

    return json(res, { success: true, message: `Container ${action}ed`, container });
  }
}

async function handleFolders(req: any, res: any, params: Record<string, string>) {
  if (req.method === 'GET') {
    return json(res, { folders, count: folders.length });
  }

  const data = await parseBody(req);
  const { action, id } = params;

  if (req.method === 'POST') {
    if (action === 'add_container' && id) {
      const folder = folders.find((f) => f.id === parseInt(id));
      if (!folder) return json(res, { error: true, message: 'Folder not found' }, 404);
      folder.containers.push({
        id: Date.now(),
        container_id: data.container_id,
        container_name: data.container_name,
        folder_id: folder.id,
        position: folder.containers.length,
      });
      return json(res, { success: true, folder });
    }

    if (action === 'remove_container') {
      for (const f of folders) {
        f.containers = f.containers.filter((c: any) => c.container_id !== data.container_id);
      }
      return json(res, { success: true });
    }

    if (action === 'reorder_containers' && id) {
      const folder = folders.find((f) => f.id === parseInt(id));
      if (!folder) return json(res, { error: true, message: 'Folder not found' }, 404);
      const reordered = data.container_ids.map((cid: string, i: number) => {
        const existing = folder.containers.find((c: any) => c.container_id === cid);
        return existing ? { ...existing, position: i } : null;
      }).filter(Boolean);
      folder.containers = reordered;
      return json(res, { success: true, folder });
    }

    if (action === 'reorder_folders') {
      data.folder_ids.forEach((fid: number, i: number) => {
        const folder = folders.find((f) => f.id === fid);
        if (folder) folder.position = i;
      });
      return json(res, { success: true });
    }

    // Default: create folder
    const newFolder = {
      id: nextFolderId++,
      name: data.name || 'New Folder',
      icon: data.icon || '📁',
      color: data.color || '#ff8c2f',
      position: folders.length,
      collapsed: false,
      created_at: Date.now(),
      updated_at: Date.now(),
      containers: [],
    };
    folders.push(newFolder);
    return json(res, { success: true, folder: newFolder }, 201);
  }

  if (req.method === 'PUT' && id) {
    const folder = folders.find((f) => f.id === parseInt(id));
    if (!folder) return json(res, { error: true, message: 'Folder not found' }, 404);
    Object.assign(folder, data, { updated_at: Date.now() });
    return json(res, { success: true, folder });
  }

  if (req.method === 'DELETE' && id) {
    const idx = folders.findIndex((f) => f.id === parseInt(id));
    if (idx === -1) return json(res, { error: true, message: 'Folder not found' }, 404);
    folders.splice(idx, 1);
    return json(res, { success: true });
  }
}

// --- Settings mock ---

const settings: Record<string, string> = {
  version: '1.0.0',
  default_view: 'folders',
  auto_collapse: '0',
  show_stats: '1',
  theme: 'auto',
  distinguish_healthy: '1',
  enable_update_checks: '0',
};

async function handleSettings(req: any, res: any) {
  if (req.method === 'GET') {
    return json(res, { settings });
  }

  if (req.method === 'POST') {
    const data = await parseBody(req);
    if (data.key && data.value !== undefined) {
      settings[data.key] = data.value;
      return json(res, { success: true, key: data.key, value: data.value });
    }
    return json(res, { error: true, message: 'Missing key or value' }, 400);
  }
}

// --- Stats mock ---

const EXITED_IDS = new Set(['ghi789jkl012', 'hij890klm123']);

const mockStatsProfiles: Record<string, { cpuBase: number; memBase: number; memLimit: number; pids: number; restarts: number; startedHoursAgo: number; imageSizeMB: number; logSizeMB: number }> = {
  abc123def456: { cpuBase: 15, memBase: 2048, memLimit: 8192, pids: 45, restarts: 0, startedHoursAgo: 72, imageSizeMB: 350, logSizeMB: 8 },
  bcd234efg567: { cpuBase: 5, memBase: 512, memLimit: 4096, pids: 12, restarts: 0, startedHoursAgo: 72, imageSizeMB: 220, logSizeMB: 15 },
  cde345fgh678: { cpuBase: 4, memBase: 480, memLimit: 4096, pids: 10, restarts: 0, startedHoursAgo: 72, imageSizeMB: 225, logSizeMB: 12 },
  def456ghi789: { cpuBase: 8, memBase: 768, memLimit: 4096, pids: 8, restarts: 0, startedHoursAgo: 48, imageSizeMB: 180, logSizeMB: 45 },
  efg567hij890: { cpuBase: 2, memBase: 128, memLimit: 2048, pids: 4, restarts: 1, startedHoursAgo: 120, imageSizeMB: 55, logSizeMB: 3 },
  fgh678ijk901: { cpuBase: 3, memBase: 256, memLimit: 2048, pids: 15, restarts: 0, startedHoursAgo: 120, imageSizeMB: 420, logSizeMB: 120 },
  ijk901lmn234: { cpuBase: 12, memBase: 1024, memLimit: 4096, pids: 30, restarts: 2, startedHoursAgo: 24, imageSizeMB: 1200, logSizeMB: 1200 },
  jkl012mno345: { cpuBase: 6, memBase: 384, memLimit: 2048, pids: 18, restarts: 0, startedHoursAgo: 96, imageSizeMB: 310, logSizeMB: 5 },
};

function generateMockStats(id: string) {
  if (EXITED_IDS.has(id)) return null;

  const profile = mockStatsProfiles[id];
  if (!profile) return null;

  const jitter = () => (Math.random() - 0.5) * 0.3 + 1; // 0.85 - 1.15
  const MB = 1024 * 1024;

  const memUsage = Math.round(profile.memBase * MB * jitter());
  const memLimit = profile.memLimit * MB;

  return {
    cpuPercent: Math.round(profile.cpuBase * jitter() * 10) / 10,
    memoryUsage: memUsage,
    memoryLimit: memLimit,
    memoryPercent: Math.round((memUsage / memLimit) * 10000) / 100,
    blockRead: Math.round(50 * MB * jitter()),
    blockWrite: Math.round(20 * MB * jitter()),
    netRx: Math.round(200 * MB * jitter()),
    netTx: Math.round(50 * MB * jitter()),
    pids: profile.pids,
    restartCount: profile.restarts,
    startedAt: new Date(Date.now() - profile.startedHoursAgo * 3600_000).toISOString(),
    imageSize: Math.round(profile.imageSizeMB * MB),
    logSize: Math.round(profile.logSizeMB * MB),
  };
}

function handleStats(_req: any, res: any, params: Record<string, string>) {
  const idsParam = params.ids || '';
  const ids = idsParam.split(',').filter(Boolean);
  const stats: Record<string, any> = {};
  for (const id of ids) {
    stats[id] = generateMockStats(id);
  }
  return json(res, { stats });
}

// --- Updates mock ---

const mockUpdateChecks: Record<string, any> = {};

function handleUpdates(req: any, res: any, params: Record<string, string>) {
  if (req.method === 'GET') {
    return json(res, { updates: mockUpdateChecks });
  }

  if (req.method === 'POST' && params.action === 'check') {
    // Simulate checking — mark a few containers as having updates
    const imagesToCheck = [...new Set(containers.map((c) => c.image))];
    const now = Math.floor(Date.now() / 1000);

    for (const image of imagesToCheck) {
      const hasUpdate = image.includes('plex') || image.includes('sonarr') || image.includes('grafana');
      mockUpdateChecks[image] = {
        image,
        local_digest: `${image}@sha256:abc123`,
        remote_digest: hasUpdate ? 'sha256:def456' : 'sha256:abc123',
        update_available: hasUpdate,
        checked_at: now,
        error: null,
      };
    }

    return json(res, { updates: mockUpdateChecks });
  }
}

// --- Pull mock (SSE) ---

function handlePull(req: any, res: any, params: Record<string, string>) {
  if (req.method !== 'POST') {
    return json(res, { error: true, message: 'Method not allowed' }, 405);
  }

  const image = params.image;
  if (!image) {
    return json(res, { error: true, message: 'Image parameter required' }, 400);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });

  const layers = ['a1b2c3d4e5f6', 'b2c3d4e5f6a1', 'c3d4e5f6a1b2'];
  const statuses = ['Pulling fs layer', 'Downloading', 'Downloading', 'Download complete', 'Extracting', 'Pull complete'];
  let step = 0;

  function sendEvent(event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  sendEvent('status', { message: `Pulling ${image}...` });

  const interval = setInterval(() => {
    const layerIdx = Math.floor(step / statuses.length);
    const statusIdx = step % statuses.length;

    if (layerIdx >= layers.length) {
      clearInterval(interval);
      // Clear update flag
      if (mockUpdateChecks[image]) {
        mockUpdateChecks[image].update_available = false;
        mockUpdateChecks[image].local_digest = mockUpdateChecks[image].remote_digest;
      }
      sendEvent('complete', { message: 'Pull complete', image });
      sendEvent('done', { finished: true });
      res.end();
      return;
    }

    const status = statuses[statusIdx];
    const data: any = { id: layers[layerIdx], status };

    if (status === 'Downloading') {
      const progress = statusIdx === 1 ? 0.5 : 1.0;
      data.current = Math.round(50_000_000 * progress);
      data.total = 50_000_000;
    }

    sendEvent('progress', data);
    step++;
  }, 200);

  req.on('close', () => clearInterval(interval));
}

// --- Vite plugin ---

export function mockApiPlugin(): Plugin {
  return {
    name: 'mock-api',
    configureServer(server) {
      const API_PREFIX = '/plugins/unraid-docker-folders-modern/api';

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(API_PREFIX)) return next();

        const { path, params } = parseUrl(req.url);
        const endpoint = path.replace(API_PREFIX + '/', '');

        try {
          if (endpoint === 'containers.php') {
            await handleContainers(req, res, params);
          } else if (endpoint === 'folders.php') {
            await handleFolders(req, res, params);
          } else if (endpoint === 'settings.php') {
            await handleSettings(req, res);
          } else if (endpoint === 'stats.php') {
            handleStats(req, res, params);
          } else if (endpoint === 'updates.php') {
            handleUpdates(req, res, params);
          } else if (endpoint === 'pull.php') {
            handlePull(req, res, params);
          } else {
            json(res, { error: true, message: 'Not found' }, 404);
          }
        } catch (e: any) {
          console.error('Mock API error:', e);
          json(res, { error: true, message: e.message }, 500);
        }
      });

      console.log('\n  Mock API enabled — serving fake container/folder data\n');
    },
  };
}
