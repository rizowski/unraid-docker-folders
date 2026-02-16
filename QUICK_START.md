# Quick Start - Resuming Development

**Last Session**: 2026-02-15
**Status**: Phases 1-3 complete, pending on-device testing

---

## TL;DR

- Phases 1-3 code is complete and builds cleanly
- Live resource stats (CPU, memory, I/O, network, PIDs, restart count, uptime, image/log size)
- Container search filters by name/image with folder auto-expand
- WebSocket real-time updates implemented (nchan pub/sub)
- Labels and volumes are horizontally scrollable instead of truncated
- **Next**: Build, install on Unraid, verify everything works

---

## Immediate Next Steps

```bash
# 1. Build release
./build/build.sh --release

# 2. Create GitHub release, upload .txz from archive/

# 3. Install on Unraid and test:
#    - Create a folder (verifies CSRF fix)
#    - Start/stop a container
#    - Check for WebSocket connection in browser DevTools
#    - Open two tabs, action in one should update the other
#    - Search for a container by name or image
#    - Verify live stats appear in expanded container cards
```

---

## What's Working

- Vue 3 frontend builds and type-checks cleanly
- "Folders" tab under Docker menu (DockerFoldersMain.page)
- Settings page under Other Settings
- Container listing via Docker socket API
- Folder CRUD with SQLite persistence
- Drag-and-drop container organization
- Import/export folder configurations
- CSRF token passed from .page to iframe to all API requests
- WebSocket publisher (PHP) and subscriber (Vue composable)
- Connection status indicator in UI header
- Container remove action with confirmation dialog
- Fetch debounce (500ms) to prevent redundant API calls
- 30s polling fallback for external changes
- Live resource stats (CPU, memory bars + numeric stats)
- Container search with folder filtering and auto-expand
- Horizontally scrollable labels and volumes

## What Needs Testing

- CSRF token flow end-to-end (create/edit/delete folder)
- WebSocket connection to nchan (`/sub/docker-modern`)
- Multi-tab synchronization via WebSocket events
- Container remove from UI
- Polling fallback (change via native Docker tab, verify Folders updates)
- nchan channel availability (may need Unraid-side configuration)
- Stats polling performance with many running containers
- Search filtering with large container lists

---

## Documentation

- **CLAUDE.md** - Complete development reference (architecture, build, conventions)
- **STATUS.md** - Phase-by-phase project status
- **CURRENT_ISSUE.md** - Current work and recently completed items
- **QUICK_START.md** - This file

---

## Helpful Commands

```bash
# Build release
./build/build.sh --release

# Frontend only (type-check + build)
cd src/frontend && npm run build

# Type-check only
cd src/frontend && npm run type-check

# Dev server (localhost:5173)
cd src/frontend && npm run dev

# Check version in PLG
grep "<!ENTITY version" unraid-docker-folders-modern.plg
```
