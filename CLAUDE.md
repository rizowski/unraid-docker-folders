# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Unraid Docker Folders Modern** - A modern Unraid plugin to replace the outdated folderview2 plugin with Vue 3 frontend, real-time WebSocket updates, and SQLite persistence. Allows organizing Docker containers into folders with drag-and-drop.

**Current Status**: Shipping. Stable releases are cut from `main`, prereleases from `dev`. Beyond folder organization the plugin covers live resource stats, container logs, image update checking and batch pulls, Docker Compose editing and stack grouping, cron schedules, and configuration backups.

**UI work**: See DESIGN.md for the design system — theme tokens, button vocabulary, modal chrome, and the Unraid CSS reset gotchas. It is normative; follow it for any frontend change.

---

## Design Guardrails (MANDATORY for any UI change)

**Before touching any template, CSS, or `.page` markup, read `DESIGN.md` and
comply with it.** It is a set of hard constraints, not suggestions.

Non-negotiables (full rules + review checklist in DESIGN.md):
- The plugin must look **native to Unraid's webgui**: dense, flat,
  border-separated, themed by the user's Unraid theme variables.
- **Theme tokens only** (from `main.css` `@theme`) — never Tailwind palette
  classes (`bg-blue-500`, `text-slate-*`, …) or hex values in components.
