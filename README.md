# Unraid Docker Folders Modern

A modern Unraid plugin that adds folder organization to the Docker tab with real-time updates and a clean Vue 3 interface. Replaces the outdated folderview2 plugin.

## Features

- **Folder Organization**: Group Docker containers into customizable folders with icons and colors
- **Real-Time Updates**: WebSocket integration via Unraid's nchan server - all open tabs update instantly
- **Drag & Drop**: Organize containers by dragging them between folders (SortableJS)
- **Container Actions**: Start, stop, restart, and remove containers directly from the folder view
- **Import/Export**: Backup and share folder configurations as JSON
- **Polling Fallback**: 30-second polling catches external changes (CLI, Portainer, etc.)
- **CSRF Integration**: Properly authenticated against Unraid's webGUI security

## Technology Stack

- **Frontend**: Vue 3 + TypeScript + Vite + Pinia
- **Backend**: PHP 8.0+ with SQLite3
- **Real-time**: nchan WebSocket pub/sub
- **Drag & Drop**: SortableJS

## Installation

### Manual Installation

1. Download the latest `.plg` file from [Releases](https://github.com/rizowski/unraid-docker-folders/releases)
2. Navigate to **Plugins** > **Install Plugin** in Unraid
3. Paste the URL to the `.plg` file and click **Install**
4. The "Folders" tab appears under **Docker** in the Unraid menu

### Build from Source

```bash
# Frontend build
cd src/frontend && npm ci && npm run build

# Release build (auto-increments version, tags, pushes)
./build/build.sh --release

# Output: archive/unraid-docker-folders-modern-<version>.txz
```

After release build, manually create a GitHub release and upload the `.txz` file.

## Roadmap

### Phase 1: Core Infrastructure - COMPLETE
- Docker container display, plugin installer, database setup, build system

### Phase 2: Folder Management - COMPLETE
- Folder CRUD, drag-and-drop, container assignment, import/export, menu integration

### Phase 3: Real-Time Updates - COMPLETE (code written, pending on-device testing)
- WebSocket publisher (nchan), frontend composable with reconnection, connection status indicator, polling fallback, CSRF token handling, container remove action

### Phase 4: UI/UX Polish (Planned)
- Dark/light theme, responsive design, animations, loading skeletons

### Phase 5: Testing & Release (Planned)
- Unit tests, integration tests, documentation, v1.0 release

### Future
- Container update detection, CPU/memory stats, port/volume display, search & filtering

## Support

- **Issues**: [GitHub Issues](https://github.com/rizowski/unraid-docker-folders/issues)
- **Forum**: [Unraid Community Forums](https://forums.unraid.net)

## License

MIT License - See [LICENSE](LICENSE) for details

## Credits

Developed by [rizowski](https://github.com/rizowski)

Inspired by [folderview2](https://github.com/VladoPortos/folder.view2) by VladoPortos
