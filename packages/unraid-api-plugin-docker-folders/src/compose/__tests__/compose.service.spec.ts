import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { Observable, type Subscriber } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../../db/database.service.js';
import type { EventBusService } from '../../events/event-bus.service.js';
import { createMigratedDatabase, type TempDatabase } from '../../folders/__tests__/migrate.js';
import { FolderService } from '../../folders/folder.service.js';
import type { ComposePathsConfig } from '../compose-config.js';
import type { ComposeExecResult, ComposeRunner, ComposeRunOptions, ComposeStreamEvent } from '../compose-runner.js';
import type { DockerFoldersComposeStreamEvent } from '../compose.model.js';
import { ComposeService } from '../compose.service.js';

/** One recorded invocation of the fake runner. */
interface RunnerCall {
    args: string[];
    options?: ComposeRunOptions;
}

function ok(overrides: Partial<ComposeExecResult> = {}): ComposeExecResult {
    return { success: true, stdout: '', stderr: '', exitCode: 0, timedOut: false, ...overrides };
}

/**
 * A stand-in for `ComposeRunner` that never spawns a process. Default
 * behavior answers every `docker compose version[...]` call as available
 * (needed by almost every method, which checks availability first) and
 * every other call as a bare success; individual tests override either half
 * for the one command they care about.
 */
function fakeRunner() {
    const calls: RunnerCall[] = [];
    let execImpl: (args: string[], options?: ComposeRunOptions) => ComposeExecResult = (args) => {
        if (args[1] === 'version' && args[2] === '--short') return ok({ stdout: '2.32.4\n' });
        return ok();
    };
    let streamImpl: (args: string[], options?: ComposeRunOptions) => ComposeStreamEvent[] = () => [
        { type: 'result', success: true, exitCode: 0, timedOut: false },
    ];

    const runner: ComposeRunner = {
        async exec(args, options) {
            calls.push({ args, options });
            return execImpl(args, options);
        },
        execStreaming(args, options) {
            calls.push({ args, options });
            const events = streamImpl(args, options);
            return new Observable<ComposeStreamEvent>((subscriber) => {
                for (const event of events) subscriber.next(event);
                subscriber.complete();
            });
        },
    };

    return {
        runner,
        calls,
        setExec: (fn: typeof execImpl) => {
            execImpl = fn;
        },
        setStream: (fn: typeof streamImpl) => {
            streamImpl = fn;
        },
    };
}

function collect(observable: Observable<DockerFoldersComposeStreamEvent>): Promise<DockerFoldersComposeStreamEvent[]> {
    return new Promise((resolve, reject) => {
        const events: DockerFoldersComposeStreamEvent[] = [];
        observable.subscribe({ next: (e) => events.push(e), error: reject, complete: () => resolve(events) });
    });
}

