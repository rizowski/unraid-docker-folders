# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Unraid Docker Folders Modern** - A modern Unraid plugin to replace the outdated folderview2 plugin with Vue 3 frontend, real-time WebSocket updates, and SQLite persistence. Allows organizing Docker containers into folders with drag-and-drop.

**Current Status**: Phase 1 complete, Phase 2 blocked on menu integration issue (see CURRENT_ISSUE.md)

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
  │   ├── components/
  │   ├── stores/          # Pinia state management
  │   └── types/           # TypeScript definitions
  └── vite.config.ts       # Build output: ../backend/.../assets/

src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/
  ├── api/                 # PHP REST endpoints
  ├── classes/             # PHP business logic (Database, DockerClient, FolderManager)
  ├── include/             # config.php, auth.php
  ├── migrations/          # SQL migration files
  ├── pages/               # Unraid .page files (⚠️ currently broken)
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

**⚠️ CRITICAL BLOCKER**: `.page` files currently don't render (blank pages).

**Hypothesis**: Unraid doesn't support sub-menu items under core menus like `Menu="Docker"`. Other plugins use top-level menus.

**Current (broken) approach**:
```
Menu="Docker"      # Trying to add sub-item under Docker menu
Title="Folders"
```

**Likely fix needed**:
```
Menu="DockerFolders"   # Top-level menu instead
Title="Docker Folders"
```

**What works**: Direct URL `/plugins/unraid-docker-folders-modern/assets/index.html` loads Vue app successfully.

**Page file format**:
```
Menu="<MenuName>"
Title="<Page Title>"
Icon="<FontAwesome icon name>"
Type="php"
---
<?php
// PHP code
?>
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

### Critical Blocker
**.page files don't render** - See CURRENT_ISSUE.md for full analysis. Frontend code is complete but untestable via Unraid menu system.

### Resolved Issues
- ✅ XML parse errors in PLG (fixed with CDATA)
- ✅ SQLite driver unavailable (switched from PDO to SQLite3 native)
- ✅ Icon display (use FontAwesome names, not file paths)

### Development Constraints
- **No PDO**: Use `SQLite3` class directly
- **No full HTML docs in .page files**: Output content fragments only
- **Vite base path**: Must be `/plugins/unraid-docker-folders-modern/assets/` for Unraid integration
- **File permissions**: .page files = 644, scripts = 755, handled by build script

---

## Real-Time Updates (Phase 3 - Planned)

**Architecture** (not yet implemented):
1. Unraid Docker events trigger hooks in `events/` directory
2. Event scripts call `api/events.php`
3. PHP publishes to nchan WebSocket (`http://localhost:4433/pub/docker-modern`)
4. Frontend subscribes to `/sub/docker-modern`
5. Vue composable `useWebSocket.ts` updates Pinia stores
6. UI updates reactively

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
- Must include header with Menu, Title, Icon, Type
- Content after `---` separator is HTML fragment (not full document)
- PHP code allowed before HTML
- ⚠️ Currently broken - see CURRENT_ISSUE.md for investigation steps

---

## Quick Reference

### Useful URLs (on Unraid)
- Direct app: `http://<unraid>/plugins/unraid-docker-folders-modern/assets/index.html` ✅ Works
- Docker menu: `http://<unraid>/Docker/Folders` ❌ Broken (blank)
- Settings: `http://<unraid>/Settings/Utilities/DockerFoldersModern` ❌ Broken (blank)

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

**Immediate priority**: Resolve .page file rendering issue
1. Research other Unraid plugins' .page file structure
2. Test `Menu="DockerFolders"` (top-level) instead of `Menu="Docker"`
3. Document working approach
4. Unblock Phase 2 testing

**After unblocking**: Complete Phase 2 testing, then proceed to Phase 3 (WebSocket real-time updates).

**See**: STATUS.md for complete phase breakdown and CURRENT_ISSUE.md for detailed blocker analysis.
