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

let nextFolderId = 3;

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
  },
  {
    id: 'def456ghi789', name: 'sabnzbd', image: 'linuxserver/sabnzbd:latest', state: 'running',
    status: 'Up 2 days', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:8080]/',
    created: Date.now() / 1000 - 172800,
    ports: [{ IP: '0.0.0.0', PrivatePort: 8080, PublicPort: 8080, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/sabnzbd', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.5' } },
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
  },
  {
    id: 'fgh678ijk901', name: 'mariadb', image: 'linuxserver/mariadb:latest', state: 'running',
    status: 'Up 5 days (healthy)', icon: null, managed: 'dockerman', webui: null,
    created: Date.now() / 1000 - 432000,
    ports: [{ IP: '0.0.0.0', PrivatePort: 3306, PublicPort: 3306, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/mariadb', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.7' } },
  },
  {
    id: 'ghi789jkl012', name: 'redis', image: 'redis:7-alpine', state: 'exited',
    status: 'Exited (0) 2 hours ago', icon: null, managed: null, webui: null,
    created: Date.now() / 1000 - 86400,
    ports: [{ IP: '', PrivatePort: 6379, Type: 'tcp' }],
    mounts: [],
    networkSettings: {},
  },
  {
    id: 'hij890klm123', name: 'minecraft', image: 'itzg/minecraft-server:latest', state: 'exited',
    status: 'Exited (0) 1 day ago', icon: null, managed: 'dockerman', webui: null,
    created: Date.now() / 1000 - 604800,
    ports: [{ IP: '0.0.0.0', PrivatePort: 25565, PublicPort: 25565, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/minecraft', Destination: '/data', Type: 'bind', RW: true }],
    networkSettings: {},
  },
  {
    id: 'ijk901lmn234', name: 'homeassistant', image: 'ghcr.io/home-assistant/home-assistant:stable', state: 'running',
    status: 'Up 1 day', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:8123]/',
    created: Date.now() / 1000 - 86400,
    ports: [{ IP: '0.0.0.0', PrivatePort: 8123, PublicPort: 8123, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/homeassistant', Destination: '/config', Type: 'bind', RW: true }],
    networkSettings: { host: { IPAddress: '' } },
  },
  {
    id: 'jkl012mno345', name: 'grafana', image: 'grafana/grafana:latest', state: 'running',
    status: 'Up 4 days', icon: null, managed: 'dockerman', webui: 'http://[IP]:[PORT:3000]/',
    created: Date.now() / 1000 - 345600,
    ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }],
    mounts: [{ Source: '/mnt/user/appdata/grafana', Destination: '/var/lib/grafana', Type: 'bind', RW: true }],
    networkSettings: { bridge: { IPAddress: '172.17.0.10' } },
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
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 1, container_id: 'abc123def456', container_name: 'plex', folder_id: 1, position: 0 },
      { id: 2, container_id: 'bcd234efg567', container_name: 'sonarr', folder_id: 1, position: 1 },
      { id: 3, container_id: 'cde345fgh678', container_name: 'radarr', folder_id: 1, position: 2 },
    ],
  },
  {
    id: 2,
    name: 'Infrastructure',
    icon: '🔧',
    color: '#2196f3',
    position: 1,
    collapsed: false,
    created_at: Date.now(),
    updated_at: Date.now(),
    containers: [
      { id: 4, container_id: 'efg567hij890', container_name: 'nginx-proxy', folder_id: 2, position: 0 },
      { id: 5, container_id: 'fgh678ijk901', container_name: 'mariadb', folder_id: 2, position: 1 },
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
  show_stats: '0',
  theme: 'auto',
  distinguish_healthy: '1',
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
