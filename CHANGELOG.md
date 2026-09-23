# Changelog

## 2026.09.23
- refactor(logs): one timestamp pass, and require the log time zone
- fix(logs): show Docker's line stamps in the server's time zone
- feat(dashboard): put the folded tile's summary on one line
- feat(dashboard): show running count, CPU and RAM on the folded tile
- test(container-card): stop a stats fetch from replacing seeded stats
- feat(widget): show the all-running total as two arc gauges
- fix(containers): keep volumes and ports in one order across refreshes
- feat(ui): show shimmer skeletons during the first load
- refactor: clean up after review of the stats and database changes
- perf(graphql): share one database handle, and speed up the page load
- feat(stats): measure folder and total stats against the host
- fix(plg): skip the Unraid API plugin install when it is current
- fix(build): lock @unraid/shared to the tarball CI downloads
- feat(settings): mark the GraphQL backend as unstable
- feat(graphql): add a GraphQL backend beside PHP, chosen by a setting
- fix(backups): check deleteBackup() containment with pathIsWithin() again
- fix(schedules): report a lock file that cannot be opened as a failure
- fix(compose): recheck every stack before an import rollback deletes files
- fix(compose): do not roll back a file the import did not create
- fix(compose): check project names with one shared rule
- docs(docker): merge the two docblocks on request()
- fix(backups): report the archive this stack backup actually wrote
- fix(updates): decode whole lines of a pull stream and report every failure
- fix(compose): apply the 128-character name limit in compose.php too
- fix(compose): import only stacks the API can address, and keep a racing import's files
- perf(compose): cache a missing docker compose too
- fix(compose): stop execCommand spinning once its pipes close
- fix(compose): give up, down, stop and pull 600 seconds
- docs(docker): name the one path request() gets unencoded
- fix(api): read "false" as false in request flags
- refactor(updates): stop writing the unused release_notes.etag
- fix(updates): keep autolink URLs in release-note summaries
- refactor(compose): drop snapshotVersion's unused $sourcePath
- fix(compose): copy imported files outside the database transaction
- fix(compose): check the project name the same way in both endpoints
- fix(compose): keep exporting stacks whose names contain a dot
- fix(compose): refuse set_description while management is off
- fix(compose): list services for a stack that has no compose_file set
- perf(compose): check for docker compose once per request
- fix(compose): enforce execCommand's timeout and read both pipes together
- fix(ports): count random host ports in conflict detection
- docs(claude): describe how PHP actually runs here
- fix(updates): count each checked image once
- fix(compose): update a stack row only when its paths change
- fix(docker): stop inspecting a container whose image is gone
- fix(websocket): return whether a publish succeeded
- fix(websocket): send nothing while Unraid pauses publishing
- fix(stats): accept only a full container id in getContainerLogSize
- fix(docker): URL-encode every id in a Docker socket path
- fix(schedules): run one schedule at most once at a time
- fix(updates): release the session lock during a manual check
- fix(containers): report a Docker failure instead of an empty list
- fix(updates): split an image reference with a registry port or digest
- fix(updates): keep the release-notes link after a pull
- fix(adopt): write the image tag, not a digest, into the template
- fix(websocket): publish folder refreshes as entity "folder"
- fix(compose): refuse an unsafe project name in exportConfigs
- fix(updates): fail a pull when Docker streams an error
- test(backups): pin what deleteBackup may delete
- fix(backups): list only the target's own archives
- fix(backups): report the newest archive of a stack backup
- fix(backups): fail a stack backup that archived nothing
- fix(backups): report a failed restart when the archive also fails
- fix(backups): remove the partial archive when tar fails
- fix(backups): prune only the archives the target wrote
- fix(backups): delete only an archive the plugin wrote
- fix(schedules): claim each due slot, so two runners cannot both run it
- fix(updates): recreate a container that has no labels
- fix(websocket): publish to nchan over the Unix socket

