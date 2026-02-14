# Unraid Docker Modern

A modern Unraid plugin that redesigns the Docker tab with real-time updates, improved organization, and a clean interface.

## Features

- **Folder Organization**: Organize your Docker containers into customizable folders
- **Real-Time Updates**: See container status changes instantly via WebSocket (no page reloads!)
- **Modern UI**: Clean, responsive interface built with Vue 3
- **Drag & Drop**: Easily organize containers by dragging them into folders
- **Import/Export**: Backup and share your folder configurations
- **Better Performance**: SQLite database for fast queries and reliable data storage

## Why This Plugin?

This plugin is a modern replacement for the outdated folderview2 plugin, addressing key pain points:

- ✅ **Real-time updates** instead of page reloads
- ✅ **Modern UI/UX** with smooth animations and responsive design
- ✅ **Reliable data storage** using SQLite instead of flat JSON files
- ✅ **Better organization** with upcoming search, filtering, and bulk operations

## Technology Stack

- **Frontend**: Vue 3 + TypeScript + Vite
- **Backend**: PHP 8.0+
- **Database**: SQLite
- **Real-time**: nchan WebSocket
- **State Management**: Pinia

## Installation

### Via Community Applications (Recommended)
*Coming soon - Plugin will be available in Community Applications after v1.0 release*

### Manual Installation

1. Download the latest `.plg` file from [Releases](https://github.com/rizowski/unraid-docker/releases)
2. Install via Unraid's plugin installer:
   - Navigate to **Plugins** → **Install Plugin**
   - Paste the URL to the `.plg` file
   - Click **Install**

## Development

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup instructions and contribution guidelines.

## Documentation

- [User Guide](docs/USER_GUIDE.md) - How to use the plugin
- [API Documentation](docs/API.md) - API endpoints reference
- [Migration Guide](docs/MIGRATION.md) - Migrating from folderview2

## Roadmap

### Phase 1: Core Infrastructure ✅ (In Progress)
- Basic Docker container display
- Plugin installer
- Database setup

### Phase 2: Folder Management (Planned)
- Create, edit, delete folders
- Drag & drop organization
- Import/export configurations

### Phase 3: Real-Time Updates (Planned)
- WebSocket integration
- Live container status updates
- Multi-tab synchronization

### Phase 4: UI/UX Polish (Planned)
- Modern, accessible design
- Dark/light theme support
- Mobile responsive layout

### Phase 5: Testing & Release (Planned)
- Comprehensive testing
- Performance optimization
- v1.0 release

### Future Features
- Advanced filtering & search
- Container statistics & insights
- Bulk operations

## Support

- **Issues**: [GitHub Issues](https://github.com/rizowski/unraid-docker/issues)
- **Forum**: [Unraid Community Forums](https://forums.unraid.net)

## License

MIT License - See [LICENSE](LICENSE) for details

## Credits

Developed by [rizowski](https://github.com/rizowski)

Inspired by and improving upon [folderview2](https://github.com/VladoPortos/folder.view2) by VladoPortos

## Contributing

Contributions are welcome! Please see [DEVELOPMENT.md](docs/DEVELOPMENT.md) for guidelines.

---

**Note**: This plugin is currently in active development. Phase 1 is in progress.
