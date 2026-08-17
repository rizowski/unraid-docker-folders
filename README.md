# Unraid Docker Folders

An Unraid plugin that adds folder organization to the Docker tab with real-time updates and a clean Vue 3 interface.

## Features

### Organization
- **Folders**: Group Docker containers into customizable folders with icons and colors
- **Drag & Drop**: Organize containers by dragging them between folders (SortableJS)
- **Compose Stack Grouping**: Auto-group containers belonging to the same Docker Compose project
- **Grid and List Views**: Switch between layout modes
- **Container Search**: Filter by name or image in real-time; folders auto-expand to show matches
- **Import/Export**: Back up and share folder configurations as JSON

### Container Management
- **Container Actions**: Start, stop, restart, and remove containers directly from the folder view
- **Image Updates**: Check for available image updates, review release notes, and pull one or many containers at once
- **Compose Management**: Edit and apply Docker Compose files from the UI, with version history
- **Schedules**: Run container actions on a cron schedule
- **Backups**: Automatic backups of folder and plugin configuration

### Live Data
- **Live Resource Stats**: CPU, memory, I/O, network, PIDs, restart count, uptime, image/log size for running containers
- **Container Logs**: Stream logs from an expanded container card
- **Real-Time Updates**: WebSocket integration via Unraid's nchan server — all open tabs update instantly
- **Polling Fallback**: 30-second polling catches external changes (CLI, Portainer, etc.)
- **CSRF Integration**: Properly authenticated against Unraid's webGUI security

## Technology Stack

- **Frontend**: Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS 4
- **Backend**: PHP 8.0+ with SQLite3
- **Real-time**: nchan WebSocket pub/sub
- **Drag & Drop**: SortableJS

## Installation

### Community Applications

Search for **Docker Folders** in the **Apps** tab.

### Install by URL

1. Navigate to **Plugins** > **Install Plugin** in Unraid
2. Paste the following URL and click **Install**:
   ```
   https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg
   ```
3. The "Folders" tab appears under **Docker** in the Unraid menu

Past versions are available on the [Releases](https://github.com/rizowski/unraid-docker-folders/releases) page.

### Build from Source

```bash
# Frontend build
cd src/frontend && yarn install --frozen-lockfile && yarn build

# Package the plugin (development build)
./build/build.sh

# Output: archive/unraid-docker-folders-modern-<version>.txz
```

Releases are cut automatically by GitHub Actions on push to `main` (stable) or
`dev` (prerelease). The workflow runs `./build/build.sh --release`, which builds
the frontend, packages the `.txz`, updates the `.plg`, tags the commit, and
publishes the GitHub release.

## Support

- **Issues and bug reports**: [GitHub Issues](https://github.com/rizowski/unraid-docker-folders/issues)

## License

MIT License — see [LICENSE](https://github.com/rizowski/unraid-docker-folders/blob/main/LICENSE) for details.

This project bundles [CodeMirror 5](https://codemirror.net/5/) (MIT), used for
Compose file editing.

## Credits

Developed by [rizowski](https://github.com/rizowski)

Inspired by [folderview2](https://github.com/VladoPortos/folder.view2) by VladoPortos
