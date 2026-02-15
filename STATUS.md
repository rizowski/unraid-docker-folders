# Unraid Docker Folders Modern - Project Status

**Last Updated**: 2026-02-15
**Current Version**: v2026.02.14-11
**Current Phase**: Phase 2 (Fix applied, awaiting rebuild)

---

## FIX APPLIED - Page Rendering Issue

**Root cause**: `Docker.page` filename collided with Unraid's built-in `Docker.page`. The built-in page uses `Type="xmenu"` to create the Docker menu parent; our file was overwriting it with `Type="php"`, breaking the entire Docker menu.

**Fix**: Renamed to `DockerFolders.page` with correct attributes (`Menu="Docker:3"`, `Tag="folder"`, `Cond=`). Settings.page updated to `Menu="OtherSettings"`.

**Status**: Awaiting rebuild and test on Unraid. See CURRENT_ISSUE.md for full details.

---

## Project Overview

Modern Unraid plugin to replace the outdated folderview2 plugin with:
- Vue 3 + TypeScript frontend
- Folder organization with drag-and-drop
- Real-time WebSocket updates
- SQLite database for persistence
- Modern, responsive UI

---

## 📊 Phase Status

### ✅ Phase 1: Core Infrastructure (COMPLETED)
**Status**: Complete and working

**Completed Tasks**:
- ✅ Repository structure created
- ✅ Frontend setup (Vue 3 + Vite + TypeScript)
- ✅ Backend setup (PHP classes, API endpoints)
- ✅ Database setup (SQLite with migrations)
- ✅ Build system (automated versioning, MD5 checksums, git tagging)
- ✅ PLG installer with pre-install cleanup, migrations, and uninstall hooks
- ✅ Docker API integration (`DockerClient.php`)
- ✅ Basic container listing API working

**Key Files**:
- `src/frontend/` - Vue 3 application with Vite build
- `src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/`
- `build/build.sh` - Automated build and release script
- `unraid-docker-folders-modern.plg` - Plugin installer

**Issues Resolved**:
- XML parse errors in PLG (fixed with CDATA wrappers)
- SQLite driver issues (switched from PDO to SQLite3)
- Icon display (changed to FontAwesome names)

---

### 🔄 Phase 2: Folder Management (IN PROGRESS - BLOCKED)
**Status**: Backend complete, frontend complete, but can't test due to page rendering issue

**Completed Backend**:
- ✅ `FolderManager.php` with full CRUD operations
- ✅ `api/folders.php` endpoint with all actions
- ✅ Database schema with folders, container_folders tables
- ✅ Import/export functionality
- ✅ Migration system working

**Completed Frontend**:
- ✅ Vue 3 components (FolderContainer, ContainerCard, etc.)
- ✅ Pinia stores (docker.ts, folders.ts)
- ✅ Drag-and-drop with SortableJS
- ✅ Folder creation/edit modals
- ✅ Container assignment UI
- ✅ Export/import UI

**Blocked Tasks**:
- ❌ **Cannot test any UI features** - .page files not rendering
- ❌ Integration testing blocked
- ❌ End-to-end workflow testing blocked

**What Works When Accessed Directly**:
- Direct URL `/plugins/unraid-docker-folders-modern/assets/index.html` shows the Vue app
- All frontend functionality appears to work in isolation
- API endpoints are implemented (untested)

**What Doesn't Work**:
- Menu integration: `/Docker/Folders` blank
- Settings page: `/Settings/Utilities/DockerFoldersModern` blank
- No .page content renders at all (even diagnostic HTML)

---

### ⏸️ Phase 3: Real-Time Updates (NOT STARTED)
**Status**: Planned, awaiting Phase 2 completion

**Planned Tasks**:
- [ ] WebSocket integration (nchan)
- [ ] Event hook scripts (docker_started, docker_stopped, etc.)
- [ ] `WebSocketPublisher.php` class
- [ ] Frontend `useWebSocket.ts` composable
- [ ] State synchronization
- [ ] Reconnection logic
- [ ] Connection status indicator

