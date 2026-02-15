# Quick Start - Resuming Development

**Last Session**: 2026-02-15
**Status**: Phase 3 code complete, pending on-device testing

---

## TL;DR

- Phases 1-3 code is complete and builds cleanly
- CSRF token fix applied (was causing all POST/PUT/DELETE to fail)
- WebSocket real-time updates implemented (nchan pub/sub)
- Container remove action added to UI
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

## What Needs Testing

- CSRF token flow end-to-end (create/edit/delete folder)
- WebSocket connection to nchan (`/sub/docker-modern`)
- Multi-tab synchronization via WebSocket events
- Container remove from UI
- Polling fallback (change via native Docker tab, verify Folders updates)
- nchan channel availability (may need Unraid-side configuration)

---

## Key Files Changed (Phase 3)

### Backend
| File | Change |
|------|--------|
| `classes/WebSocketPublisher.php` | NEW - nchan publisher |
| `classes/FolderManager.php` | FIX - PDOException -> Exception |
| `api/containers.php` | ADD - publish calls after actions |
| `api/folders.php` | ADD - publish calls after mutations |
| `DockerFoldersMain.page` | FIX - passes CSRF token to iframe |

### Frontend
| File | Change |
|------|--------|
| `utils/csrf.ts` | NEW - CSRF token utility |
| `types/websocket.ts` | NEW - WebSocket event types |
| `composables/useWebSocket.ts` | NEW - WebSocket manager |
| `components/ConnectionStatus.vue` | NEW - status indicator |
| `stores/docker.ts` | ADD - removeContainer, debounce, CSRF |
| `stores/folders.ts` | ADD - debounce, CSRF |
| `components/docker/ContainerCard.vue` | ADD - Remove button |
| `components/folders/FolderContainer.vue` | ADD - remove handler |
| `App.vue` | ADD - WebSocket init, status indicator, remove handler |

---

## Documentation

- **CLAUDE.md** - Complete development reference (architecture, build, conventions)
- **STATUS.md** - Phase-by-phase project status
- **CURRENT_ISSUE.md** - Current issue details (CSRF fix)
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