- **One accent** (Unraid's `--header-background`). Status colors mean state,
  never decoration.
- No gradients, glassmorphism, glow shadows, or radii above `rounded` (4px)
  on panels. Shadows only on modals/dropdowns.
- Type scale is `text-xs`/`text-sm`; dense spacing (`p-2`/`p-3`); no hero
  sections or airy layouts.
- Inline stroke SVG icons only; **no emoji in the UI**; transitions ≤ 200ms
  and only for state changes.
- Reuse existing patterns (nav-btn, kebab menu, cards, BaseModal) before
  inventing new ones. Verify on both dark and light Unraid themes.

If a change genuinely requires breaking a rule, state which rule and why in
the commit message.

---

## Build Commands

### Frontend (Vue 3)
```bash
# Navigate to frontend directory
cd src/frontend

# Install dependencies
yarn install --frozen-lockfile

# Development server (localhost:5173)
yarn dev

# Type check without building
yarn type-check

# Lint (oxlint; fails on any warning). `yarn lint:fix` auto-fixes what it can.
yarn lint

# Unit tests
yarn test:run

# Build for production (outputs to ../backend/.../assets/)
yarn build
```

**Package manager is yarn 1.22.21**, declared in `package.json`'s
`packageManager` field and pinned in `.prototools`. `yarn.lock` is the only
lockfile — do not run `npm install`/`npm ci` here. npm 7+ rewrites a `yarn.lock`
it finds alongside, producing ~1600 lines of spurious diff.

**Linting**: oxlint, configured in `src/frontend/.oxlintrc.json` at the
`correctness` tier only. The broader `suspicious`/`perf` tiers are deliberately
off — they flag stylistic patterns (`no-shadow`, `toSorted`, `addEventListener`
over `onmessage`) throughout existing code and would turn a lint run into a
refactor. Suppress a genuine false positive inline with
`// oxlint-disable-next-line <rule>` plus a comment saying why.

### Backend + Package
```bash
# Development build (timestamped version)
./build/build.sh

# Release build (auto-increments, tags, pushes to git)
./build/build.sh --release
```

**What the release build does**:
1. Builds Vue frontend (`yarn build`)
2. Packages backend + assets into `.txz` archive
3. Calculates MD5 checksum
4. Updates `unraid-docker-folders-modern.plg` with version and MD5
5. Creates git commit and tag
6. Pushes to GitHub
7. Outputs package to `archive/` directory

**Output**: `archive/unraid-docker-folders-modern-<version>.txz`

**Important**: After release build, manually create GitHub release and upload the `.txz` file (gh CLI not authenticated).

---

## Architecture

### Dual Codebase Structure

This is a **split frontend/backend architecture** with an unusual build output location:

```
src/frontend/              # Vue 3 application
  ├── src/
  │   ├── components/      # Vue components (ConnectionStatus, ContainerCard, Folder*)
  │   ├── composables/     # useWebSocket.ts
  │   ├── stores/          # Pinia state management (docker.ts, folders.ts, settings.ts, stats.ts)
  │   ├── types/           # TypeScript definitions (folder.ts, websocket.ts)
  │   └── utils/           # csrf.ts
  ├── dev/
  │   └── mock-api.ts      # Vite dev server mock API (containers, folders, settings, stats)
  └── vite.config.ts       # Build output: ../backend/.../assets/

src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/
  ├── api/                 # PHP REST endpoints (containers.php, folders.php, settings.php, stats.php)
  ├── classes/             # PHP business logic (Database, DockerClient, FolderManager, WebSocketPublisher)
  ├── include/             # config.php, auth.php
  ├── migrations/          # SQL migration files
  ├── DockerFoldersMain.page      # Menu="Docker:3" - Folders tab
  ├── DockerFoldersSettings.page  # Menu="Utilities" - Settings (health status, etc.)
  └── assets/              # ← Frontend build output goes here
```

**Critical**: Frontend build outputs to `../backend/.../assets/` so that the `.txz` package includes compiled frontend assets.

### Database Architecture

Uses **SQLite3 native extension** (NOT PDO) because Unraid PHP lacks PDO SQLite driver.

**Key class**: `src/backend/.../classes/Database.php`
- Singleton pattern
- WAL mode for concurrency
- Migration tracking table

**Migrations**: Run automatically on plugin install via `scripts/migrate.php`

**Schema** (see `migrations/` folder):
- `folders` - Folder definitions (name, icon, color, position)
- `container_folders` - Container-to-folder associations
- `container_cache` - Cached Docker container data
- `settings` - Key-value plugin settings
- `migrations` - Tracks executed migrations

### Unraid Plugin Integration

**Page files** are how plugins add UI to Unraid's menu system. Key rules:

1. **NEVER name a .page file the same as a built-in page** (Docker.page, VMs.page, Main.page, Settings.page, etc.) - filenames are used as unique keys in the `$site` array by `PageBuilder.php`
2. Use `Tag=` for tab icons (not `Icon=`). `Icon=` is only for Settings panel pages
3. Use `Menu="Docker:N"` with a rank number to add tabs under Docker
4. Add `Cond="is_file('/var/run/dockerd.pid')"` so tabs only show when Docker is running

**Current configuration**:

`DockerFolders.page` - Adds "Folders" tab under Docker menu:
```
Menu="Docker:3"
Title="Folders"
Tag="folder"
Cond="is_file('/var/run/dockerd.pid')"
Markdown="false"
```

`Settings.page` - Adds settings page under Settings > Other:
```
Menu="OtherSettings"
Title="Docker Folders Modern"
Icon="folder"
Tag="folder"
Markdown="false"
```

**Valid Menu values**: `Tasks`, `Docker`, `VMs`, `Settings`, `OtherSettings`, `Utilities`, `UserPreferences`

**Page file format** (INI header parsed by `parse_ini_string()`):
```
Key="Value"
---
<?php // PHP code ?>
<!-- HTML content (fragment, not full document) -->
```

### Build System Details

**Auto-versioning**: `YYYY.MM.DD-N` format where N auto-increments for multiple builds per day.

**PLG file structure**:
- XML format with `<!ENTITY>` declarations for version and MD5
- Bash scripts wrapped in `<![CDATA[...]]>` to avoid XML parse errors
- Pre-install cleanup, migration runner, uninstall backup hooks

**Key files modified by build**:
- `unraid-docker-folders-modern.plg` - Version and MD5 updated
- Git tags created and pushed
- Package created in `archive/`

---

## Docker Integration

**Socket access**: `/var/run/docker.sock` via `DockerClient.php`

**API version**: v1.41 (configurable in `config.php`)

**Key operations**:
- List containers: `GET /containers.php`
- Start/stop/restart: `POST /containers.php?action=<action>&id=<id>`

**Container data flow**:
1. `DockerClient.php` queries Docker socket
2. Results cached in `container_cache` table
3. Frontend fetches via REST API
4. WebSocket updates on container state changes (nchan pub/sub)

---

## State Management

**Frontend**: Pinia stores in `src/frontend/src/stores/`

**Key stores**:
- `docker.ts` - Container list, status, actions (start/stop/restart), search query
- `folders.ts` - Folder CRUD, container assignments, drag-drop reordering
- `stats.ts` - Live resource stats with visibility-based polling
- `settings.ts` - Backend-persisted plugin settings

**State persistence**: Folders/assignments stored in SQLite, NOT localStorage

**Backend session**: See the Security section below.

---

## Security

Read this before adding or changing an API endpoint. Several of the rules are
non-obvious and the existing code depends on them.

### Every endpoint must call `requireAuth()`

`include/config.php` first, then `include/auth.php`, then `requireAuth()` before
any dispatch. The order is load-bearing: `requireAuth()` calls `errorResponse()`
from config.php, and config.php's `getRequestData()` calls `getRawBody()` from
auth.php. All nine endpoints in `api/` follow this.

`errorResponse()` → `jsonResponse()` (`config.php:454-472`) ends in `exit()`, so
a 401 genuinely terminates the request and cannot be fallen through.

### `validateSession()` — three fallbacks, and why

`auth.php:41-80` tries, in order:
1. An already-active PHP session with a `csrf_token` (started by `local_prepend.php`)
2. Resuming Unraid's session from the `unraid_<32-hex>` cookie, then testing
   `!empty($_SESSION)`
3. A legacy Flask-style `session` cookie

Method 2 checks `!empty($_SESSION)`, **not** `$_SESSION['csrf_token']`, because
`local_prepend.php` injects `csrf_token` into `$_SESSION` at runtime from
`var.ini` — it is never written to the session file. A non-empty session means
the user authenticated through the Unraid login.

### CSRF: `requireCsrf()` is a no-op for GET, OPTIONS, and POST

This is the single most misread part of the codebase. `auth.php:109-120`:

```php
if (in_array($method, ['GET', 'OPTIONS'])) return true;
if ($method === 'POST') return true;   // validated by local_prepend.php
```

**POST CSRF validation is delegated to Unraid's `local_prepend.php`**, which is
auto-prepended via php.ini and lives outside this repository. No code in this
plugin verifies a CSRF token on POST. Do not describe POST endpoints as
"CSRF-protected by the plugin" — the guarantee is Unraid's, and it cannot be
verified from this repo.

`requireCsrf()` only does real work for **PUT/DELETE**, where it compares against
the system token in `/var/local/emhttp/var.ini` using `hash_equals()`. That is
why only `folders.php` and `schedules.php` call it (lines 34/39 and 26/30) —
they are the only endpoints with PUT/DELETE branches. Endpoints handling only
GET/POST correctly omit it.

**If you add a PUT or DELETE branch, you must call `requireCsrf()` inside it.**
Nothing enforces this.

### Token transport (two hops, neither is a query param at the server)

1. `DockerFoldersMain.page:135,154` reads Unraid's global `csrf_token` and puts
   it in the **iframe URL query string**.
2. Inside the iframe `window.csrf_token` does not exist, so
   `utils/csrf.ts:31-33` falls back to reading it from `window.location.search`.
3. `apiFetch()` (`csrf.ts:44-72`) sends it as a **form-encoded body field**
   (`csrf_token=...&payload=<json>`), `Content-Type:
   application/x-www-form-urlencoded`, `credentials: 'include'`. GET passes
   through untouched.

The server never reads `$_GET['csrf_token']` — `auth.php:104` says so explicitly.
The JSON body lives in the `payload` field, which is what `getRequestData()`
(`config.php:61-79`) and the PUT/DELETE fallback in `validateCsrfToken()` expect.

Note `apiFetch()` replaces `options.headers` wholesale, so callers cannot add an
`X-CSRF-Token` header even though `auth.php:129` would accept one.

`DockerFoldersSettings.page` is a native Unraid page, not an iframe — it reads
`window.csrf_token` directly and hand-builds the same body format.

### SQL

`Database::query()` (`Database.php:96-124`) always prepares and binds. Route all
value-bearing SQL through it, `fetchAll`, `fetchOne`, or `fetchValue`.

`insert()`, `update()`, `delete()`, and `getRowCount()` interpolate **table
names, column names, and WHERE fragments** into the SQL string
(`Database.php:199,218,221,238,309`). Values are still bound, and every current
caller passes hardcoded allowlists — see `FolderManager.php:107-121`,
`ScheduleManager.php:100-105`, `settings.php:80-94`. **Never pass request data
into a table name, column name, or WHERE fragment.**

`Database::exec()` runs raw unbound SQL; it is only for PRAGMAs, transactions,
and migration files.

### Shell

Every user-influenced value reaching a shell goes through `escapeshellarg()` —
`ComposeManager.php` (compose args, `cd` targets), `BackupManager.php:279-283`
(tar), `scripts/check-updates.php:63-64` (notify). Keep it that way.

`CronManager` writes root's crontab but is not injectable: the cron expression
comes from a hardcoded map (`CronManager.php:14-19`) and the script path from a
class constant. **User-supplied `cron_expression` never reaches the crontab** —
schedules are polled by a once-a-minute runner instead. Do not "simplify" this by
writing user expressions into cron.

### Known gaps

Documented so they are not mistaken for intentional design. See the security
review notes if these get addressed:

- **`action=set_env_path` stores an unvalidated path.** `compose.php:346-361` →
  `ComposeManager.php:455-462` writes `$data['path']` straight into
  `compose_stacks.env_file`; `resolveEnvFilePath` (`:1113-1131`) returns absolute
  paths verbatim. `save_env` then writes attacker-chosen content to it as root
  (`:1074`), and `action=env` (a GET) reads it back into the JSON response
  (`:1033`). Compare `createStack:371`, which *does* validate its project name.
- **A GET handler mutates the database.** `containers.php:98-105` calls
  `reconcileContainerIds()` and `syncComposeStacks()` on the list path, so it
  writes to `container_folders`, `folders`, and `compose_stacks` with no CSRF
  gate at any layer.
- **`compose_export_dir` is validated only as "starts with `/`"**
  (`ComposeManager.php:1535-1537`).
- **`containers.php:158`** builds an XML template path from unvalidated
  `$_GET['name']`. Bounded by a `file_exists()` check at `:174`.
- **`BackupManager` containment checks are string prefixes, not path boundaries**
  (`:168`, `:188-198`) — no `..` normalization, so `/mnt/../etc` passes and
  `/mnt/user/backups-evil` satisfies a `/mnt/user/backups` prefix test.
- **`schedules.php` PUT skips the `target_type`/`action` allowlists** that POST
  enforces (`:176-184` vs `ScheduleManager.php:100-105`). Not code execution —
  `dispatchAction` defaults to "Unknown action".
- **No CORS, CSP, `X-Frame-Options`, or `X-Content-Type-Options` headers** are set
  anywhere. The `case 'OPTIONS'` branches are labelled "CORS preflight" but emit
  no `Access-Control-*` headers, so they are inert.
- **No input sanitization helper exists.** `getRequestData()` returns decoded
  JSON with no validation or type checking.
- Several handlers return raw exception text to the client (`folders.php:53`,
  `compose.php:41`, `containers.php:44`, `stats.php:36`); others correctly return
  a generic message (`settings.php:40`, `schedules.php:43`, `updates.php:41`).

These are all **post-authentication** — they require a valid Unraid session, and
an authenticated Unraid webgui user already has root-equivalent access via the
Docker socket. That limits practical escalation but does not make them
acceptable.

---

## Known Issues & Gotchas

### Resolved Issues
- ✅ Page rendering blank (Docker.page filename collision with built-in - renamed to DockerFolders.page)
- ✅ XML parse errors in PLG (fixed with CDATA)
- ✅ SQLite driver unavailable (switched from PDO to SQLite3 native)
- ✅ Icon display (use FontAwesome names, not file paths)

### Development Constraints
- **No PDO**: Use `SQLite3` class directly
- **No full HTML docs in .page files**: Output content fragments only
- **Vite base path**: Must be `/plugins/unraid-docker-folders-modern/assets/` for Unraid integration
- **File permissions**: .page files = 644, scripts = 755, handled by build script
- **Node / yarn via proto**: `.prototools` at the repo root pins `node = "22.18.0"` and `yarn = "1.22.21"`. If `yarn` isn't on PATH, run `proto use` in the repo root to install and shim them. Shims live at `~/.proto/shims/`. (`npm = "bundled"` is pinned too, but see the package-manager note above — don't use it in `src/frontend`.)
- **No local PHP**: Lint/validate PHP with the `php:8.2-cli` Docker image, e.g.:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app php:8.2-cli php -l path/to/file.php
  ```
  Never assume a local `php` binary is available.

---

## Real-Time Updates

**Architecture**:
1. PHP API endpoints publish events to nchan after each successful mutation
2. `WebSocketPublisher.php` POSTs JSON to `NCHAN_PUB_URL` (fire-and-forget, 2s timeout)
3. Frontend connects to `ws://<host>/sub/docker-modern` via `useWebSocket.ts` composable
4. On event received, stores call `fetchContainers()` or `fetchFolders()` (full refetch, not patching)
5. Exponential backoff reconnection (1s base, 30s max)
6. 30s polling fallback catches external changes (CLI, Portainer, etc.)
7. Fetch debounce (500ms) prevents redundant calls when UI action already refreshed
8. `ConnectionStatus.vue` shows live/connecting/offline/error state in header

