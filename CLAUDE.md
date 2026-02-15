# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Unraid Docker Folders Modern** - A modern Unraid plugin to replace the outdated folderview2 plugin with Vue 3 frontend, real-time WebSocket updates, and SQLite persistence. Allows organizing Docker containers into folders with drag-and-drop.

**Current Status**: Phases 1-3 code complete, pending on-device testing. See STATUS.md for details.

---

## Build Commands

### Frontend (Vue 3)
```bash
# Navigate to frontend directory
cd src/frontend

# Install dependencies
npm ci

# Development server (localhost:5173)
npm run dev

# Type check without building
npm run type-check

# Build for production (outputs to ../backend/.../assets/)
npm run build
```

### Backend + Package
```bash
# Development build (timestamped version)
./build/build.sh

# Release build (auto-increments, tags, pushes to git)
./build/build.sh --release
```

**What the release build does**:
1. Builds Vue frontend (`npm run build`)
2. Packages backend + assets into `.txz` archive
3. Calculates MD5 checksum
4. Updates `unraid-docker-folders-modern.plg` with version and MD5
5. Creates git commit and tag
6. Pushes to GitHub
7. Outputs package to `archive/` directory

**Output**: `archive/unraid-docker-folders-modern-<version>.txz`

**Important**: After release build, manually create GitHub release and upload the `.txz` file (gh CLI not authenticated).

---

## Architecture

### Dual Codebase Structure

This is a **split frontend/backend architecture** with an unusual build output location:

```
src/frontend/              # Vue 3 application
  ├── src/
  │   ├── components/      # Vue components (ConnectionStatus, ContainerCard, Folder*)
  │   ├── composables/     # useWebSocket.ts
  │   ├── stores/          # Pinia state management (docker.ts, folders.ts)
  │   ├── types/           # TypeScript definitions (folder.ts, websocket.ts)
  │   └── utils/           # csrf.ts
  └── vite.config.ts       # Build output: ../backend/.../assets/

src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/
  ├── api/                 # PHP REST endpoints (containers.php, folders.php)
  ├── classes/             # PHP business logic (Database, DockerClient, FolderManager, WebSocketPublisher)
  ├── include/             # config.php, auth.php
  ├── migrations/          # SQL migration files
  ├── DockerFoldersMain.page      # Menu="Docker:0" - Folders tab
  ├── DockerFoldersSettings.page  # Menu="OtherSettings" - Settings
  └── assets/              # ← Frontend build output goes here
```

**Critical**: Frontend build outputs to `../backend/.../assets/` so that the `.txz` package includes compiled frontend assets.

### Database Architecture

Uses **SQLite3 native extension** (NOT PDO) because Unraid PHP lacks PDO SQLite driver.

**Key class**: `src/backend/.../classes/Database.php`
- Singleton pattern
- WAL mode for concurrency
- Migration tracking table

**Migrations**: Run automatically on plugin install via `scripts/migrate.php`

**Schema** (see `migrations/` folder):
- `folders` - Folder definitions (name, icon, color, position)
- `container_folders` - Container-to-folder associations
- `container_cache` - Cached Docker container data
- `settings` - Key-value plugin settings
- `migrations` - Tracks executed migrations

### Unraid Plugin Integration

**Page files** are how plugins add UI to Unraid's menu system. Key rules:

1. **NEVER name a .page file the same as a built-in page** (Docker.page, VMs.page, Main.page, Settings.page, etc.) - filenames are used as unique keys in the `$site` array by `PageBuilder.php`
2. Use `Tag=` for tab icons (not `Icon=`). `Icon=` is only for Settings panel pages
3. Use `Menu="Docker:N"` with a rank number to add tabs under Docker
4. Add `Cond="is_file('/var/run/dockerd.pid')"` so tabs only show when Docker is running

**Current configuration**:

