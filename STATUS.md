# Unraid Docker Folders Modern - Project Status

**Last Updated**: 2026-02-15
**Current Phase**: Phase 3 complete (code written, pending on-device testing)

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
- Menu integration: "Folders" tab under Docker, settings page under Other Settings

**Resolved issues:**
- Page rendering blank (Docker.page filename collision - renamed to DockerFoldersMain.page)
- CSRF token missing on POST/PUT/DELETE (Unraid webGUI enforcement)
- PDOException catch in FolderManager.php (codebase uses SQLite3, not PDO)

### Phase 3: Real-Time WebSocket Updates - CODE COMPLETE
All code written and frontend builds cleanly. Pending installation and on-device testing.

**Backend (PHP):**
- `WebSocketPublisher.php` - static publisher, POSTs JSON events to nchan (fire-and-forget, 2s timeout)
- `containers.php` - publishes after start/stop/restart/remove actions
- `folders.php` - publishes after create/update/delete/add_container/remove_container/reorder/import

**Frontend (Vue 3 + TypeScript):**
- `types/websocket.ts` - WebSocketEvent and ConnectionStatus types
- `composables/useWebSocket.ts` - singleton WebSocket manager with exponential backoff reconnect (1s-30s), event dispatch to stores, 30s polling fallback
- `components/ConnectionStatus.vue` - colored dot indicator (green=Live, yellow=Connecting, gray=Offline, red=Error)
- `utils/csrf.ts` - reads CSRF token from iframe query parameter, `withCsrf()` helper for all mutation URLs
- `stores/docker.ts` - added `removeContainer` action, fetch debounce (500ms), CSRF on all POSTs
- `stores/folders.ts` - fetch debounce (500ms), CSRF on all POST/PUT/DELETE
- `components/docker/ContainerCard.vue` - added Remove button
- `components/folders/FolderContainer.vue` - added remove handler with confirmation
- `App.vue` - initializes WebSocket on mount, shows ConnectionStatus in header

**CSRF flow:**
- `DockerFoldersMain.page` passes `csrf_token` to iframe via query parameter
- Frontend reads token on init, appends to all state-changing API requests
- Unraid's webGUI validates token at the web server level

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
      docker/ContainerCard.vue   # Container card with actions
      folders/FolderContainer.vue
      folders/FolderHeader.vue
      folders/FolderEditModal.vue
    composables/
      useWebSocket.ts            # WebSocket manager (singleton)
    stores/
      docker.ts                  # Container state + actions
      folders.ts                 # Folder state + operations
    types/
      folder.ts                  # Folder type definitions
      websocket.ts               # WebSocket event types
    utils/
      csrf.ts                    # CSRF token handling
    App.vue                      # Root component

src/backend/.../unraid-docker-folders-modern/
  api/
    containers.php               # Container CRUD + WebSocket publish
    folders.php                  # Folder CRUD + WebSocket publish
  classes/
    Database.php                 # SQLite3 singleton wrapper
    DockerClient.php             # Docker socket client
    FolderManager.php            # Folder business logic
    WebSocketPublisher.php       # nchan publisher (fire-and-forget)
  include/
    config.php                   # Constants (paths, URLs)
    auth.php                     # CSRF + session validation
  migrations/                    # SQL migration files
  DockerFoldersMain.page         # Menu="Docker:0" - Folders tab
  DockerFoldersSettings.page     # Menu="OtherSettings" - Settings
```

---

## Next Steps

1. **Build and install**: `./build/build.sh --release`, create GitHub release, install on Unraid
2. **Verify CSRF fix**: Create a folder - should return 201 with folder data (no more empty response)
3. **Verify WebSocket**: Check browser DevTools for connection to `/sub/docker-modern`
4. **Test multi-tab**: Open Folders tab in two browser tabs, perform action in one, verify other updates
5. **Test container remove**: Click Remove button, confirm dialog, verify container removed
6. **Test polling fallback**: Start/stop container via Unraid's native Docker tab, verify Folders tab updates within 30s

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

---

## Build & Release

```bash
./build/build.sh --release    # Builds frontend, packages .txz, updates PLG, tags, pushes
```

After build: manually create GitHub release and upload `.txz` from `archive/`.