describe('ComposeService', () => {
    let temp: TempDatabase;
    let db: DatabaseService;
    let folders: FolderService;
    let rootDir: string;
    let paths: ComposePathsConfig;
    let fake: ReturnType<typeof fakeRunner>;
    let service: ComposeService;

    beforeEach(() => {
        temp = createMigratedDatabase();
        db = new DatabaseService(temp.path);
        folders = new FolderService(db, { publish: vi.fn() } as unknown as EventBusService);

        rootDir = mkdtempSync(join(tmpdir(), 'compose-service-'));
        paths = {
            configDir: join(rootDir, 'config'),
            stacksDir: join(rootDir, 'config', 'compose-stacks'),
            pluginProjectsDir: join(rootDir, 'plugin-projects'),
            pluginDir: join(rootDir, 'plugin-dir'),
            binaryPath: join(rootDir, 'cli-plugins', 'docker-compose'),
            binaryVersion: '2.32.4',
            binarySha256: 'deadbeef',
        };

        fake = fakeRunner();
        service = new ComposeService(db, folders, fake.runner, paths);
    });

    afterEach(() => {
        temp.cleanup();
        rmSync(rootDir, { recursive: true, force: true });
    });

    function insertStack(row: {
        project_name: string;
        working_dir?: string | null;
        compose_file?: string | null;
        env_file?: string | null;
        autostart?: 0 | 1;
        autostart_force_recreate?: 0 | 1;
    }): void {
        db.write((handle) => {
            handle
                .prepare(
                    `INSERT INTO compose_stacks
                        (project_name, working_dir, compose_file, env_file, autostart,
                         autostart_force_recreate, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`
                )
                .run(
                    row.project_name,
                    row.working_dir ?? null,
                    row.compose_file ?? null,
                    row.env_file ?? null,
                    row.autostart ?? 0,
                    row.autostart_force_recreate ?? 0
                );
        });
    }

    describe('getStatus', () => {
        it('reports available and enabled when compose answers and compose_plugin is absent', async () => {
            const status = await service.getStatus();
            expect(status).toEqual({
                composeAvailable: true,
                composeVersion: '2.32.4',
                composePluginInstalled: false,
                managementEnabled: true,
                composePluginDataExists: false,
            });
        });

        it('reports unavailable with a null version when compose itself fails', async () => {
            fake.setExec(() => ok({ success: false, exitCode: 1 }));
            const status = await service.getStatus();
            expect(status.composeAvailable).toBe(false);
            expect(status.composeVersion).toBeNull();
            expect(status.managementEnabled).toBe(false);
        });

        it('disables management when compose_plugin is installed, even though compose itself is available', async () => {
            mkdirSync(paths.pluginDir, { recursive: true });
            const status = await service.getStatus();
            expect(status.composePluginInstalled).toBe(true);
            expect(status.managementEnabled).toBe(false);
        });
    });

    describe('createStack', () => {
        it('rejects a project name with disallowed characters', () => {
            const result = service.createStack('not a valid name!');
            expect(result).toEqual({
                success: false,
                error: 'Invalid project name. Use only letters, numbers, hyphens, and underscores.',
                projectName: null,
            });
            expect(existsSync(join(paths.stacksDir, 'not a valid name!'))).toBe(false);
        });

        it('creates the stack directory, default compose file, database row, and a folder', () => {
            const result = service.createStack('grafana');
            expect(result).toEqual({ success: true, error: null, projectName: 'grafana' });

            const composeFile = join(paths.stacksDir, 'grafana', 'docker-compose.yml');
            expect(existsSync(composeFile)).toBe(true);
            expect(readFileSync(composeFile, 'utf8')).toContain('services:');

            const row = db.read(
                (handle) =>
                    handle.prepare('SELECT * FROM compose_stacks WHERE project_name = ?').get('grafana') as {
                        working_dir: string;
                        compose_file: string;
                    }
            );
            expect(row.working_dir).toBe(join(paths.stacksDir, 'grafana'));
            expect(row.compose_file).toBe(composeFile);

            const folder = folders.getFolders().find((f) => f.composeProject === 'grafana');
            expect(folder).toBeDefined();
            expect(folder?.icon).toBe('layer-group');
        });

        it('writes provided compose and env content instead of the placeholder', () => {
            service.createStack('withcontent', 'services:\n  app:\n    image: nginx\n', 'A=1\n');
            const composeFile = join(paths.stacksDir, 'withcontent', 'docker-compose.yml');
            const envFile = join(paths.stacksDir, 'withcontent', '.env');
            expect(readFileSync(composeFile, 'utf8')).toContain('nginx');
            expect(readFileSync(envFile, 'utf8')).toBe('A=1\n');
        });

        it('rejects a project name that already has a stack', () => {
            service.createStack('dupe');
            const second = service.createStack('dupe');
            expect(second).toEqual({ success: false, error: "Stack 'dupe' already exists", projectName: null });
        });

        it('does not create a second folder when one already claims the compose project', () => {
            folders.createFolder({ name: 'preexisting', composeProject: 'preowned' });
            service.createStack('preowned');
            const matching = folders.getFolders().filter((f) => f.composeProject === 'preowned');
            expect(matching).toHaveLength(1);
            expect(matching[0].name).toBe('preexisting');
        });
    });

    describe('setAutostart / getStackWorkingDir / setEnvFilePath / setDescription', () => {
        beforeEach(() => insertStack({ project_name: 'demo', working_dir: '/mnt/demo' }));

        it('setAutostart stores both flags', () => {
            service.setAutostart('demo', true, true);
            const row = db.read(
                (handle) =>
                    handle.prepare('SELECT autostart, autostart_force_recreate FROM compose_stacks WHERE project_name = ?').get('demo') as {
                        autostart: number;
                        autostart_force_recreate: number;
                    }
            );
            expect(row).toEqual({ autostart: 1, autostart_force_recreate: 1 });
        });

        it('getStackWorkingDir reads the stored value, or null when unset/unknown', () => {
            expect(service.getStackWorkingDir('demo')).toBe('/mnt/demo');
            expect(service.getStackWorkingDir('missing')).toBeNull();
        });

        it('setEnvFilePath stores exactly what it is given, including null', () => {
            service.setEnvFilePath('demo', '/mnt/demo/custom.env');
            expect(
                db.read((h) => (h.prepare('SELECT env_file FROM compose_stacks WHERE project_name = ?').get('demo') as { env_file: string }).env_file)
            ).toBe('/mnt/demo/custom.env');

            service.setEnvFilePath('demo', null);
            expect(
                db.read((h) => (h.prepare('SELECT env_file FROM compose_stacks WHERE project_name = ?').get('demo') as { env_file: string | null }).env_file)
            ).toBeNull();
        });

        it('setDescription stores the text', () => {
            service.setDescription('demo', 'My stack');
            expect(
                db.read((h) => (h.prepare('SELECT description FROM compose_stacks WHERE project_name = ?').get('demo') as { description: string }).description)
            ).toBe('My stack');
        });
    });

    describe('stack operations build the right argv and cwd', () => {
        let workingDir: string;

        beforeEach(() => {
            workingDir = mkdtempSync(join(tmpdir(), 'compose-stack-cwd-'));
            insertStack({
                project_name: 'demo',
                working_dir: workingDir,
                compose_file: join(workingDir, 'docker-compose.yml'),
                env_file: join(workingDir, '.env'),
            });
        });

        afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

        it('stackUp: -p, -f, --env-file, up -d, --force-recreate, and cwd = working_dir', async () => {
            await service.stackUp('demo', true);
            const call = fake.calls.at(-1)!;
            expect(call.args).toEqual([
                'compose',
                '-p',
                'demo',
                '-f',
                join(workingDir, 'docker-compose.yml'),
                '--env-file',
                join(workingDir, '.env'),
                'up',
                '-d',
                '--force-recreate',
            ]);
            expect(call.options?.cwd).toBe(workingDir);
        });

        it('stackUp without forceRecreate omits the flag', async () => {
            await service.stackUp('demo', false);
            expect(fake.calls.at(-1)!.args).not.toContain('--force-recreate');
        });

        it('does not pass cwd when working_dir does not exist on disk', async () => {
            insertStack({ project_name: 'nodir', working_dir: '/definitely/not/a/real/directory' });
            await service.stackUp('nodir');
            expect(fake.calls.at(-1)!.options?.cwd).toBeUndefined();
        });

        it('stackDown', async () => {
            await service.stackDown('demo');
            expect(fake.calls.at(-1)!.args).toContain('down');
        });

        it('stackStop', async () => {
            await service.stackStop('demo');
            expect(fake.calls.at(-1)!.args).toContain('stop');
        });

        // Ported from 3b09007 (reported to the dev branch): PHP raised
        // up/down/stop/pull to a shared 600s (STACK_COMMAND_TIMEOUT), because
        // an "up -d" that pulls a missing image first can run past the
        // previous 120s (up/down/stop) or 300s (pull) limits. Asserting the
        // literal number, not the constant, so a future edit to the constant
        // without updating the call sites still fails this test.
        it('stackUp, stackDown, stackStop, and stackPull all use a 600s timeout', async () => {
            await service.stackUp('demo');
            expect(fake.calls.at(-1)!.options?.timeoutMs).toBe(600_000);

            await service.stackDown('demo');
            expect(fake.calls.at(-1)!.options?.timeoutMs).toBe(600_000);

            await service.stackStop('demo');
            expect(fake.calls.at(-1)!.options?.timeoutMs).toBe(600_000);

            await service.stackPull('demo');
            expect(fake.calls.at(-1)!.options?.timeoutMs).toBe(600_000);
        });

        it('stackRestart uses a 600s timeout on both its down and up calls', async () => {
            await service.stackRestart('demo');
            const [downCall, upCall] = fake.calls.slice(-2);
            expect(downCall.options?.timeoutMs).toBe(600_000);
            expect(upCall.options?.timeoutMs).toBe(600_000);
        });

        it('stackLogs clamps tail into [1, 5000] and passes --no-color', async () => {
            await service.stackLogs('demo', 999_999);
            expect(fake.calls.at(-1)!.args).toContain('--tail=5000');
            expect(fake.calls.at(-1)!.args).toContain('--no-color');

            await service.stackLogs('demo', 0);
            expect(fake.calls.at(-1)!.args).toContain('--tail=1');
        });

        it('toActionResult merges stdout+stderr into output and carries real stderr as error on failure', async () => {
            fake.setExec((args) =>
                args.includes('down') ? ok({ success: false, exitCode: 1, stdout: 'partial', stderr: 'boom' }) : ok()
            );
            const result = await service.stackDown('demo');
            expect(result.success).toBe(false);
            expect(result.output).toBe('partial\nboom');
            expect(result.error).toBe('boom');
            expect(result.exitCode).toBe(1);
        });

        // ComposeManager.php:624-636's one exception to "error is empty on
        // failure": execCommand's own timeout branch fills `error` with this
        // exact message before the generic return is ever reached.
        // toActionResult previously dropped `ComposeExecResult.timedOut`
        // entirely, so a timed-out up/down/stop/pull reported no reason.
        it('reports PHP\'s timeout message in `error` when the run times out', async () => {
            fake.setExec((args) =>
                args.includes('down')
                    ? ok({ success: false, exitCode: null, timedOut: true, stdout: 'partial', stderr: '' })
                    : ok()
            );
            const result = await service.stackDown('demo');
            expect(result.success).toBe(false);
            expect(result.error).toBe('Command timed out after 600 seconds. It may still be running.');
            expect(result.exitCode).toBe(-1);
        });

        it('stackLogs reports its own 30s timeout, not the 600s stack-command one', async () => {
            fake.setExec((args) => (args.includes('logs') ? ok({ success: false, timedOut: true }) : ok()));
            const result = await service.stackLogs('demo');
            expect(result.error).toBe('Command timed out after 30 seconds. It may still be running.');
        });

        it('stackRestart joins down+up output and short-circuits when down fails', async () => {
            fake.setExec((args) => (args.includes('down') ? ok({ success: false, stdout: 'down failed' }) : ok({ stdout: 'up ok' })));
            const result = await service.stackRestart('demo');
            expect(result.success).toBe(false);
            expect(fake.calls.some((c) => c.args.includes('up'))).toBe(false);
        });

        it('stackRestart runs up after a successful down and joins their output', async () => {
            fake.setExec((args) => (args.includes('down') ? ok({ stdout: 'down ok' }) : ok({ stdout: 'up ok' })));
            const result = await service.stackRestart('demo');
            expect(result.success).toBe(true);
            expect(result.output).toBe('down ok\nup ok');
        });
    });

    describe('stackPs', () => {
        beforeEach(() => insertStack({ project_name: 'demo' }));

        it('returns [] without calling ps when compose is unavailable', async () => {
            fake.setExec(() => ok({ success: false }));
            const ps = await service.stackPs('demo');
            expect(ps).toEqual([]);
            expect(fake.calls.some((c) => c.args.includes('ps'))).toBe(false);
        });

        it('parses NDJSON, one object per line, skipping unparseable ones', async () => {
            fake.setExec((args) =>
                args.includes('ps')
                    ? ok({ stdout: '{"State":"running"}\nnot json\n{"State":"exited"}\n' })
                    : ok()
            );
            const ps = await service.stackPs('demo');
            expect(ps).toEqual([{ State: 'running' }, { State: 'exited' }]);
        });

        it('discards stderr entirely on a ps failure (matching 2>/dev/null)', async () => {
            fake.setExec((args) => (args.includes('ps') ? ok({ success: false, stderr: 'ignored' }) : ok()));
            expect(await service.stackPs('demo')).toEqual([]);
        });
    });

    describe('getAllStacks / getStack', () => {
        it('maps columns, casts booleans, and counts running services from ps', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-list-'));
            try {
                writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n  worker:\n');
                insertStack({
                    project_name: 'demo',
                    working_dir: dir,
                    compose_file: join(dir, 'docker-compose.yml'),
                    autostart: 1,
                    autostart_force_recreate: 1,
                });
                fake.setExec((args) =>
                    args.includes('ps') ? ok({ stdout: '{"State":"running"}\n{"State":"exited"}\n' }) : ok()
                );

                const stacks = await service.getAllStacks();
                expect(stacks).toHaveLength(1);
                expect(stacks[0]).toMatchObject({
                    projectName: 'demo',
                    autostart: true,
                    autostartForceRecreate: true,
                    servicesTotal: 2,
                    servicesRunning: 1,
                    serviceNames: ['web', 'worker'],
                });

                const single = await service.getStack('demo');
                expect(single).toEqual(stacks[0]);

                expect(await service.getStack('nope')).toBeNull();
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('checks for Compose once per list, not once per stack', async () => {
            for (const name of ['alpha', 'beta', 'gamma']) insertStack({ project_name: name });
            fake.setExec((args) => (args.includes('ps') ? ok({ stdout: '{"State":"running"}\n' }) : ok()));
            fake.calls.length = 0;

            const stacks = await service.getAllStacks();

            expect(stacks.map((s) => s.servicesRunning)).toEqual([1, 1, 1]);
            const commands = fake.calls.map((c) => c.args.filter((a) => a === 'version' || a === 'ps').join(''));
            expect(commands).toEqual(['version', 'ps', 'ps', 'ps']);
        });

        it('runs no ps when Compose is missing', async () => {
            insertStack({ project_name: 'alpha' });
            fake.setExec((args) => (args.includes('version') ? { ...ok(), success: false } : ok({ stdout: '{"State":"running"}\n' })));
            fake.calls.length = 0;

            const stacks = await service.getAllStacks();

            expect(stacks[0].servicesTotal).toBe(0);
            expect(fake.calls.some((c) => c.args.includes('ps'))).toBe(false);
        });

        it('reports no service names when compose_file is unset, even if working_dir has one (ported PHP guard)', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-list-'));
            try {
                writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n');
                insertStack({ project_name: 'demo', working_dir: dir, compose_file: null });
                const stack = await service.getStack('demo');
                expect(stack?.serviceNames).toEqual([]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('validateComposeContent', () => {
        it('short-circuits when compose is unavailable', async () => {
            fake.setExec(() => ok({ success: false }));
            const result = await service.validateComposeContent('demo', null);
            expect(result).toEqual({
                success: false,
                output: '',
                errors: [{ line: 1, column: null, message: 'Docker Compose not available' }],
            });
        });

        it('validating provided content uses a temp file and --project-directory, no cwd', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-validate-'));
            try {
                insertStack({ project_name: 'demo', working_dir: dir, env_file: join(dir, '.env') });
                await service.validateComposeContent('demo', 'services: {}\n');

                const call = fake.calls.at(-1)!;
                expect(call.args).toEqual(
                    expect.arrayContaining(['compose', '-p', 'demo', '--env-file', join(dir, '.env'), '--project-directory', dir, 'config', '--quiet'])
                );
                expect(call.options?.cwd).toBeUndefined();

                // The temp file is passed via -f and cleaned up afterward.
                const fIndex = call.args.indexOf('-f');
                const tmpFile = call.args[fIndex + 1];
                expect(existsSync(tmpFile)).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('validating the file on disk uses cwd = working_dir, no --project-directory', async () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-validate-'));
            try {
                insertStack({ project_name: 'demo', working_dir: dir, compose_file: join(dir, 'docker-compose.yml') });
                await service.validateComposeContent('demo', null);

                const call = fake.calls.at(-1)!;
                expect(call.options?.cwd).toBe(dir);
                expect(call.args).not.toContain('--project-directory');
                expect(call.args).toContain(join(dir, 'docker-compose.yml'));
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('parses "line N: message" errors out of the combined output', async () => {
            insertStack({ project_name: 'demo' });
            fake.setExec((args) =>
                args.includes('config')
                    ? ok({ success: false, stderr: 'yaml: line 5: mapping values are not allowed here' })
                    : ok()
            );
            const result = await service.validateComposeContent('demo', 'bad: [\n');
            expect(result.success).toBe(false);
            expect(result.errors).toEqual([{ line: 5, column: 1, message: 'mapping values are not allowed here' }]);
        });

        it('falls back to a line-1 error with no column when nothing matches the regex', async () => {
            insertStack({ project_name: 'demo' });
            fake.setExec((args) => (args.includes('config') ? ok({ success: false, stderr: 'totally unstructured failure' }) : ok()));
            const result = await service.validateComposeContent('demo', 'x');
            expect(result.errors).toEqual([{ line: 1, column: null, message: 'totally unstructured failure' }]);
        });
    });

    describe('exportConfigs', () => {
        it('rejects a relative path', () => {
            const result = service.exportConfigs('relative/dir');
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/absolute/);
        });

        it('rejects a path outside /mnt and configDir', () => {
            const result = service.exportConfigs('/etc/evil');
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/must be under/);
        });

        // A project name comes from a container label, which anyone who can
        // start a container controls. PHP appended it as is.
        it('skips a project name that would climb out of the export directory', () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-src-'));
            try {
                writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
                insertStack({ project_name: '../../escaped', working_dir: dir, compose_file: join(dir, 'docker-compose.yml') });

                const exportDir = join(paths.configDir, 'exported');
                const result = service.exportConfigs(exportDir);

                expect(result.exported).toBe(0);
                expect(result.errors).toEqual(['Skipped ../../escaped: not a valid project name']);
                expect(existsSync(join(paths.configDir, '..', 'escaped'))).toBe(false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('exports every stack\'s compose and env files under an allowed directory', () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-src-'));
            try {
                writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
                writeFileSync(join(dir, '.env'), 'A=1\n');
                insertStack({
                    project_name: 'demo',
                    working_dir: dir,
                    compose_file: join(dir, 'docker-compose.yml'),
                    env_file: join(dir, '.env'),
                });

                const exportDir = join(paths.configDir, 'exported');
                const result = service.exportConfigs(exportDir);

                expect(result).toMatchObject({ success: true, error: null, exported: 1, errors: [] });
                expect(readFileSync(join(exportDir, 'demo', 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
                expect(readFileSync(join(exportDir, 'demo', '.env'), 'utf8')).toBe('A=1\n');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('defaults to stacksDir when no export directory is given', () => {
            insertStack({ project_name: 'demo' });
            const result = service.exportConfigs(undefined);
            expect(result.success).toBe(true);
            expect(result.path).toBe(paths.stacksDir);
        });
    });

    describe('importFromComposePlugin', () => {
        it('fails cleanly when the plugin projects directory does not exist', () => {
            const result = service.importFromComposePlugin();
            expect(result).toEqual({
                success: false,
                stacksImported: 0,
                stacksSkipped: 0,
                errors: ['Compose plugin projects directory not found'],
            });
        });

        it('imports a direct project: copies its files, inserts the stack row, and creates a folder', () => {
            const projectDir = join(paths.pluginProjectsDir, 'legacyapp');
            mkdirSync(projectDir, { recursive: true });
            writeFileSync(join(projectDir, 'name'), 'Legacy App\n');
            writeFileSync(join(projectDir, 'description'), 'An old stack\n');
            writeFileSync(join(projectDir, 'autostart'), 'true\n');
            writeFileSync(join(projectDir, 'docker-compose.yml'), 'services: {}\n');
            writeFileSync(join(projectDir, '.env'), 'A=1\n');

            const result = service.importFromComposePlugin();
            expect(result).toEqual({ success: true, stacksImported: 1, stacksSkipped: 0, errors: [] });

            const row = db.read(
                (h) =>
                    h.prepare('SELECT * FROM compose_stacks WHERE project_name = ?').get('legacyapp') as {
                        autostart: number;
                        description: string;
                        imported_from: string;
                        working_dir: string;
                        compose_file: string;
                        env_file: string;
                    }
            );
            expect(row.autostart).toBe(1);
            expect(row.description).toBe('An old stack');
            expect(row.imported_from).toBe('compose_plugin');
            expect(readFileSync(row.compose_file, 'utf8')).toBe('services: {}\n');
            expect(readFileSync(row.env_file, 'utf8')).toBe('A=1\n');

            const folder = folders.getFolders().find((f) => f.composeProject === 'legacyapp');
            expect(folder?.name).toBe('Legacy App');
        });

        it('follows an indirect project to its real compose location', () => {
            const realDir = mkdtempSync(join(tmpdir(), 'compose-indirect-'));
            try {
                writeFileSync(join(realDir, 'compose.yml'), 'services: {}\n');

                const projectDir = join(paths.pluginProjectsDir, 'pointer');
                mkdirSync(projectDir, { recursive: true });
                writeFileSync(join(projectDir, 'indirect'), realDir);

                const result = service.importFromComposePlugin();
                expect(result.stacksImported).toBe(1);

                const row = db.read(
                    (h) => h.prepare('SELECT compose_file FROM compose_stacks WHERE project_name = ?').get('pointer') as { compose_file: string }
                );
                expect(readFileSync(row.compose_file, 'utf8')).toBe('services: {}\n');
            } finally {
                rmSync(realDir, { recursive: true, force: true });
            }
        });

        it('skips a project whose stack already exists, without touching its files', () => {
            insertStack({ project_name: 'already' });
            mkdirSync(join(paths.pluginProjectsDir, 'already'), { recursive: true });

            const result = service.importFromComposePlugin();
            expect(result).toEqual({ success: true, stacksImported: 0, stacksSkipped: 1, errors: [] });
        });

        it('records a per-project error and keeps going when a compose file fails to copy', () => {
            const projectDir = join(paths.pluginProjectsDir, 'broken');
            mkdirSync(projectDir, { recursive: true });
            // A directory named like a compose file makes `copyFileSync` fail.
            mkdirSync(join(projectDir, 'docker-compose.yml'));

            const result = service.importFromComposePlugin();
            expect(result.success).toBe(true);
            expect(result.stacksImported).toBe(1);
            expect(result.errors).toEqual(['broken: failed to copy compose file']);
        });

        // 31b04c2 (reported to the dev branch): compose.php and
        // compose-stream.php refuse any project name that fails
        // isValidProjectName (a space, a leading dot such as ".git", or over
        // 128 characters), so a stack imported under one could never be
        // started, edited, or deleted again. The import now refuses it too,
        // with PHP's exact message, and never creates its stack directory.
        it('skips a project directory name the compose API could never address again', () => {
            mkdirSync(join(paths.pluginProjectsDir, 'has space'), { recursive: true });
            mkdirSync(join(paths.pluginProjectsDir, '.git'), { recursive: true });
            const tooLong = 'a'.repeat(129);
            mkdirSync(join(paths.pluginProjectsDir, tooLong), { recursive: true });
            // A normal project alongside the bad ones still imports.
            mkdirSync(join(paths.pluginProjectsDir, 'good'), { recursive: true });

            const result = service.importFromComposePlugin();

            expect(result.success).toBe(true);
            expect(result.stacksImported).toBe(1);
            expect(result.stacksSkipped).toBe(0);
            expect(result.errors.sort()).toEqual(
                [
                    'has space: unsupported project name, skipped',
                    '.git: unsupported project name, skipped',
                    `${tooLong}: unsupported project name, skipped`,
                ].sort()
            );
            expect(existsSync(join(paths.stacksDir, 'has space'))).toBe(false);
            expect(existsSync(join(paths.stacksDir, '.git'))).toBe(false);
            expect(existsSync(join(paths.stacksDir, tooLong))).toBe(false);
        });

        // d2011ec (reported to the dev branch): the file copies run before
        // any transaction opens, so a second import can commit the same
        // project in the gap between this run's copy and its insert. The
        // insert phase re-checks right before writing and, finding the row
        // already taken, skips its own insert instead of erroring — and,
        // just as importantly, must not schedule this run's copied files
        // for deletion if something else in the same run later rolls back.
        it('skips its own insert, without deleting its files, when another import commits the project first', () => {
            const projectDir = join(paths.pluginProjectsDir, 'raced');
            mkdirSync(projectDir, { recursive: true });
            writeFileSync(join(projectDir, 'docker-compose.yml'), 'services: {}\n');

            // Simulate a second `importFromComposePlugin()` call committing
            // 'raced' in the gap between this run's own "already imported?"
            // read (phase 1) and its insert (phase 2, inside the write
            // transaction) — the exact race the recheck guards against.
            // `db.read` is called exactly once for this single-entry
            // directory (the phase-1 existing-project check), so the first
            // call is where the race is injected.
            let reads = 0;
            const originalRead = db.read.bind(db);
            vi.spyOn(db, 'read').mockImplementation((work) => {
                const result = originalRead(work);
                if (reads === 0) {
                    reads++;
                    insertStack({ project_name: 'raced' });
                }
                return result;
            });

            try {
                const result = service.importFromComposePlugin();

                expect(result.success).toBe(true);
                expect(result.stacksImported).toBe(0);
                expect(result.stacksSkipped).toBe(1);

                // Its row belongs to the "racing" import (inserted with a
                // null working_dir by `insertStack`), not overwritten by
                // this run.
                const row = db.read(
                    (h) =>
                        h.prepare('SELECT working_dir FROM compose_stacks WHERE project_name = ?').get('raced') as {
                            working_dir: string | null;
                        }
                );
                expect(row.working_dir).toBeNull();

                // This run's own copy is left alone — it is what the
                // racing import's row now points at conceptually (same
                // destination directory), and nothing in this run's own
                // completion path deletes it.
                expect(existsSync(join(paths.stacksDir, 'raced', 'docker-compose.yml'))).toBe(true);
            } finally {
                vi.restoreAllMocks();
            }
        });

        // 9020f94 (reported to the dev branch): if the transaction rolls
        // back for an unrelated reason, cleanup must not delete a project's
        // files once the recheck (above) or a genuine race shows a row
        // committed for it — but it must still delete an ordinary orphan
        // this run created and nothing now owns.
        it('cleanup after a rolled-back import deletes only the files nothing owns', () => {
            const ownedDir = mkdtempSync(join(tmpdir(), 'compose-owned-'));
            const orphanDir = mkdtempSync(join(tmpdir(), 'compose-orphan-'));
            const ownedFile = join(ownedDir, 'docker-compose.yml');
            const orphanFile = join(orphanDir, 'docker-compose.yml');
            writeFileSync(ownedFile, 'services: {}\n');
            writeFileSync(orphanFile, 'services: {}\n');

            insertStack({ project_name: 'owned' });

            const cleanup = (
                service as unknown as {
                    cleanupFailedComposeImport: (
                        plans: {
                            project: string;
                            name: string | null;
                            description: string | null;
                            autostart: boolean;
                            workingDir: string;
                            composeFile: string | null;
                            envFile: string | null;
                            createdDir: boolean;
                            copied: string[];
                        }[]
                    ) => void;
                }
            ).cleanupFailedComposeImport;

            cleanup.call(service, [
                {
                    project: 'owned',
                    name: null,
                    description: null,
                    autostart: false,
                    workingDir: ownedDir,
                    composeFile: ownedFile,
                    envFile: null,
                    createdDir: true,
                    copied: [ownedFile],
                },
                {
                    project: 'orphan',
                    name: null,
                    description: null,
                    autostart: false,
                    workingDir: orphanDir,
                    composeFile: orphanFile,
                    envFile: null,
                    createdDir: true,
                    copied: [orphanFile],
                },
            ]);

            expect(existsSync(ownedFile)).toBe(true);
            expect(existsSync(ownedDir)).toBe(true);
            expect(existsSync(orphanFile)).toBe(false);
            expect(existsSync(orphanDir)).toBe(false);

            rmSync(ownedDir, { recursive: true, force: true });
        });

        // End-to-end complement to the unit test above: a genuine mid-transaction
        // failure, through the real insert phase, over two real projects —
        // one this run creates from nothing ('fresh') and one whose
        // destination file already existed before this run's copy ('kept',
        // 451a330). `db.write` is wrapped so the real per-plan commit logic
        // still runs for real, inside a real `BEGIN IMMEDIATE`/`ROLLBACK`,
        // and then a failure is forced after it — proving the whole
        // transaction, not just the hand-built cleanup unit above, rolls
        // back the DB while leaving 'kept' alone and removing 'fresh'.
        it('a genuine rollback removes what it created and leaves what it only overwrote', () => {
            const freshSrc = join(paths.pluginProjectsDir, 'fresh');
            mkdirSync(freshSrc, { recursive: true });
            writeFileSync(join(freshSrc, 'docker-compose.yml'), 'services: {fresh: {}}\n');

            const keptSrc = join(paths.pluginProjectsDir, 'kept');
            mkdirSync(keptSrc, { recursive: true });
            writeFileSync(join(keptSrc, 'docker-compose.yml'), 'services: {kept: {}}\n');

            // 'kept' already has a destination directory and file before this
            // run — the import overwrites the file but must not be credited
            // with creating either.
            const keptDestDir = join(paths.stacksDir, 'kept');
            mkdirSync(keptDestDir, { recursive: true });
            const keptDestFile = join(keptDestDir, 'docker-compose.yml');
            writeFileSync(keptDestFile, 'services: {old: {}}\n');

            const originalWrite = db.write.bind(db);
            const writeSpy = vi.spyOn(db, 'write').mockImplementation((work) =>
                originalWrite((h) => {
                    work(h);
                    throw new Error('boom');
                })
            );

            try {
                const result = service.importFromComposePlugin();

                expect(result.success).toBe(false);
                expect(result.stacksImported).toBe(0);
                expect(result.errors).toContain('boom');

                // Neither project got a row: the whole transaction rolled back.
                const rows = db.read((h) => h.prepare('SELECT project_name FROM compose_stacks').all());
                expect(rows).toEqual([]);

                // 'fresh': this run created both the directory and the file,
                // so cleanup removes both.
                expect(existsSync(join(paths.stacksDir, 'fresh', 'docker-compose.yml'))).toBe(false);
                expect(existsSync(join(paths.stacksDir, 'fresh'))).toBe(false);

                // 'kept': this run overwrote the file but did not create it or
                // its directory, so cleanup leaves both — with the new content,
                // matching PHP's `@copy` overwrite.
                expect(existsSync(keptDestDir)).toBe(true);
                expect(readFileSync(keptDestFile, 'utf8')).toBe('services: {kept: {}}\n');
            } finally {
                writeSpy.mockRestore();
            }
        });
    });

    describe('autostart hooks', () => {
        it('starts only the stacks with autostart = 1, using their own force_recreate flag', async () => {
            insertStack({ project_name: 'auto', autostart: 1, autostart_force_recreate: 1 });
            insertStack({ project_name: 'manual', autostart: 0 });

            const results = await service.startAutostartStacks();
            expect(Object.keys(results)).toEqual(['auto']);
            expect(fake.calls.some((c) => c.args.includes('-p') && c.args.includes('auto') && c.args.includes('--force-recreate'))).toBe(true);
            expect(fake.calls.some((c) => c.args.includes('manual'))).toBe(false);
        });

        it('does nothing and calls nothing else when compose is unavailable', async () => {
            fake.setExec(() => ok({ success: false }));
            insertStack({ project_name: 'auto', autostart: 1 });
            expect(await service.startAutostartStacks()).toEqual({});
        });

        it('stopAutostartStacks brings down every autostart stack', async () => {
            insertStack({ project_name: 'auto', autostart: 1 });
            const results = await service.stopAutostartStacks();
            expect(results.auto).toBeDefined();
            expect(fake.calls.some((c) => c.args.includes('down'))).toBe(true);
        });
    });

    describe('streaming', () => {
        it('streamStackUp throws synchronously on an invalid project name, before returning an Observable', () => {
            expect(() => service.streamStackUp('bad name!', false)).toThrow(BadRequestException);
        });

        it('emits status, pulling, relayed pull lines, starting, relayed up lines, then complete and done', async () => {
            insertStack({ project_name: 'demo' });
            fake.setStream((args) =>
                args.includes('pull')
                    ? [
                          { type: 'line', stream: 'out', line: 'pulling redis' },
                          { type: 'result', success: true, exitCode: 0, timedOut: false },
                      ]
                    : [
                          { type: 'line', stream: 'out', line: 'Container demo Started' },
                          { type: 'result', success: true, exitCode: 0, timedOut: false },
                      ]
            );

            const events = await collect(service.streamStackUp('demo', false));
            expect(events).toEqual([
                { type: 'status', message: 'Starting demo...' },
                { type: 'phase', phase: 'pulling', message: 'Pulling images...' },
                { type: 'log', stream: 'out', line: 'pulling redis' },
                { type: 'phase', phase: 'starting', message: 'Starting containers...' },
                { type: 'log', stream: 'out', line: 'Container demo Started' },
                { type: 'complete', message: 'demo started successfully', project: 'demo' },
                { type: 'done', finished: true },
            ]);
        });

        it('continues to "up" and reports a pull_warning after a failed pull, never aborting early', async () => {
            insertStack({ project_name: 'demo' });
            fake.setStream((args) =>
                args.includes('pull')
                    ? [{ type: 'result', success: false, exitCode: 1, timedOut: false }]
                    : [{ type: 'result', success: true, exitCode: 0, timedOut: false }]
            );

            const events = await collect(service.streamStackUp('demo', false));
            expect(events.map((e) => e.type)).toEqual(['status', 'phase', 'phase', 'phase', 'complete', 'done']);
            expect(events[2]).toEqual({
                type: 'phase',
                phase: 'pull_warning',
                message: 'Pull finished with warnings, continuing...',
            });
        });

        it('emits an error event (not an Observable error) when up fails', async () => {
            insertStack({ project_name: 'demo' });
            fake.setStream((args) =>
                args.includes('up') ? [{ type: 'result', success: false, exitCode: 3, timedOut: false }] : [{ type: 'result', success: true, exitCode: 0, timedOut: false }]
            );

            const events = await collect(service.streamStackUp('demo', false));
            const errorEvent = events.find((e) => e.type === 'error');
            expect(errorEvent?.message).toBe('Failed to start demo: Exit code 3');
            expect(events.at(-1)).toEqual({ type: 'done', finished: true });
        });

        it('streamStackPull emits only the pull phase, then complete', async () => {
            insertStack({ project_name: 'demo' });
            fake.setStream(() => [
                { type: 'line', stream: 'out', line: 'pulling' },
                { type: 'result', success: true, exitCode: 0, timedOut: false },
            ]);

            const events = await collect(service.streamStackPull('demo'));
            expect(events).toEqual([
                { type: 'status', message: 'Pulling images for demo...' },
                { type: 'phase', phase: 'pulling', message: 'Pulling images...' },
                { type: 'log', stream: 'out', line: 'pulling' },
                { type: 'complete', message: 'Images for demo pulled successfully', project: 'demo' },
                { type: 'done', finished: true },
            ]);
        });
    });

    describe('logStream', () => {
        /**
         * `fakeRunner()`'s `execStreaming` replays a fixed event list and
         * completes synchronously — fine for `streamStackUp`/`streamStackPull`
         * above, but `logStream`'s own behavior (coalescing over time,
         * teardown before the process settles) needs a runner whose
         * Observable stays open until the test drives it, so it is captured
         * here instead of reused from `fake`.
         */
        function controllableRunner() {
            let subscriber: Subscriber<ComposeStreamEvent> | undefined;
            let teardownCalled = false;
            let lastArgs: string[] = [];
            let lastOptions: ComposeRunOptions | undefined;

            const runner: ComposeRunner = {
                async exec() {
                    throw new Error('logStream must not call exec()');
                },
                execStreaming(args, options) {
                    lastArgs = args;
                    lastOptions = options;
                    return new Observable<ComposeStreamEvent>((sub) => {
                        subscriber = sub;
                        return () => {
                            teardownCalled = true;
                        };
                    });
                },
            };

            return {
                runner,
                emit: (event: ComposeStreamEvent) => subscriber?.next(event),
                get args() {
                    return lastArgs;
                },
                get options() {
                    return lastOptions;
                },
                get teardownCalled() {
                    return teardownCalled;
                },
            };
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('runs `logs --no-color --follow --tail=N` with no timeout, same -p/-f/--env-file and cwd as stackLogs', () => {
            insertStack({ project_name: 'demo', working_dir: rootDir, compose_file: `${rootDir}/docker-compose.yml`, env_file: `${rootDir}/.env` });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);

            streamed.logStream('demo', 250).subscribe();

            expect(controllable.args).toEqual([
                'compose',
                '-p',
                'demo',
                '-f',
                `${rootDir}/docker-compose.yml`,
                '--env-file',
                `${rootDir}/.env`,
                'logs',
                '--no-color',
                '--follow',
                '--tail=250',
            ]);
            // timeoutMs: 0 — execStreaming's `timeoutMs > 0 ? setTimeout(...) : null`
            // treats 0 as "no timeout", which is the whole point of passing it
            // for a follow stream meant to run indefinitely.
            expect(controllable.options).toEqual({ cwd: rootDir, timeoutMs: 0 });
        });

        it('clamps tail to 1-5000, matching stackLogs', () => {
            insertStack({ project_name: 'demo' });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);

            streamed.logStream('demo', 999_999).subscribe();

            expect(controllable.args).toContain('--tail=5000');
        });

        it('coalesces lines arriving within one window into a single emission, never emitting empty', () => {
            insertStack({ project_name: 'demo' });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);
            const chunks: string[] = [];
            streamed.logStream('demo').subscribe({ next: (chunk) => chunks.push(chunk) });

            controllable.emit({ type: 'line', stream: 'out', line: 'one' });
            controllable.emit({ type: 'line', stream: 'out', line: 'two' });
            expect(chunks).toEqual([]);

            vi.advanceTimersByTime(150);
            expect(chunks).toEqual(['one\ntwo']);

            controllable.emit({ type: 'line', stream: 'out', line: 'three' });
            vi.advanceTimersByTime(150);
            expect(chunks).toEqual(['one\ntwo', 'three']);
            expect(chunks.every((c) => c !== '')).toBe(true);
        });

        it('flushes a trailing partial buffer and completes normally (not as an Observable error) on a clean exit', () => {
            insertStack({ project_name: 'demo' });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);
            const chunks: string[] = [];
            let completed = false;
            let errored = false;
            streamed.logStream('demo').subscribe({
                next: (chunk) => chunks.push(chunk),
                complete: () => {
                    completed = true;
                },
                error: () => {
                    errored = true;
                },
            });

            controllable.emit({ type: 'line', stream: 'out', line: 'last line' });
            controllable.emit({ type: 'result', success: true, exitCode: 0, timedOut: false });

            expect(chunks).toEqual(['last line']);
            expect(completed).toBe(true);
            expect(errored).toBe(false);
        });

        it('appends one final chunk describing a non-zero exit, then completes normally', () => {
            insertStack({ project_name: 'demo' });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);
            const chunks: string[] = [];
            let completed = false;
            streamed.logStream('demo').subscribe({
                next: (chunk) => chunks.push(chunk),
                complete: () => {
                    completed = true;
                },
            });

            controllable.emit({ type: 'line', stream: 'err', line: 'no configuration file provided' });
            controllable.emit({ type: 'result', success: false, exitCode: 14, timedOut: false });

            expect(chunks).toEqual(['no configuration file provided', '[docker compose logs exited: Exit code 14]']);
            expect(completed).toBe(true);
        });

        it('kills the child on unsubscribe before the process settles, and logs the teardown', () => {
            insertStack({ project_name: 'demo' });
            const controllable = controllableRunner();
            const streamed = new ComposeService(db, folders, controllable.runner, paths);
            const debugSpy = vi.spyOn(
                (streamed as unknown as { logger: { debug: (message: string) => void } }).logger,
                'debug'
            );

            const subscription = streamed.logStream('demo').subscribe();
            expect(controllable.teardownCalled).toBe(false);

            subscription.unsubscribe();

            expect(controllable.teardownCalled).toBe(true);
            expect(debugSpy).toHaveBeenCalledWith('Closed compose log stream for demo');
        });
    });

    describe('file I/O and versioning delegation (exhaustively covered in compose-files.spec.ts)', () => {
        it('round-trips a compose file through the service methods', () => {
            const dir = mkdtempSync(join(tmpdir(), 'compose-io-'));
            try {
                insertStack({ project_name: 'demo', working_dir: dir, compose_file: join(dir, 'docker-compose.yml') });
                const write = service.saveComposeFileContent('demo', 'services: {}\n');
                expect(write.success).toBe(true);
                expect(service.getComposeFileContent('demo').content).toBe('services: {}\n');
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
