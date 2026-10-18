# Changelog

## 2026.10.18-dev1
### New
- A new memory calculation setting under Settings > Docker Folders > Display lets you switch container memory usage back to the raw cgroup number. (#19)

### Fixed
- Container memory usage now matches what docker stats shows, instead of reading higher because page cache was counted. (#19)

### Internal
- Internal fixes and performance improvements.

## 2026.10.11-dev4
### Fixed
- A collapsed folder now shows its CPU as the sum of its containers, so one container using a full core no longer shows as about 1% on large hosts.
- Copying the restore steps in the GraphQL warning dialog in Settings no longer closes the dialog, so the install button can be reached.

## 2026.10.11-dev3
### Fixed
- The option to reinstall Docker Compose after a reboot now works fully: the settings page shows the server's error when the copy to flash fails instead of always saying "Saved", and the flash copy is removed when the option is off or the plugin is uninstalled (#18).

### Internal
- Internal fixes and performance improvements.

## 2026.10.11-dev2
### New
- A new setting can reinstall Docker Compose automatically after a reboot, keeping a verified copy on the flash drive so compose stacks can autostart again (#18).

## 2026.10.11-dev1
### Improved
- The settings page no longer shows a green accent bar on each settings box.
- The GraphQL backend only runs on tested Unraid API versions, and the settings page refuses to switch to it on an untested version.
- A server using the GraphQL backend switches back to the PHP backend on its own when an Unraid API update moves it outside the tested versions.

### Fixed
- The GraphQL backend now installs on Unraid 7.3.3 and 7.4.0-rc1, and a failed install is reported instead of passing silently.

### Internal
- Internal fixes and performance improvements.

## 2026.10.04
### New
- Before you switch to the GraphQL backend, the settings page asks you to copy the manual restore steps. The install button stays off until you copy them.

### Improved
- The Backend section on the settings page no longer has a green accent bar.

## 2026.09.29
### Improved
- A Postgres backup schedule writes a separate archive for each database.

## 2026.09.28
### New
- Backup schedules have a Postgres mode. It runs `pg_dump` inside the container and, by default, uses the container's own Postgres user and password.
- Schedules have an Update action. It checks the image and recreates the container. If the registry has a newer build, it pulls that build first.

### Improved
- Scheduled and "Run now" updates run in the background, so a long pull does not hold up other schedules.

### Internal
- Internal fixes and performance improvements.

## 2026.09.24
### New
- If you choose the GraphQL backend on the settings page, it installs. Otherwise it does not. If it stops answering, the plugin switches back to the PHP backend and sends a notification.

### Fixed
- Removing the GraphQL backend restarts the Unraid API once, so the API does not keep the removed backend loaded.
- A GraphQL backend install that hangs now times out instead of waiting forever.

### Internal
- Internal fixes and performance improvements.

## 2026.09.23
### New
- You can choose an optional GraphQL backend on the settings page. It runs inside the Unraid API and is marked unstable.
- The folded dashboard tile shows the running count, CPU and RAM on one line.
- The dashboard tile shows the CPU and memory of all running containers as two gauges.
- Placeholders show while the page loads for the first time.

### Improved
- Folder and total stats are measured against the whole server.

### Fixed
- Container logs show Docker's timestamps in the server's time zone.
- Volumes and ports keep the same order across refreshes.
- Port conflict detection counts random host ports.
- The container list reports a Docker error instead of showing an empty list.
- Live updates reach other open tabs again, including folder changes.
- A schedule runs at most once at a time.
- Image updates report every failed pull, handle image names with a registry port or a digest, and recreate containers that have no labels. The release notes link stays after a pull.
- A manual update check no longer blocks the rest of the page while it runs.
- Adopting a container writes the image tag, not a digest, into its template.
- Compose stack commands get 600 seconds before they time out, and a finished command no longer keeps the server busy.
- If a Compose import rolls back, your files stay.
- Stacks whose names contain a dot export again.
- A stack with no compose file set lists its services.
- Stack backups report the archive they actually wrote.
- If a stack backup archives nothing, it fails. If it fails, it removes its partial archive.
- Backups list, prune and delete only the archives the plugin wrote for that container or stack.

### Internal
- Internal fixes and performance improvements.

## 2026.09.20
### New
- A security advisor flags risky container settings, warns about shared folders, and links to the image page. Its findings panel can collapse.
- You can open a container's compose file from its Edit menu.
- Backup schedules suggest paths, can pause or stop the container while they run, and show whether the schedule runner is alive.

### Fixed
- If another package has a similar name, the plugin still installs (#16).
- The schedule runner finds its crontab entry. If the entry is missing, the runner adds it again.
- The security advisor compares a container's user with the image's own user, which removes false warnings.

### Internal
- Internal fixes and performance improvements.

## 2026.09.19
### New
- The dashboard tile shows CPU, memory and status tags.
- The container and folder menus group their items into submenus. A disabled item shows an info icon that says why.
- A failed automatic schedule run sends an Unraid notification.

### Improved
- The plugin replaces the Docker Containers section by default. You can turn this off on the settings page.
- Autostart has its own submenu, Edit Stack moved into the Actions submenu, and folder submenus are in alphabetical order.
- A collapsed folder shows CPU and memory the same way a container row does.
- On the dashboard tile, the folder color spans the header row and every row keeps its WebUI icon column.

### Fixed
- A container you untick stays out of the folder.
- The page scrolls while you drag a container near its edge.
- A collapsed folder stays collapsed after a refresh.
- A dragged container leaves its old folder at once.
- Schedule times with steps such as "5/15" start at the first number, and every cron field gets a description.
- Plugin pages load the new files after an update instead of cached ones.

### Internal
- Internal fixes and performance improvements.

## 2026.09.18
### Fixed
- Schedules allow the Resume action, keep a custom cron expression, and no longer clip their dialogs (#7).

## 2026.09.13
### New
- A Docker Folders tile on the Unraid dashboard, with its own settings panel.
- Automatic sorting of folders and their contents, with a "Sort folders too" option (#9).
- Force Update in the container menu (#11).
- A Resume action for schedules. Start also resumes a paused container (#7).
- The search field shows the container and folder counts.

### Improved
- The settings page groups settings by what they affect.

### Fixed
- You can resume a paused container from its card (#7).
- Schedule times use the server's time zone (#7).
- The manual order of containers outside folders is kept (#12).
- The toolbar sort also sorts folder contents.
- Removed containers no longer count as hidden.
- The dashboard tile shows the page instead of its source code.

### Internal
- Internal fixes and performance improvements.

## 2026.09.12
### New
- Move a container to a folder from its menu.
- Card view has an inline log panel.

### Improved
- The update notification names the containers.
- "Stack Details" is now "Edit Stack".

### Internal
- Internal fixes and performance improvements.

## 2026.08.22
### New
- Adopt containers created on the command line into Unraid's container manager, from the container card.

### Fixed
- An open menu stays inside the page and is no longer cut off.
- Adopted container values are escaped before they reach Unraid's shell.

### Internal
- Internal fixes and performance improvements.

## 2026.08.19
### Fixed
- Saving a folder changes only the containers you added or removed.

## 2026.08.17
### New
- A "Buy me a coffee" Ko-fi link on the settings page.

### Improved
- The plugin is now called "Docker Folders", and its page addresses are shorter.
- The create buttons are one "+" menu, and the search field is wider.
- One update button, and you can check for updates again inside the update dialog.

## 2026.08.16
### Improved
- Image Updates settings are no longer marked beta.

### Fixed
- The update check controls show before the settings finish loading.
- Compose buttons no longer flicker while the page checks whether Compose is available.
- Every file path that a user can influence is checked before use.

### Internal
- Internal fixes and performance improvements.

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