---

### ⏸️ Phase 4: UI/UX Polish (NOT STARTED)
**Status**: Planned

**Planned Tasks**:
- [ ] Dark/light theme support
- [ ] Responsive design (mobile, tablet)
- [ ] Accessibility (ARIA labels, keyboard navigation, screen reader support)
- [ ] Animations and transitions
- [ ] Loading states and skeletons
- [ ] Error states and empty states
- [ ] Settings page UI
- [ ] Performance optimization

---

### ⏸️ Phase 5: Testing & Release (NOT STARTED)
**Status**: Planned

**Planned Tasks**:
- [ ] PHP unit tests
- [ ] Vue component tests
- [ ] Integration tests
- [ ] Manual testing on Unraid
- [ ] Documentation (README, API docs, user guide)
- [ ] V1.0 release

---

## 🏗️ Technical Architecture

### Frontend Stack
- **Framework**: Vue 3 with Composition API
- **Language**: TypeScript
- **Build Tool**: Vite
- **State**: Pinia
- **Drag & Drop**: SortableJS
- **Build Output**: `src/backend/.../assets/`

### Backend Stack
- **Language**: PHP 8.0+
- **Database**: SQLite3 (not PDO)
- **Docker Integration**: Unix socket `/var/run/docker.sock`
- **Real-time**: nchan WebSocket (planned)

### Database Schema
```sql
-- Folders
folders (id, name, icon, color, position, collapsed, created_at, updated_at)

-- Container-folder associations
container_folders (id, container_id, container_name, folder_id, position)

-- Settings
settings (key, value, updated_at)

-- Container cache
container_cache (container_id, name, image, status, state, data, updated_at)

-- Migrations tracking
migrations (id, filename, executed_at)
```

### Build System
- Auto-incrementing build numbers
- Automated MD5 calculation
- Automated PLG file updates
- Automated git tagging and pushing
- GitHub release creation (manual currently, gh CLI not authenticated)

**Command**: `./build/build.sh --release`

---

## 📁 Project Structure

```
/Users/rizowski/git/personal/unraid-docker/
├── src/
│   ├── frontend/                    # Vue 3 application
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── docker/          # Container components
│   │   │   │   ├── folders/         # Folder components
│   │   │   │   └── layout/          # Layout components
│   │   │   ├── stores/              # Pinia stores
│   │   │   ├── composables/         # Vue composables
│   │   │   └── types/               # TypeScript types
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── backend/
│       └── usr/local/emhttp/plugins/unraid-docker-folders-modern/
│           ├── api/                 # API endpoints
│           │   ├── containers.php
│           │   ├── folders.php
│           │   └── settings.php
│           ├── classes/             # PHP classes
│           │   ├── Database.php
│           │   ├── DockerClient.php
│           │   ├── FolderManager.php
│           │   └── WebSocketPublisher.php (planned)
│           ├── include/
│           │   ├── config.php
│           │   └── auth.php
│           ├── migrations/
│           │   ├── 001_initial.sql
│           │   └── 002_add_folder_tables.sql
│           ├── scripts/
│           │   └── migrate.php
│           ├── pages/
│           │   ├── DockerFolders.page  # Menu="Docker:3" - Folders tab
│           │   └── Settings.page       # Menu="OtherSettings"
│           ├── events/              # (planned for Phase 3)
│           └── assets/              # Built frontend (from Vite)
│
├── build/
│   └── build.sh                     # Automated build script
├── archive/                         # Built .txz packages
├── unraid-docker-folders-modern.plg # Plugin installer
└── STATUS.md                        # This file
```

---

## .page File Configuration

### DockerFolders.page (Menu="Docker:3")
```
Menu="Docker:3"
Title="Folders"
Tag="folder"
Cond="is_file('/var/run/dockerd.pid')"
Markdown="false"
---
<!-- iframe embedding Vue app -->
```

### Settings.page (Menu="OtherSettings")
```
Menu="OtherSettings"
Title="Docker Folders Modern"
Icon="folder"
Tag="folder"
Markdown="false"
---
<!-- Settings/info page -->
```