`DockerFolders.page` - Adds "Folders" tab under Docker menu:
```
Menu="Docker:3"
Title="Folders"
Tag="folder"
Cond="is_file('/var/run/dockerd.pid')"
Markdown="false"
```

`Settings.page` - Adds settings page under Settings > Other:
```
Menu="OtherSettings"
Title="Docker Folders Modern"
Icon="folder"
Tag="folder"
Markdown="false"
```

**Valid Menu values**: `Tasks`, `Docker`, `VMs`, `Settings`, `OtherSettings`, `Utilities`, `UserPreferences`

**Page file format** (INI header parsed by `parse_ini_string()`):
```
Key="Value"
---
<?php // PHP code ?>
<!-- HTML content (fragment, not full document) -->
```

### Build System Details

**Auto-versioning**: `YYYY.MM.DD-N` format where N auto-increments for multiple builds per day.

**PLG file structure**:
- XML format with `<!ENTITY>` declarations for version and MD5
- Bash scripts wrapped in `<![CDATA[...]]>` to avoid XML parse errors
- Pre-install cleanup, migration runner, uninstall backup hooks

**Key files modified by build**:
- `unraid-docker-folders-modern.plg` - Version and MD5 updated
- Git tags created and pushed
- Package created in `archive/`

---

## Docker Integration

**Socket access**: `/var/run/docker.sock` via `DockerClient.php`

**API version**: v1.41 (configurable in `config.php`)

**Key operations**:
- List containers: `GET /containers.php`
- Start/stop/restart: `POST /containers.php?action=<action>&id=<id>`

**Container data flow**:
1. `DockerClient.php` queries Docker socket
2. Results cached in `container_cache` table
3. Frontend fetches via REST API
4. (Planned) WebSocket updates on container state changes

---

## State Management

**Frontend**: Pinia stores in `src/frontend/src/stores/`

**Key stores**:
- `docker.ts` - Container list, status, actions (start/stop/restart)
- `folders.ts` - Folder CRUD, container assignments, drag-drop reordering

**State persistence**: Folders/assignments stored in SQLite, NOT localStorage

**Backend session**: Validates via Unraid's `$_SESSION['csrf_token']` (see `include/auth.php`)

---

## Known Issues & Gotchas

### Resolved Issues
- ✅ Page rendering blank (Docker.page filename collision with built-in - renamed to DockerFolders.page)
- ✅ XML parse errors in PLG (fixed with CDATA)
- ✅ SQLite driver unavailable (switched from PDO to SQLite3 native)
- ✅ Icon display (use FontAwesome names, not file paths)

### Development Constraints
- **No PDO**: Use `SQLite3` class directly
- **No full HTML docs in .page files**: Output content fragments only
- **Vite base path**: Must be `/plugins/unraid-docker-folders-modern/assets/` for Unraid integration
- **File permissions**: .page files = 644, scripts = 755, handled by build script

---

## Real-Time Updates (Phase 3 - Implemented)

**Architecture** (code complete, pending on-device testing):
1. PHP API endpoints publish events to nchan after each successful mutation
2. `WebSocketPublisher.php` POSTs JSON to `NCHAN_PUB_URL` (fire-and-forget, 2s timeout)
3. Frontend connects to `ws://<host>/sub/docker-modern` via `useWebSocket.ts` composable
4. On event received, stores call `fetchContainers()` or `fetchFolders()` (full refetch, not patching)
5. Exponential backoff reconnection (1s base, 30s max)
6. 30s polling fallback catches external changes (CLI, Portainer, etc.)
7. Fetch debounce (500ms) prevents redundant calls when UI action already refreshed
8. `ConnectionStatus.vue` shows live/connecting/offline/error state in header

**CSRF flow**: `.page` file passes token to iframe via query param, `utils/csrf.ts` reads it, `withCsrf()` appends to all POST/PUT/DELETE URLs.

**nchan integration**: Unraid has built-in nchan server for pub/sub.

---

## Testing Strategy