**CSRF flow**: see the Security section. In short — the `.page` file passes the token to the iframe via query param, `utils/csrf.ts` reads it there, and `apiFetch()` sends it as a form-encoded body field. It is *not* appended to URLs, and there is no `withCsrf()` helper.

**nchan integration**: Unraid has built-in nchan server for pub/sub.

---

## Testing Strategy

### Frontend (Vitest)
190 tests across 12 files, colocated in `__tests__/` directories next to the code
they cover (stores, utils, and components). Run with `yarn test:run` in
`src/frontend`.

Note that several suites deliberately exercise error paths, so a passing run
still prints handled errors (e.g. "Error fetching logs: network failure") to the
console. Read the summary line, not the noise.

### Backend (PHPUnit)
Lives in `tests/php/` (`AuthTest.php`, `DockerClientStatsTest.php`,
`UpdateCheckTest.php`). There is no local PHP binary — the suite runs in Docker
via `tests/php/run.sh`, with `Dockerfile` and `phpunit.xml` alongside it.

### Not covered by automated tests
Anything that needs a real Unraid box: the nchan WebSocket channel, CSRF/session
flow against the live webgui, Docker socket behaviour, and persistence across
reboots. Verify these by installing a build on-device.

---

## File Location Conventions

### Configuration
- **Plugin config**: `src/backend/.../include/config.php`
- **Persistent data**: `/boot/config/plugins/unraid-docker-folders-modern/`
- **Database**: `/boot/config/plugins/unraid-docker-folders-modern/data.db`
- **Backups**: `/boot/config/plugins/unraid-docker-folders-modern/backups/`

