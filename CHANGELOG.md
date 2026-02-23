# Changelog

## 2026.02.23
### Changes
- Add Markdown="false" to DockerFoldersMain.page to fix styles not loading

## 2026.02.15-42
### Changes
- Add container action feedback, image update checking, and pull with progress
- Add UI animations: folder collapse, modal transitions, state pulse, card fade-in

## 2026.02.15-41
### Changes
- Always show app on Folders tab regardless of replace setting

## 2026.02.15-40
### Changes
- Simplify inject page to only collapse native Docker section

## 2026.02.15-39
### Changes
- Wrap native Docker section in collapsed accordion instead of hiding

## 2026.02.15-38
### Changes
- remove changelog
- Fix Docker section replacement race condition with async rendering
- Include CHANGELOG.md in release commit

## 2026.02.15-37
### Changes
- Auto-generate CHANGELOG.md from git history during release builds
- Generate release notes from commits since last tag
- Update docs to reflect container search, live stats, and UI polish
- Make labels and volumes sections horizontally scrollable
- Add container search to filter by name or image
- Fix duplicate #app elements when replace_docker_section is enabled
- Stack health, command, and labels vertically in card view

## 2026.02.15-36
### Changes
- Add container details (command, health, labels) to expanded accordion
- Swap volume display order to source -> destination
- Add link icon next to image URLs and volume paths
- Redesign list view row layout
- Gray out folder count badge when no containers are running
- Fix folder associations lost when containers are recreated
- Make entire list row clickable to expand/collapse

## 2026.02.15-35
### Changes
- Fix stats, ports, image, and status hidden in iframe

## 2026.02.15-34
### Changes
- Hide drag handles when drag & drop is locked
- Update PLG changes section with latest changelog
- Move settings icon to far left of header

## 2026.02.15-33
### Changes
- Fix Create Folder button text hidden in iframe

## 2026.02.15-32
### Changes
- Fix header layout on desktop and reduce list view expanded margin

## 2026.02.15-31
### Changes
- Add collapsible unfoldered containers section
- Add mobile-responsive layout with sm breakpoints
- can't remember hahaa

## 2026.02.15-30
### Changes
- Improve dark theme text contrast, modal fixes, and nav layout

## 2026.02.15-29
### Changes
- Fix stats polling for faster load and persistent cache

## 2026.02.15-28
### Changes
- Add folder-level stats, globe WebUI icon, and text sizing fixes

## 2026.02.15-27
### Changes
- Add folder ports, WebUI icon, text sizing, and dark theme fixes

## 2026.02.15-26
### Changes
- Add changelog, improve Docker section takeover and settings page

## 2026.02.15-25
### Changes
- UI polish: confirm modals, folder UX, edit in kebab menu

## 2026.02.15-24
### Changes
- loading states and more details for settings

## 2026.02.15-23
### Changes
- various improvements

## 2026.02.15-22
### Changes
- add supporting links
- add linkable volumes

## 2026.02.15-21
### Changes
- fix spacing and alignment
- fix styling and stats not displaying. unraid is really mucking with styling.

## 2026.02.15-20
### Changes
- fix unraid styles taking over
- make composed folders easier to identify

## 2026.02.15-19
### Changes
- added better icon and updated plugin icon
- add settings to turn off live
- automatically group composed containers
- fix polling for stats

## 2026.02.15-18
### Changes
- more metric improvmenets and other little changes
- add container stats

## 2026.02.15-17
### Changes
- update current state
- chore: move to settings page

## 2026.02.15-16
### Changes
- add additional docker details and settings

## 2026.02.15-15
### Changes
- add edit buttons to containers

## 2026.02.15-14
### Changes
- change how drag and drop works, folders take icons from containers

## 2026.02.15-13
### Changes
- add list or card view and fix some other bugs

## 2026.02.15-12
### Changes
- add dev server and fix a couple bugs

## 2026.02.15-11
### Changes
- Release 2026.02.15-11

## 2026.02.15-10
### Changes
- chore remove iframe

## 2026.02.15-9
### Changes
- fix crsf issue

## 2026.02.15-8
### Changes
- move to tailwind
- move away from modern naming
- fix sorting and craeting folders

## 2026.02.15-7
### Changes
- update text docs
- feat: phase 3 realtime pipeline
- chore: update icon

## 2026.02.15-6
### Changes
- fix: settings

## 2026.02.15-5
### Changes
- Release 2026.02.15-5

## 2026.02.15-4
### Changes
- fix: pages

## 2026.02.15-3
### Changes
- Release 2026.02.15-3

## 2026.02.15-2
### Changes
- Release 2026.02.15-2

## 2026.02.15
### Changes
- Add CLAUDE.md for future Claude Code instances
- Add quick start guide for resuming development
- Add project status and current issue documentation

## 2026.02.14-11
### Changes
- Release 2026.02.14-11

## 2026.02.14-10
### Changes
- Fix Docker.page to properly integrate with Unraid UI (no full HTML doc)

## 2026.02.14-9
### Changes
- Fix page headers: add Type attribute and use FontAwesome icons

## 2026.02.14-8
### Changes
- Change Docker menu title to just 'Folders' for clean URL

## 2026.02.14-7
### Changes
- Switch from PDO to SQLite3 for better Unraid compatibility

## 2026.02.14-6
### Changes
- Add automatic GitHub release creation to build script

## 2026.02.14-5
### Changes
- Fix XML parsing by wrapping INLINE scripts in CDATA sections

## 2026.02.14-4
### Changes
- Release 2026.02.14-4

## 2026.02.14-3
### Changes
- Release 2026.02.14-3

## 2026.02.14-2
### Changes
- Release 2026.02.14-2

## 2026.02.14
### Changes
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
