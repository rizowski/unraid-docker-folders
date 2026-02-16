# Changelog

## 2026.02.15

### Added
- Auto-group Docker Compose stacks into folders
- Replace Docker Containers section setting (fully takes over the Docker tab content)
- Styled confirmation modals for stop/restart/remove actions
- Container edit, WebUI, Console, Logs, Project, Support in kebab menu
- Restart count badge on collapsed containers
- Stats loading skeleton while polling
- Folder click-to-expand/collapse
- Running/total count in folder badge
- Settings button in nav bar
- Volume paths link to Unraid file browser
- Changelog displayed on settings page

### Changed
- Docker section inject replaces content entirely instead of hiding alongside
- Flat nav button style (removed gradients)
- Folder edit/delete icons use consistent SVG style
- Tighter folder row spacing
- Consistent icon sizing in list view action buttons
- Dark theme hover states use color-mix for better contrast
- Settings "Open Docker Folders" links to /Docker
- Removed redundant access info section from settings

### Fixed
- Stats bars hidden in iframe due to responsive breakpoints
- Container image and status text hidden on narrow viewports
- Show stats enabled by default
- Empty section left behind when replacing Docker Containers content
