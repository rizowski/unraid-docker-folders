# Unraid Docker Folders Modern - Project Status

**Last Updated**: 2026-02-15
**Current Phase**: Phase 3 in progress — Live container resource stats

---

## Phase Status

### Phase 1: Core Infrastructure - COMPLETE
- Repository structure, Vue 3 + Vite frontend, PHP backend with API endpoints
- SQLite database with migrations, automated build system
- Docker API integration via unix socket, PLG installer

### Phase 2: Folder Management - COMPLETE
- Folder CRUD (create, read, update, delete) with icons, colors, positioning
- Drag-and-drop container assignment between folders (SortableJS)
- Import/export folder configurations as JSON
- Pinia stores for docker and folder state
- Menu integration: "Folders" tab under Docker, settings page under Utilities

**Resolved issues:**
- Page rendering blank (Docker.page filename collision - renamed to DockerFoldersMain.page)
- CSRF token missing on POST/PUT/DELETE (Unraid webGUI enforcement)
- PDOException catch in FolderManager.php (codebase uses SQLite3, not PDO)

### Phase 2.5: Enhanced Container Cards & Settings - COMPLETE
Enriched container cards with detailed info and backend-persisted settings.

**Backend (PHP):**
- `DockerClient.php` — `formatContainer()` now returns `mounts`, `networkSettings` from Docker list API
- `api/settings.php` — new REST endpoint for plugin settings (GET all, POST upsert key/value)
- `DockerFoldersSettings.page` — functional settings page with "Distinguish health status" toggle, persisted to SQLite

**Frontend (Vue 3 + TypeScript):**
- `stores/docker.ts` — expanded `Container` interface with `ContainerPort`, `ContainerMount` types, `ports`, `mounts`, `networkSettings`, `created` fields
- `stores/settings.ts` — new Pinia store for backend-persisted settings, fetched on load
- `ContainerCard.vue` — major overhaul:
  - Status dot (green=healthy+running, blue=running, red=exited, gray=other) replaces text badge
  - Configurable via "Distinguish health status" setting (blue vs green for running)
  - Hover tooltips on status dots ("Running (healthy)", "Running (no health check)", etc.)
  - Clickable accordion body — click image/status row to expand details panel
  - Details panel: network name + IP, port mappings (up to 3), volume mounts (up to 2), status/uptime
  - Image name links to Docker Hub or custom registry (ghcr.io, etc.)
  - Chevron indicator with rotate animation on expand
  - Works in both grid and list views
- `App.vue` — provides `distinguishHealthy` setting via Vue provide/inject (no prop drilling)
- `dev/mock-api.ts` — all mock containers have realistic ports, mounts, networkSettings, created, managed, webui fields; new settings endpoint handler

### Phase 3: Real-Time Updates & Live Stats - IN PROGRESS

**Completed (WebSocket infrastructure):**
- `WebSocketPublisher.php` - static publisher, POSTs JSON events to nchan (fire-and-forget, 2s timeout)
- `containers.php` - publishes after start/stop/restart/remove actions
- `folders.php` - publishes after create/update/delete/add_container/remove_container/reorder/import
- `composables/useWebSocket.ts` - singleton WebSocket manager with exponential backoff reconnect (1s-30s), event dispatch to stores, 30s polling fallback
- `components/ConnectionStatus.vue` - colored dot indicator (green=Live, yellow=Connecting, gray=Offline, red=Error)

**In Progress (Live resource stats):**
- Backend: Docker `/containers/{id}/stats?stream=0` endpoint for one-shot stats
- Backend: New `api/stats.php` endpoint returning CPU%, Memory, I/O, Network, PIDs for all running containers
- Frontend: Stats store with periodic polling
- Frontend: Container accordion shows CPU/Memory progress bars, I/O/Network numbers, PIDs, restart count

### Phase 4: UI/UX Polish - NOT STARTED
- Dark/light theme support
- Responsive design (mobile, tablet)
- Accessibility (ARIA, keyboard navigation)
- Animations, loading skeletons, error states

### Phase 5: Testing & Release - NOT STARTED
- PHP unit tests, Vue component tests, integration tests
- Manual testing on Unraid
- Documentation, v1.0 release

---

## Architecture

```
src/frontend/                    # Vue 3 + TypeScript + Vite
  src/
    components/
      ConnectionStatus.vue       # WebSocket status indicator
      docker/ContainerCard.vue   # Container card with accordion details + stats
      folders/FolderContainer.vue
      folders/FolderHeader.vue
      folders/FolderEditModal.vue
    composables/
      useWebSocket.ts            # WebSocket manager (singleton)
    stores/
      docker.ts                  # Container state + actions
      folders.ts                 # Folder state + operations
      settings.ts                # Plugin settings (backend-persisted)
    types/
      folder.ts                  # Folder type definitions
      websocket.ts               # WebSocket event types
    utils/
      csrf.ts                    # CSRF token handling
    App.vue                      # Root component
  dev/
    mock-api.ts                  # Vite dev server mock API

src/backend/.../unraid-docker-folders-modern/
  api/
    containers.php               # Container CRUD + WebSocket publish
    folders.php                  # Folder CRUD + WebSocket publish
    settings.php                 # Plugin settings CRUD
  classes/
    Database.php                 # SQLite3 singleton wrapper
    DockerClient.php             # Docker socket client
    FolderManager.php            # Folder business logic
    WebSocketPublisher.php       # nchan publisher (fire-and-forget)
  include/
    config.php                   # Constants (paths, URLs)
    auth.php                     # CSRF + session validation
  migrations/                    # SQL migration files
  DockerFoldersMain.page         # Menu="Docker:3" - Folders tab
  DockerFoldersSettings.page     # Menu="Utilities" - Settings with health status toggle
```

---

## Next Steps

1. **Phase 3**: Implement live container resource stats (CPU, Memory, I/O, Network, PIDs)
2. **Build and install**: `./build/build.sh --release`, create GitHub release, install on Unraid
3. **On-device testing**: Verify all Phase 2-3 features work on real Unraid hardware

---

## Known Issues

### Resolved
- Page rendering blank (filename collision with built-in Docker.page)
- CSRF token missing (Unraid webGUI blocks POST without token)
- PDOException catch (codebase uses SQLite3 native, not PDO)
- XML parse errors in PLG (CDATA wrappers)
- SQLite driver unavailable (switched from PDO to SQLite3)

### Potential Issues (untested)
- nchan pub/sub channel may need explicit configuration on Unraid
- PHP `curl` extension availability on Unraid (needed by WebSocketPublisher)
- WebSocket connection URL may need adjustment depending on Unraid's nchan routing
- Stats endpoint performance with many containers (one Docker API call per running container)

---

## Build & Release

```bash
./build/build.sh --release    # Builds frontend, packages .txz, updates PLG, tags, pushes
```

After build: manually create GitHub release and upload `.txz` from `archive/`.