### Installation Paths (on Unraid)
- **Plugin directory**: `/usr/local/emhttp/plugins/unraid-docker-folders-modern/`
- **Assets**: `/usr/local/emhttp/plugins/unraid-docker-folders-modern/assets/`
- **Package log**: `/boot/config/plugins/unraid-docker-folders-modern/install.log`

---

## Important Development Notes

### When Modifying Frontend
- **Read DESIGN.md first.** It defines the design system: Unraid theme variables and derived Tailwind tokens, the `.nav-btn` button vocabulary, modal chrome and the `BaseModal` positioning contract, form field patterns, and the Unraid CSS reset that silently strips styles from any button not carrying `.nav-btn`.
- Run `yarn build` in `src/frontend/`
- Or use full release build: `./build/build.sh --release`
- Assets automatically copied to backend during build

### When Modifying Backend PHP
- Changes go in `src/backend/usr/local/emhttp/plugins/...`
- Run `./build/build.sh --release` to package
- Install on Unraid to test

### When Modifying Database Schema
1. Create new migration file in `migrations/` (e.g., `003_add_new_table.sql`)
2. Migrations run automatically on plugin install/upgrade
3. Migration tracking in `migrations` table prevents re-execution

### When Modifying .page Files
- Header is INI format parsed by `parse_ini_string()` - must have `Key="Value"` pairs
- Content after `---` separator is HTML fragment (not full document)
- PHP code allowed before HTML
- **NEVER reuse a built-in page filename** (Docker.page, VMs.page, etc.)
- Use `Tag=` for tab icons, `Icon=` for Settings panel icons
- For fast debugging: SSH to Unraid, edit files in-place at `/usr/local/emhttp/plugins/...`, refresh browser

