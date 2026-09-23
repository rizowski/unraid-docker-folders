# unraid-api-plugin-docker-folders

A plugin for the Unraid API. It contributes NestJS modules to the running API,
so its resolvers merge into the one code-first GraphQL schema at `/graphql`.

The plugin is the GraphQL half of `unraid-docker-folders-modern`. The PHP
backend remains the default, and a setting chooses which one the Vue app talks
to. Today the plugin serves the folder read and write paths.

## Requirements

Unraid 7.2 or later. The Unraid API is built into the operating system from
that version. Earlier systems need the Unraid Connect plugin.

## What it exposes

Queries:

| Field | What it answers |
|---|---|
| `dockerFolderLayout` | Every folder with its members, plus the order of unfoldered containers |
| `dockerFoldersInfo` | The probe: plugin version, database path, and whether the database is readable |

Mutations:

| Field | What it does |
|---|---|
| `createDockerFolder` | Adds a folder at the end of the list |
| `updateDockerFolder` | Changes a folder. An omitted field leaves its column alone |
| `deleteDockerFolder` | Deletes a folder. Its containers become unfoldered |
| `addContainerToDockerFolder` | Moves a container in, out of whichever folder it was in |
| `removeContainerFromDockerFolder` | Takes a container out and records a Compose-sync exclusion |
| `reorderDockerFolderContainers` | Sets the manual order inside one folder |
| `reorderDockerFolders` | Sets the order of the folders themselves |
| `reorderUnfolderedDockerContainers` | Replaces the order of the containers in no folder |
| `startDockerContainer` | Starts a container, or resumes it when it is paused |
| `resumeDockerContainer` | Resumes a paused container |
| `stopDockerContainer` | Stops a container, allowing 10 seconds to exit |
| `restartDockerContainer` | Restarts a container, allowing 10 seconds to exit |
| `removeDockerContainer` | Removes a stopped container and its folder membership |

Export and import stay on the PHP side. They carry the whole configuration
file rather than one folder.

### Why the container actions are not upstream's

The Unraid API has `docker.start`, `docker.stop` and the rest, and the plan
was to call them. Four things, read from the `unraid/api` source at the
`v4.35.1` tag, decided against it:

- There is no `docker.restart` on 4.35.1. It arrives in 4.37.x. The plugin
  needs it on the version users have.
- `docker.start` calls Docker's start. Docker answers that with 304 on a
  paused container and leaves it paused. `DockerClient.php` inspects first and
  resumes instead.
- `docker.removeContainer` always passes force. PHP forces only when the
  caller asks for it, and the frontend never does, so a running container is
  refused rather than killed.
- Nothing upstream knows about `container_folders` or `unfoldered_order`, so a
  container removed through it keeps its folder membership forever.

Splitting five buttons between two owners by API version costs more than
owning all five. Owning them also keeps the behavior the same in both backend
modes, which is what makes the two comparable.

And one command, `unraid-api docker-folders:status`, which answers the same
question when the plugin fails to load and GraphQL cannot be reached at all.

## Every `@InputType` field needs a class-validator decorator

`@Field()` alone is not enough, and the failure looks nothing like a missing
decorator.

The API installs a global `ValidationPipe` with `whitelist: true` and
`forbidNonWhitelisted: true` (`api/src/unraid-api/main.ts`). Whitelisting keeps
only the properties that carry a class-validator decorator. Forbidding the rest
turns every other property into a 400. So an input class written for GraphQL
alone is rejected property by property:

```
"property name should not exist",
"property icon should not exist",
"property color should not exist"
```

Add `@IsOptional()` with `@IsString()`, `@IsInt()` or `@IsBoolean()` beside
each `@Field`. `class-validator` is a runtime dependency of the API, so it is a
peer dependency here.

This cost the whole folder write path on the server, and nothing local caught
it: an error-code probe stops at auth without executing a field, and the
equivalence test calls the service directly and never passes through a
resolver. `folder.model.spec.ts` now runs the real pipe with the real options
against the input classes, which is the only cheap test that would have.

Scalar arguments are unaffected. The pipe skips primitives, so the container
mutations, which take a `String` id, were never at risk.

## Data

The plugin reads
`/boot/config/plugins/unraid-docker-folders-modern/data.db`, the same SQLite
file the PHP backend owns. Both backends must read the same rows or switching
modes loses work.

Reads go through `node:sqlite`, which is built into node 22 and is a real
SQLite build. That matters twice: the box has no compiler, so a native binding
cannot be built there, and PHP runs the database in WAL mode, which a WASM
build cannot follow. Measured on Unraid 7.3.2: the API runs on
`/usr/local/bin/node` v22.18.0 and `node:sqlite` loads there.

Writes go through the same file, because PHP is still the default and a folder
made in one mode has to be identical to one made in the other. The write
methods are a port of `FolderManager.php`, not a redesign: the same default
name, the same position arithmetic, the same fallback to `manual` for a sort
mode the schema does not know, and the same rule that a null leaves a column
alone. Verified on Unraid 7.3.2 by running the same twelve-step sequence
through both implementations against two copies of one live database and
diffing all four affected tables. They matched.

PHP writes the same tables at the same time, because in GraphQL mode the
container list still goes to `containers.php`, whose GET calls
`reconcileContainerIds()` and `syncComposeStacks()`. So `DatabaseService.write()`
sets `busy_timeout` to the 5000ms `Database.php` uses, and opens each
transaction with `BEGIN IMMEDIATE`. The second part matters: under WAL a
deferred transaction that reads and then writes can fail with
SQLITE_BUSY_SNAPSHOT, which the busy timeout does not retry. Taking the write
lock up front turns the race into a wait. Measured: with the PRAGMA a node
writer waits 2531ms for a PHP `BEGIN IMMEDIATE` and then commits, and without
it the same write fails at 0ms with "database is locked".

