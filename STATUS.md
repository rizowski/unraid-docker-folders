# Unraid Docker Folders Modern - Project Status

**Last Updated**: 2026-02-25
**Current Phase**: Phase 4 in progress (UI polish, component refactoring, testing)
**Branch**: `dev` (active development), `main` (stable releases)

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

### Phase 2.5: Enhanced Container Cards & Settings - COMPLETE
- Enriched container cards with ports, mounts, network info, health status
- Backend-persisted settings via SQLite
- Status dot colors (green=healthy, blue=running, red=exited, gray=other)
- Clickable accordion with detailed info panel

### Phase 3: Real-Time Updates & Live Stats - COMPLETE
- WebSocket via nchan pub/sub with exponential backoff reconnect
- Live resource stats (CPU, memory, I/O, network, PIDs, restarts, uptime)
- Visibility-based polling (only fetches stats for visible containers)
- Container search filtering by name/image
- Connection status indicator

### Phase 4: UI/UX Polish & Testing - IN PROGRESS
- Extracted reusable components: ChevronIcon, DragHandle, ImageLink, StatsBar
- useContainerStats composable for stats lifecycle management
- Fixed concurrent action loading states (multiple containers at once)
- Dev/stable release channels with branch-based auto-detection
- Frontend test suite: 69 tests across 5 test files

### Phase 5: Release - NOT STARTED
- Final on-device testing
- Documentation
- v1.0 stable release

---

## Architecture

```
src/frontend/                    # Vue 3 + TypeScript + Vite
  src/
    components/
      common/                    # Reusable UI components
        ChevronIcon.vue          # Expandable chevron with rotation
        DragHandle.vue           # Drag grip icon
        ImageLink.vue            # Docker image name with registry link
        StatsBar.vue             # CPU/MEM progress bar (compact/inline/wide)
      docker/ContainerCard.vue   # Container card with accordion details + stats
      folders/FolderContainer.vue
      folders/FolderHeader.vue
      folders/FolderEditModal.vue
      ConnectionStatus.vue       # WebSocket status indicator
      KebabMenu.vue              # Dropdown action menu
      ConfirmModal.vue           # Confirmation dialog
    composables/
      useWebSocket.ts            # WebSocket manager (singleton)
      useContainerStats.ts       # Stats polling lifecycle
    stores/
      docker.ts                  # Container state + actions + search
      folders.ts                 # Folder state + operations
      settings.ts                # Plugin settings (backend-persisted)
      stats.ts                   # Live resource stats polling
    types/
      folder.ts                  # Folder type definitions
      websocket.ts               # WebSocket event types
    utils/
      csrf.ts                    # CSRF token handling
      format.ts                  # Formatting helpers (bytes, percent, uptime)
    App.vue                      # Root component
  dev/
    mock-api.ts                  # Vite dev server mock API

src/backend/.../unraid-docker-folders-modern/
  api/
    containers.php               # Container CRUD + WebSocket publish
    folders.php                  # Folder CRUD + WebSocket publish
    settings.php                 # Plugin settings CRUD
    stats.php                    # Live container resource stats
    updates.php                  # Image update checking
  classes/
    Database.php                 # SQLite3 singleton wrapper
    DockerClient.php             # Docker socket client
    FolderManager.php            # Folder business logic
    WebSocketPublisher.php       # nchan publisher (fire-and-forget)
  include/
    config.php                   # Constants, helpers, logging
    auth.php                     # CSRF + session validation
  migrations/                    # SQL migration files
  scripts/
    check-updates.php            # Background update checker
```

---

## Build & Release

```bash
# Dev builds (on dev branch):
./build/build.sh --release    # Creates YYYY.MM.DD-devN pre-release

# Stable builds (on main branch):
git checkout main && git merge dev
./build/build.sh --release    # Creates YYYY.MM.DD stable release
```

Install URLs:
- **Stable**: `https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg`
- **Dev**: `https://raw.githubusercontent.com/rizowski/unraid-docker-folders/dev/unraid-docker-folders-modern.plg`