---

## Quick Reference

### Useful URLs (on Unraid)
- Direct app: `http://<unraid>/plugins/unraid-docker-folders-modern/assets/index.html`
- Docker Folders tab: `http://<unraid>/Docker/DockerFolders` (tab under Docker menu)
- Settings: `http://<unraid>/Settings/DockerFoldersModern` (under Other Settings)

### Key Constants (config.php)
- `PLUGIN_NAME`: `unraid-docker-folders-modern`
- `DB_PATH`: `/boot/config/plugins/unraid-docker-folders-modern/data.db`
- `DOCKER_SOCKET`: `/var/run/docker.sock`
- `NCHAN_PUB_URL`: `http://localhost:4433/pub/docker-modern`

### API Endpoints
- `GET /api/containers.php` - List containers (includes ports, mounts, networkSettings)
- `POST /api/containers.php?action=start&id=<id>` - Start container
- `GET /api/folders.php` - List folders
- `POST /api/folders.php` - Create folder (body: `{name, icon, color}`)
- `PUT /api/folders.php?id=<id>` - Update folder
- `DELETE /api/folders.php?id=<id>` - Delete folder
- `GET /api/settings.php` - Get all plugin settings
- `POST /api/settings.php` - Update setting (body: `{key, value}`)
- `GET /api/stats.php?ids=id1,id2` - Get live resource stats for containers
- `GET /api/updates.php` - Image update availability
- `POST /api/pull.php` - Pull updated images (supports batches)
- `GET|POST /api/compose.php` - Read and apply Compose files
- `GET /api/compose-stream.php` - Stream Compose command output
- `GET|POST /api/schedules.php` - Container action schedules

---

## Community Applications

The repo is set up for the CA catalog. Three files must stay consistent:

- `LICENSE` (repo root, MIT) — CA gates submission on an OSI-approved license
- `ca_profile.xml` (repo root) — root element is `<CommunityApplications>`; a
  non-empty `<Profile>` is required or CA blocks submission
- `plugins/unraid-docker-folders-modern.xml` — the plugin wrapper

**The wrapper's `<PluginURL>` must byte-match the `pluginURL` entity in
`unraid-docker-folders-modern.plg` on `main`.** `build.sh` rewrites the branch
segment of that entity to match the current branch, so on `dev` the `.plg` points
at `/dev/`. The wrapper is never rewritten and stays pinned to `/main/` on
purpose. When merging `dev` → `main`, resolve `.plg` conflicts keeping `main`'s
`/main/` segment.

Wrapper `<Support>`, `<MinVer>`, and `<MaxVer>` are omitted deliberately: the
`.plg`'s `support=` and `min=` attributes take precedence and would override
them.

`icon.png` lives at the repo root so CA can reference it by raw URL; `build.sh`
copies it into the plugin directory at package time, because the `.plg`'s
`icon=` attribute resolves as a filename in plugdir, not a URL.