### Current State
- Phase 1: ✅ Build system, database, API endpoints working
- Phase 2: ⚠️ Code complete but untested (blocked on menu integration)
- Phases 3-5: Not started

### When Unblocked
1. Test folder CRUD operations
2. Test drag-and-drop with SortableJS
3. Test import/export functionality
4. Test container assignment to folders
5. Verify persistence across reboots

**No unit tests yet** - Planned for Phase 5.

---

## File Location Conventions

### Configuration
- **Plugin config**: `src/backend/.../include/config.php`
- **Persistent data**: `/boot/config/plugins/unraid-docker-folders-modern/`
- **Database**: `/boot/config/plugins/unraid-docker-folders-modern/data.db`
- **Backups**: `/boot/config/plugins/unraid-docker-folders-modern/backups/`

### Installation Paths (on Unraid)
- **Plugin directory**: `/usr/local/emhttp/plugins/unraid-docker-folders-modern/`
- **Assets**: `/usr/local/emhttp/plugins/unraid-docker-folders-modern/assets/`
- **Package log**: `/boot/config/plugins/unraid-docker-folders-modern/install.log`

---

## Important Development Notes

### When Modifying Frontend
- Run `npm run build` in `src/frontend/`
- Or use full release build: `./build/build.sh --release`
- Assets automatically copied to backend during build

### When Modifying Backend PHP
- Changes go in `src/backend/usr/local/emhttp/plugins/...`
- Run `./build/build.sh --release` to package
- Install on Unraid to test

### When Modifying Database Schema
1. Create new migration file in `migrations/` (e.g., `003_add_new_table.sql`)
2. Migrations run automatically on plugin install/upgrade
3. Migration tracking in `migrations` table prevents re-execution

### When Modifying .page Files
- Header is INI format parsed by `parse_ini_string()` - must have `Key="Value"` pairs
- Content after `---` separator is HTML fragment (not full document)
- PHP code allowed before HTML
- **NEVER reuse a built-in page filename** (Docker.page, VMs.page, etc.)
- Use `Tag=` for tab icons, `Icon=` for Settings panel icons
- For fast debugging: SSH to Unraid, edit files in-place at `/usr/local/emhttp/plugins/...`, refresh browser

---

## Quick Reference

### Useful URLs (on Unraid)
- Direct app: `http://<unraid>/plugins/unraid-docker-folders-modern/assets/index.html`
- Docker Folders tab: `http://<unraid>/Docker/DockerFolders` (tab under Docker menu)
- Settings: `http://<unraid>/Settings/DockerFoldersModern` (under Other Settings)

### Key Constants (config.php)
- `PLUGIN_NAME`: `unraid-docker-folders-modern`
- `DB_PATH`: `/boot/config/plugins/unraid-docker-folders-modern/data.db`
- `DOCKER_SOCKET`: `/var/run/docker.sock`
- `NCHAN_PUB_URL`: `http://localhost:4433/pub/docker-modern`

### API Endpoints
- `GET /api/containers.php` - List containers
- `POST /api/containers.php?action=start&id=<id>` - Start container
- `GET /api/folders.php` - List folders
- `POST /api/folders.php` - Create folder (body: `{name, icon, color}`)
- `PUT /api/folders.php?id=<id>` - Update folder
- `DELETE /api/folders.php?id=<id>` - Delete folder

---

## Next Steps for Development

**Immediate priority**: Build, install, and verify Phase 2-3 features on Unraid
1. Run `./build/build.sh --release`
2. Create GitHub release, upload .txz
3. Install on Unraid and verify:
   - Folders tab appears under Docker
   - CSRF fix works (create/edit/delete folder)
   - WebSocket connects to `/sub/docker-modern`
   - Multi-tab sync works
   - Container remove action works

**After verifying**: Proceed to Phase 4 (UI/UX polish).

**See**: STATUS.md for complete phase breakdown, CURRENT_ISSUE.md for CSRF fix details.
