# Changelog

## 2026.08.17
- feat(ui): collapse the create buttons into one menu, widen the search
- feat: rename to "Docker Folders" and shorten the page URLs
- feat(ui): one update button, and a re-check inside the confirm modal
- feat(ui): collapse the three create buttons to "+" plus an icon

## 2026.08.16
- fix(ui): render the update-check controls before settings land
- docs: summarize each release in CHANGELOG, stop regenerating it
- chore: drop the beta label from Image Updates settings
- fix(ui): stop compose buttons blinking in while availability is checked
- test: fix session tests broken by PHPUnit output, silence constant warnings
- fix(security): validate every user-influenced filesystem path
- chore: prepare repo for Community Applications submission

## 2026.08.10
The update confirm modal now shows the release notes for each image.

## 2026.07.26
Reworked the container card. The status dot became a halo around the container
icon, the expanded card was restructured, and its click target is now wider.
Added batch image updates: you can review the affected containers before the
pull and update several at once. A container's schedules now appear in its
expanded card. Fixed log reading for TTY containers.

## 2026.07.25
Fixed the schedules modal.

## 2026.07.18
Added a design system (`DESIGN.md`) and moved the UI onto theme tokens. Folders
gained a tint that shows their expanded state, replacing the left-border accent.
Added settings to hide the legacy Docker containers and buttons, and added
update checks that target one container or one compose stack. Releases now run
from GitHub Actions.

## 2026.07.10
Maintenance release.

## 2026.06.06
Fixed cron registration. The plugin now writes to its own config directory.

## 2026.05.30
Added port conflict detection. A stopped container whose ports are already bound
shows a badge, and the expanded card lists the containers it conflicts with.

## 2026.04.22
Fixed update-check cron registration. The Update badge now links to the release
notes for that image.

## 2026.04.12
Added scheduling and backups. You can run container and stack actions on a cron
schedule, and back up container data on the same schedule.

## 2026.04.11
Overhauled the compose editor: a logs tab, a recompose flow, YAML highlighting,
and a save lock. Added compose file version history with rollback. Container
stats now read from cgroups and cache their slow data, which cut load time.

## 2026.04.07
Modals now render in the parent window, so the iframe no longer clips them.
Fixed the compose import banner for users without the compose.manager plugin.

## 2026.03.21
Added a Create Stack button and a per-container autostart toggle. Fixed
autostart so it reads and writes Unraid's flat file rather than only the XML
template. Extracted icons into reusable components and fixed folder counts,
cleanup of deleted containers, and several modal styling problems.

## 2026.03.15
Added Docker Compose management. Fixed a set of iframe problems: modal
clipping, scroll feedback between the modal and the parent page, and z-index.

## 2026.03.06
Maintenance release.

## 2026.02.28
Mobile overhaul. The layout is responsive, container actions move into the kebab
menu on small screens, and list view gained an inline logs panel. Fixed a 502
error on the Console and Logs actions.

## 2026.02.27
Fixed image update accuracy. Update badges no longer go stale after a check
finds nothing, SHA image references resolve to tags when a container is
recreated, and pulling an image no longer causes a false update report.

## 2026.02.25
Containers can now be recreated automatically after a pull. Fixed update checks
that stopped after the first container, and fixed the folder collapse animation
leaving the iframe at the wrong height. Added the first PHP tests.

## 2026.02.24
Hardened the API: authentication is enforced on every endpoint, input is
validated, and CSRF works for PUT and DELETE. Rewrote the settings page with a
dark theme and grouped sections. Added image update checking with cron
scheduling, batch pulls, folder badges, and an exclude list.

## 2026.02.23
Moved the app into an iframe to isolate it from Unraid's global CSS, and passed
Unraid's theme variables in so dark mode works. Unified the kebab menu into one
component, added a card/list view toggle, and fixed drag-and-drop duplication.

## 2026.02.15
The largest release. Added container search, live resource stats, image update
checking with pull progress, and a mobile-responsive layout. Compose containers
group into folders automatically. Expanded cards gained command, health, labels,
and volume details. Folder associations now survive a container being recreated.
The changelog itself became generated from git history.

## 2026.02.14
First working plugin. Set up the Vue 3 frontend, the PHP backend and its API,
the SQLite schema and migrations, and the build system that packages the plugin
and creates the GitHub release. Folder management landed here. Switched from PDO
to SQLite3, which Unraid supports.