## 2026.09.20
- fix(schedules): read the right crontab spool and repair the runner itself
- feat(schedules): suggest backup paths, quiet the container, watch the runner
- test(settings): pin the security advisor default to on
- fix(install): use installpkg so a colliding package name cannot skip the install (#16)
- feat(docker): open the compose file from a container's Edit menu
- fix(security): compare a container's user against the image's own USER
- feat(security): collapse the findings panel and name each note's cell
- feat(security): warn on shared folders and link the image page
- feat(security): flag risky container settings and advise on them

## 2026.09.19
- fix(widget): span the folder color across the header row
- fix(widget): keep the WebUI icon column on every row
- fix(assets): stamp unhashed plugin assets with their mtime
- feat(widget): show CPU, memory, and status tags on the dashboard
- feat(settings): replace the Docker Containers section by default
- refactor(schedules): return the schedule details from executeSchedule
- perf(menus): listen for scroll only while a submenu is open
- refactor(folders): read the Compose action status in one place
- refactor(menus): share kebab menu icon paths between containers and folders
- feat(schedules): post an Unraid notification when an automatic run fails
- fix(folders): keep an unticked container out of its folder
- fix(folders): scroll the page while a container is dragged near its edge
- fix(folders): keep a folder collapsed when a refetch lands before its save
- fix(folders): remove a dragged container from its old folder at once
- feat(menus): mark disabled menu items that explain why with an info icon
- fix(containers): give autostart its own submenu
- fix(menus): use a stopwatch icon for Autostart Delay
- feat(containers): group the container menu into hover submenus
- fix(folders): alphabetize the folder menu submenus
- fix(folders): move Edit Stack into the Actions submenu
- feat(folders): group the folder menu into hover submenus
- fix(schedules): run "N/S" steps from N instead of at N only
- fix(schedules): describe every field of a cron expression
- fix(folders): stack collapsed folder CPU and MEM like a container row

## 2026.09.18
- fix(schedules): allow Resume, keep the custom cron field, and stop clipping modals (#7)

## 2026.09.13
- refactor(dashboard): simplify the widget settings code
- feat(dashboard): add a settings panel to the Docker Folders tile
- fix(dashboard): run the tile page as PHP instead of showing its source
- feat(dashboard): add a Docker Folders tile to the Unraid dashboard
- refactor(sort): share the folder sort decision and extract sort fields once
- feat(header): show the container and folder counts inside the search field
- feat(settings): group the settings page by what each setting affects
- feat(sort): add a "Sort folders too" toggle to the sort menu
- fix(folders): apply the toolbar sort to folder contents
- build: use content-hashed asset filenames
- fix(folders): do not count removed containers as hidden
- docs: add a contributing guide and require dev as the PR base
- fix(folders): repair the #9 merge and add the sort menu
- Add auto-sort options for folders and folder contents (#9)
- chore: update docs
- refactor: share the paused-start rule and tidy the issue fixes
- feat(updates): add Force Update to the container menu (#11)
- feat(schedules): add a Resume action and let Start resume a paused container (#7)
- fix(docker): resume a paused container from the card and the API (#7)
- fix(schedules): evaluate and show schedule times in the server timezone (#7)
- fix(folders): persist the manual order of unfoldered containers (#12)

## 2026.09.12
- refactor: share the move-to-folder action and the select modal
- feat(updates): name the containers in the update notification
- feat(folders): add a folder picker to the container menu
- fix(compose): rename the Stack Details menu item to Edit Stack
- feat(docker): show the inline log panel in card view

## 2026.08.22
- test(docker): pin the managed-with-autostart-off branch
- fix(docker): correct three faults the browser check found
- feat(docker): put Adopt on the container, not only in the kebab menu
- fix(docker): escape adopted values before they reach Unraid's shell
- feat(docker): adopt CLI-created containers into Unraid's container manager
- fix(ui): keep an open kebab menu inside the frame instead of scrolling
- fix(ui): stop the unfoldered section clipping open kebab menus

## 2026.08.19
- fix(folders): only add/remove containers that changed when saving a folder

## 2026.08.17
- feat(settings): add a "Buy me a coffee" Ko-fi link
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
