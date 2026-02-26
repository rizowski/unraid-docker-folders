# Changelog

## 2026.02.25
### Changes
- Fix build script bugs and improve robustness
- Fix folder stats bars, add StatsBar tests, update project docs
- Extract reusable components, refactor backend config and stats
- Fix concurrent container action loading states, add dev/stable release channels
- Add logging to manual update checks, gitignore phpunit cache
- chore: update gitignore

## 2026.02.24
### Changes
- Add update check logging with viewer in settings
- Fix session check: csrf_token is runtime-only, not in session file
- Fix session validation for Unraid's custom session cookie
- Add Docker-based PHPUnit tests for auth layer
- Fix PUT/DELETE CSRF validation and folder collapse persistence
- Fix form controls using nonexistent --input-background variable
- Fix dropdown text color on dark themes in settings page
- Revamp settings page: dark theme, grouped sections, container exclude modal
- Fix auth: read Unraid's Flask session cookie instead of PHP session
- Fix iframe auth: add credentials to all fetch calls, aggregate changelog by date
- chore: update build script
- Harden API endpoints: enable auth, add input validation, fix injection patterns
- Add container update rework: cron scheduling, batch pulls, folder badges, exclude list

## 2026.02.23
### Changes
- Remove Plugin Information section from settings page
- Fix list view kebab menu clipped by overflow-hidden
- Unify KebabMenu component, fix responsive overflow, and add tests
- Add view mode slider toggle, folder menu padding, and update mock data
- Polish folder context menu padding and replace view toggle with icon slider
- Fix z-index, hover flicker, action spinner + add hide stopped toggle
- Fix drag-drop duplication, card padding, folder kebab menu, and z-index
- Pass Unraid CSS variables into iframe for dark theme support
- Load app in iframe to isolate from Unraid global CSS
- Add Markdown="false" to DockerFoldersMain.page to fix styles not loading

## 2026.02.15
### Changes
- Add container action feedback, image update checking, and pull with progress
- Add UI animations: folder collapse, modal transitions, state pulse, card fade-in
- Always show app on Folders tab regardless of replace setting
- Simplify inject page to only collapse native Docker section
- Wrap native Docker section in collapsed accordion instead of hiding
- remove changelog
- Fix Docker section replacement race condition with async rendering
- Include CHANGELOG.md in release commit
- Auto-generate CHANGELOG.md from git history during release builds
- Generate release notes from commits since last tag
- Update docs to reflect container search, live stats, and UI polish
- Make labels and volumes sections horizontally scrollable
- Add container search to filter by name or image
- Fix duplicate #app elements when replace_docker_section is enabled
- Stack health, command, and labels vertically in card view
- Add container details (command, health, labels) to expanded accordion
- Swap volume display order to source -> destination
- Add link icon next to image URLs and volume paths
- Redesign list view row layout
- Gray out folder count badge when no containers are running
- Fix folder associations lost when containers are recreated
- Make entire list row clickable to expand/collapse
- Fix stats, ports, image, and status hidden in iframe
- Hide drag handles when drag & drop is locked
- Update PLG changes section with latest changelog
- Move settings icon to far left of header
- Fix Create Folder button text hidden in iframe
- Fix header layout on desktop and reduce list view expanded margin
- Add collapsible unfoldered containers section
- Add mobile-responsive layout with sm breakpoints
- can't remember hahaa
- Improve dark theme text contrast, modal fixes, and nav layout
- Fix stats polling for faster load and persistent cache
- Add folder-level stats, globe WebUI icon, and text sizing fixes
- Add folder ports, WebUI icon, text sizing, and dark theme fixes
- Add changelog, improve Docker section takeover and settings page
- UI polish: confirm modals, folder UX, edit in kebab menu
- loading states and more details for settings
- various improvements
- add supporting links
- add linkable volumes
- fix spacing and alignment
- fix styling and stats not displaying. unraid is really mucking with styling.
- fix unraid styles taking over
- make composed folders easier to identify
- added better icon and updated plugin icon
- add settings to turn off live
- automatically group composed containers
- fix polling for stats
- more metric improvmenets and other little changes
- add container stats
- update current state
- chore: move to settings page
- add additional docker details and settings
- add edit buttons to containers
- change how drag and drop works, folders take icons from containers
- add list or card view and fix some other bugs
- add dev server and fix a couple bugs
- chore remove iframe
- fix crsf issue
- move to tailwind
- move away from modern naming
- fix sorting and craeting folders
- update text docs
- feat: phase 3 realtime pipeline
- chore: update icon
- fix: settings
- fix: pages
- Add CLAUDE.md for future Claude Code instances
- Add quick start guide for resuming development
- Add project status and current issue documentation

## 2026.02.14
### Changes
- Fix Docker.page to properly integrate with Unraid UI (no full HTML doc)
- Fix page headers: add Type attribute and use FontAwesome icons
- Change Docker menu title to just 'Folders' for clean URL
- Switch from PDO to SQLite3 for better Unraid compatibility
- Add automatic GitHub release creation to build script
- Fix XML parsing by wrapping INLINE scripts in CDATA sections
- Phase 2: Create folder Vue components
- Phase 2: Implement folder management frontend stores
- Phase 2: Implement folder management backend
- Fix package ownership and remove macOS metadata files
- version updatE
- Add timestamp-based versioning and Settings page
- Fix Vite base path for correct asset loading
- Rename plugin to unraid-docker-folders-modern and rebuild
- rename folder
- Update PLG file with build MD5 checksum
- Fix TypeScript and vue-tsc compatibility issues
- Add PLG installer file for Unraid plugin system
- Add build system for packaging plugin
- Implement database schema and migration system
- Implement backend PHP classes and API
- Set up frontend with Vue 3, TypeScript, and Vite
- Initial project structure for unraid-docker-modern plugin