---

## 🐛 Known Issues

### Critical Issues
1. **Page Rendering Blocked** - `.page` files don't render content
   - Suspect: Unraid doesn't support sub-routes under core menus
   - Need to test: Top-level menu or different integration approach

### Resolved Issues
- ✅ XML parse errors in PLG (CDATA wrappers)
- ✅ SQLite driver not available (switched to SQLite3)
- ✅ Missing Type attribute in .page files
- ✅ Icon display issues (FontAwesome names)

---

## 🔍 Investigation Needed

1. **How do other Unraid plugins add menu items?**
   - Look at successful plugins' .page files
   - Check if any use `Menu="Docker"` successfully
   - Document valid Menu values and behaviors

2. **Test top-level menu**
   - Try `Menu="DockerFolders"` instead of `Menu="Docker"`
   - See if custom top-level menu works

3. **Alternative integration approaches**
   - JavaScript injection into existing Docker page?
   - Complete Docker tab override?
   - Different menu structure?

4. **Check Unraid forums/documentation**
   - Plugin development guidelines
   - .page file format documentation
   - Community Applications requirements

---

## 🚀 Next Actions (When Resuming)

### Immediate Priority
1. **Research Unraid plugin menu integration**
   - Find working examples of plugin menu items
   - Understand Menu attribute constraints
   - Determine valid integration approach

2. **Test alternative menu structure**
   - Create top-level menu: `Menu="DockerFolders"`
   - OR try: `Menu="Main"` with custom title
   - Document what actually works

3. **Once pages render**
   - Test folder creation
   - Test drag-and-drop
   - Test container assignment
   - Complete Phase 2 testing checklist

### Future Phases (After Unblocking)
- Phase 3: WebSocket real-time updates
- Phase 4: UI/UX polish
- Phase 5: Testing and V1.0 release

---

## 📚 Resources

### Build and Release
```bash
# Development build (timestamped)
./build/build.sh

# Release build (dated, auto-incrementing)
./build/build.sh --release

# Creates package at:
archive/unraid-docker-folders-modern-<version>.txz
```

### Installation
```
Plugin installer URL:
https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg

Direct asset URL (works):
http://<unraid-ip>/plugins/unraid-docker-folders-modern/assets/index.html

Menu URLs (broken):
http://<unraid-ip>/Docker/Folders
http://<unraid-ip>/Settings/Utilities/DockerFoldersModern
```

### Git Repository
```
GitHub: https://github.com/rizowski/unraid-docker-folders
Current Branch: main
Latest Tag: v2026.02.14-11
```

---

## 💡 Notes for Future Development

### Menu Integration
- **Critical**: Determine correct Menu attribute usage
- User observation: Other plugins use top-level menus, not sub-menus
- May need to create custom menu instead of extending Docker

### Testing Strategy
- Phase 2 features are built but untested
- Once page rendering works, extensive testing needed
- Consider test Unraid VM for rapid iteration

### Performance Considerations
- Frontend bundle currently ~120KB (acceptable)
- Database queries need indexes (already defined in schema)
- Virtual scrolling if > 100 containers (planned for Phase 4)

### Security Considerations
- CSRF validation implemented but untested
- Session validation via Unraid's session system
- Input validation in place for folder names

---

## 🎯 Success Criteria

V1.0 is successful when:
- ✅ Installs cleanly via PLG
- ✅ Appears in Unraid menu system
- ✅ Displays list of Docker containers
- ✅ Allows folder creation with icons/colors
- ✅ Supports drag-and-drop organization
- ✅ Persists configuration across reboots
- ✅ Export/import functionality works
- ✅ Real-time container status updates (WebSocket)
- ✅ Modern, responsive UI
- ✅ No data loss on uninstall (backup created)

**Current Progress**: ~40% complete (Phase 1 done, Phase 2 built but untested)

---

**Status**: Project on hold until page rendering issue resolved. Core functionality is built and ready to test once integration issue is solved.