Each write also posts to Unraid's nchan server, the way every PHP mutation
does, so a second browser tab and the dashboard widget refetch instead of
waiting for their 30-second poll. GraphQL subscriptions replace this later.

## The `@unraid/shared` problem

`@unraid/shared` is not published to npm. On an Unraid server it is vendored
into the API's own `node_modules`, and `unraid-api plugins install` runs
`npm i --save-peer` in the API's package directory. This plugin therefore lands
beside it and resolves it at runtime as a peer dependency.

Local development has no such luck, so build it from source first:

```bash
npm run vendor:shared        # clones unraid/api at a pinned tag, builds, packs
npm install                  # installs the tarball from vendor/
```

The tarball is not checked in. Change `UNRAID_API_TAG` in
`scripts/vendor-unraid-shared.sh` to follow the API version on your server.

Every peer that `@unraid/shared` declares is a direct dependency of the API
itself, so nothing else needs vendoring for runtime.

## Build

```bash
npm run type-check      # tsc --noEmit, tests included
npm run test            # vitest, against a database built from the real migrations
npm run build           # dist/
npm run validate        # checks the export shape the API enforces
npm run pack:tarball    # dist-pack/unraid-api-plugin-docker-folders-<version>.tgz
```

`npm run validate` mirrors `api/src/unraid-api/plugin/plugin.interface.ts`. An
invalid export shape fails here instead of on the server, where it surfaces
only as an Unraid notification and a line in `/var/log/graphql-api.log`.

## The plugin contract

`src/index.ts` exports `adapter = 'nestjs'` plus `ApiModule` and `CliModule`.
`PluginService` validates that shape with zod, then `PluginModule.register()`
spreads `ApiModule` into the Nest imports array.

Every resolver field needs an explicit `@UsePermissions({ action, resource })`
from `@unraid/shared`, or the API refuses to load the plugin. `Resource` is
upstream's enum and a plugin cannot extend it, so fields use `Resource.DOCKER`.

## Install

Copy the tarball to a persistent path first. Installing from `/tmp` writes a
`peerDependencies` value of `file:../../../tmp/<tarball>`, which does not
survive a reboot.

```bash
# on your workstation
npm run pack:tarball
scp dist-pack/unraid-api-plugin-docker-folders-0.0.1.tgz \
    root@<server>:/boot/config/plugins/unraid-docker-folders-modern/

# on the server
unraid-api plugins install \
    /boot/config/plugins/unraid-docker-folders-modern/unraid-api-plugin-docker-folders-0.0.1.tgz
```

Note the command is `plugins`, plural, on 4.35.1. The path must be absolute:
the command runs `npm i` inside `/usr/local/unraid-api`, so a relative path
resolves there and fails with ENOENT.

### Reinstalling the same version

npm caches a `file:` tarball by name and version, so installing `0.0.1` again
after a rebuild silently keeps the previous code. The symptom is confusing: the
plugin loads, logs its startup line and answers the queries it had before,
while every newly added field reports "Cannot query field". Either bump the
version, or clear the cache first:

```bash
npm cache clean --force
rm -rf /usr/local/unraid-api/node_modules/unraid-api-plugin-docker-folders
cd /usr/local/unraid-api && npm i --save-peer --save-exact /boot/config/plugins/unraid-docker-folders-modern/unraid-api-plugin-docker-folders-0.0.1.tgz
unraid-api restart
```

A release build carries a new version each time, so this only affects
development.

### A note on `unraid-api plugins list`

After installing, the CLI reports "No plugins installed" even though the plugin
is loaded and serving. Measured on 4.35.1: the plugin loads and answers queries
with the `plugins` array in
`/boot/config/plugins/dynamix.my.servers/configs/api.json` holding a tarball
path, and even with that array empty. Only the listing is wrong.

The cause is that `unraid-api plugins install` writes the *tarball path* into
that array while npm writes the *package name* into `peerDependencies`, and
`PluginService.listPlugins()` intersects the two through `parsePackageArg`
(`api/src/utils.ts`), which splits strings on `@` and so never reduces a path
to a name. The intersection is empty, so the listing shows nothing.

Runtime loading does not consult that array, so **no workaround is needed**.
Setting `plugins` to the bare package name makes the listing correct, and
nothing else:

```bash
unraid-api stop
node -e '
  const fs = require("fs");
  const p = "/boot/config/plugins/dynamix.my.servers/configs/api.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.plugins = ["unraid-api-plugin-docker-folders"];
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
'
unraid-api start
```

Trust the checks below over the listing.

## Verify

```bash
unraid-api docker-folders:status # version, database path, folder count
grep -i "FolderService" /var/log/graphql-api.log
```

A `Docker Folders loaded` line in the log is the real evidence. Querying
`dockerFoldersInfo` at `/graphql` without credentials is the other: an
`UNAUTHENTICATED` error means the field is in the schema, while
`GRAPHQL_VALIDATION_FAILED` with "Cannot query field" means it is not.

A line reading `Plugin from ... is invalid` means the export shape was
rejected, which `npm run validate` catches before you get here.

## Auth, for callers

No API key, and nothing to provision. Unraid's nginx serves `location /graphql`
with `allow all`, so it does not gate the endpoint; the API authenticates
internally. `AuthService.validateCookiesWithCsrfToken` wants a valid `unraid_*`
session cookie, which a browser sends on its own, plus a CSRF token in the
`x-csrf-token` header.

Measured: without the header the API answers "Invalid CSRF token". With the
header and no cookie it answers "No user session found". The `csrf_token` query
parameter works the same way.

## Removal

```bash
unraid-api plugins remove unraid-api-plugin-docker-folders
```
