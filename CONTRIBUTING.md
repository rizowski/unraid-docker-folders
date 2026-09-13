# Contributing to Unraid Docker Folders

Thank you for your help. This guide tells you how to set up the project, make a change, and open a pull request.

## Open pull requests against `dev`

Open every pull request against the `dev` branch, not `main`.

- `dev` is the prerelease branch. A push to `dev` publishes a prerelease build.
- `main` is the stable branch. A push to `main` publishes a stable release.
- Changes move from `dev` to `main` after they are tested on an Unraid server.

If you open a pull request against `main` by mistake, click **Edit** next to the pull request title and change the base branch to `dev`.

## Before you start

- For a bug, search the [issues](https://github.com/rizowski/unraid-docker-folders/issues) first. If no issue exists, open one.
- For a new feature, open an issue before you write code. The maintainer can then tell you if the feature fits the plugin.
- Keep each pull request to one change. Small pull requests get a faster review.

## Set up the project

The project has a Vue 3 frontend and a PHP backend.

1. Fork the repository and clone your fork.
2. Create a branch from `dev`:
   ```bash
   git fetch origin
   git switch -c my-change origin/dev
   ```
3. Install Node and yarn. The versions are pinned in `.prototools`. If you use [proto](https://moonrepo.dev/proto), run `proto use` in the repository root.
4. Install the frontend dependencies:
   ```bash
   cd src/frontend
   yarn install --frozen-lockfile
   ```

Use yarn, not npm. `yarn.lock` is the only lockfile, and npm rewrites it.

## Run the app locally

```bash
cd src/frontend
yarn dev
```

The development server uses a mock API (`src/frontend/dev/mock-api.ts`), so you do not need an Unraid server. If your change adds or changes an API field, update the mock API too.

The settings page (`DockerFolders.page`) is PHP and HTML, not Vue. You can only see it on an Unraid server.

## Make sure that your change passes the checks

Run these commands in `src/frontend` before you open a pull request:

```bash
yarn type-check
yarn lint
yarn test:run
yarn build
```

Lint fails on any warning. `yarn lint:fix` fixes some problems for you.

The PHP tests run in Docker, because the project does not need a local PHP install. Run them from the repository root:

```bash
tests/php/run.sh
```

To check the syntax of one PHP file, use the `php:8.2-cli` image:

```bash
docker run --rm -v "$(pwd)":/app -w /app php:8.2-cli php -l path/to/file.php
```

Add or update tests for the code that you change. Frontend tests go in a `__tests__` directory next to the code. PHP tests go in `tests/php/`.

## Follow the project rules

- UI changes: read [DESIGN.md](DESIGN.md) first. The plugin must look native to the Unraid web interface. Use theme tokens only, inline stroke SVG icons, and no emoji.
- API endpoints: read the Security section in [CLAUDE.md](CLAUDE.md). Every endpoint must call `requireAuth()`. A new `PUT` or `DELETE` branch must call `requireCsrf()`.
- Database changes: add a new file in `migrations/` with the next number, for example `015_add_example.sql`. Do not edit a migration that is already released.
- Do not commit build output. Do not commit files from `archive/` or the compiled frontend assets.
- Do not change the version in `unraid-docker-folders-modern.plg` or edit `CHANGELOG.md`. The release workflow updates both.

## Test on Unraid

Some behavior needs a real Unraid server: the live updates, login and CSRF handling, the Docker socket, and persistence across reboots. If your change touches one of these, build a package and install it on a test server:

```bash
./build/build.sh
```

The package is written to `archive/`. Do not run `./build/build.sh --release`. That command commits, tags, and pushes a release.

## Open the pull request

1. Push your branch to your fork.
2. Open a pull request against `dev`.
3. In the description, say what the change does and why. Link the issue, for example `Fixes #12`.
4. Say how you tested the change, and if you tested it on Unraid, give the Unraid version.
5. For a UI change, add screenshots in the dark and the light Unraid themes.

If `dev` changes while your pull request is open, merge `dev` into your branch and run the checks again before you push.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
