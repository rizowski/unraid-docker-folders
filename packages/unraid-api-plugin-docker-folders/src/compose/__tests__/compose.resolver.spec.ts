import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import type { EventBusService } from '../../events/event-bus.service.js';
import type { ComposePathsConfig } from '../compose-config.js';
import type { DockerFoldersComposeStatus, DockerFoldersComposeStreamEvent } from '../compose.model.js';
import { ComposeResolver } from '../compose.resolver.js';
import type { ComposeService } from '../compose.service.js';

/** A fake `streamStackUp`/`streamStackPull`: status, complete, done — in order, synchronously. */
function fakeStream(project: string): Observable<DockerFoldersComposeStreamEvent> {
    return new Observable((subscriber) => {
        subscriber.next({ type: 'status', message: `Starting ${project}...` });
        subscriber.next({ type: 'complete', message: `${project} started successfully`, project });
        subscriber.next({ type: 'done', finished: true });
        subscriber.complete();
    });
}

/** Drains an AsyncIterableIterator into a plain array, for asserting on every emitted value. */
async function drain<T>(iterator: AsyncIterableIterator<T>): Promise<T[]> {
    const values: T[] = [];
    for await (const value of iterator) {
        values.push(value);
    }
    return values;
}

/**
 * A fully mocked `ComposeService` — this suite is only about the resolver's
 * OWN job: the `management_enabled` gate, the per-action publish rules
 * documented on `ComposeResolver`, and the `set_env_path` boundary
 * validation. `ComposeService`'s own logic is covered in
 * `compose.service.spec.ts`.
 */
function fakeComposeService(overrides: Partial<Record<keyof ComposeService, unknown>> = {}) {
    const status: DockerFoldersComposeStatus = {
        composeAvailable: true,
        composeVersion: '2.32.4',
        composePluginInstalled: false,
        managementEnabled: true,
        composePluginDataExists: false,
    };

    const base = {
        getStatus: vi.fn(async () => status),
        stackUp: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        stackDown: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        stackStop: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        stackRestart: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        stackPull: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        createStack: vi.fn(() => ({ success: true, error: null, projectName: 'demo' })),
        importFromComposePlugin: vi.fn(() => ({ success: true, stacksImported: 0, stacksSkipped: 0, errors: [] })),
        saveComposeFileContent: vi.fn(() => ({ success: true, error: null, path: '/mnt/demo/docker-compose.yml' })),
        saveEnvFileContent: vi.fn(() => ({ success: true, error: null, path: '/mnt/demo/.env' })),
        getFileVersionContent: vi.fn(() => ({
            success: true,
            error: null,
            version: { id: 1, file_type: 'compose', file_path: '.versions/1-compose.yml', content_hash: 'h', created_at: 0, content: 'old content' },
        })),
        restoreFileVersion: vi.fn(() => ({ success: true, error: null, path: '/mnt/demo/docker-compose.yml' })),
        getStackWorkingDir: vi.fn(() => '/mnt/demo'),
        setEnvFilePath: vi.fn(() => undefined),
        setAutostart: vi.fn(() => undefined),
        setDescription: vi.fn(() => undefined),
        getComposeFileContent: vi.fn(() => ({ success: true, error: null, content: 'services: {}', path: '/mnt/demo/docker-compose.yml' })),
        getEnvFileContent: vi.fn(() => ({ success: true, error: null, content: '', path: '/mnt/demo/.env' })),
        getFileVersions: vi.fn(() => ({ success: true, error: null, versions: [] })),
        getAllStacks: vi.fn(async () => []),
        getStack: vi.fn(async () => null),
        stackLogs: vi.fn(async () => ({ success: true, output: '', error: null, exitCode: 0 })),
        installComposeBinary: vi.fn(async () => ({ success: true, error: null })),
        exportConfigs: vi.fn(() => ({ success: true, error: null, exported: 0, errors: [], path: '/mnt' })),
        validateComposeContent: vi.fn(async () => ({ success: true, output: '', errors: [] })),
        streamStackUp: vi.fn((project: string) => fakeStream(project)),
        streamStackPull: vi.fn((project: string) => fakeStream(project)),
        logStream: vi.fn(
            () =>
                new Observable<string>((subscriber) => {
                    subscriber.next('tail\n');
                    subscriber.complete();
                })
        ),
        ...overrides,
    };

    return base as unknown as ComposeService;
}

function fakeEventBus() {
    return { publish: vi.fn() } as unknown as EventBusService;
}

const testPaths: ComposePathsConfig = {
    configDir: '/boot/config/plugins/unraid-docker-folders-modern',
    stacksDir: '/boot/config/plugins/unraid-docker-folders-modern/compose-stacks',
    pluginProjectsDir: '/boot/config/plugins/compose.manager/projects',
    pluginDir: '/usr/local/emhttp/plugins/compose.manager',
    binaryPath: '/usr/lib/docker/cli-plugins/docker-compose',
    binaryVersion: '2.32.4',
    binarySha256: 'deadbeef',
};

describe('ComposeResolver', () => {
    describe('management_enabled gate', () => {
        it.each([
            ['bringUpDockerFoldersComposeStack', (r: ComposeResolver) => r.bringUpDockerFoldersComposeStack('demo')],
            ['bringDownDockerFoldersComposeStack', (r: ComposeResolver) => r.bringDownDockerFoldersComposeStack('demo')],
            ['stopDockerFoldersComposeStack', (r: ComposeResolver) => r.stopDockerFoldersComposeStack('demo')],
            ['restartDockerFoldersComposeStack', (r: ComposeResolver) => r.restartDockerFoldersComposeStack('demo')],
            ['pullDockerFoldersComposeStack', (r: ComposeResolver) => r.pullDockerFoldersComposeStack('demo')],
            ['saveDockerFoldersComposeFile', (r: ComposeResolver) => r.saveDockerFoldersComposeFile('demo', 'x')],
            ['saveDockerFoldersComposeEnv', (r: ComposeResolver) => r.saveDockerFoldersComposeEnv('demo', 'x')],
            [
                'restoreDockerFoldersComposeFileVersion',
                (r: ComposeResolver) => r.restoreDockerFoldersComposeFileVersion('demo', 1),
            ],
            ['setDockerFoldersComposeEnvPath', (r: ComposeResolver) => r.setDockerFoldersComposeEnvPath('demo', '')],
            [
                'setDockerFoldersComposeAutostart',
                (r: ComposeResolver) => r.setDockerFoldersComposeAutostart('demo', { enabled: true }),
            ],
        ])('%s throws ForbiddenException when management is disabled, without calling the service action', async (_name, call) => {
            const compose = fakeComposeService({
                getStatus: vi.fn(async () => ({
                    composeAvailable: false,
                    composeVersion: null,
                    composePluginInstalled: true,
                    managementEnabled: false,
                    composePluginDataExists: false,
                })),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            await expect(call(resolver)).rejects.toBeInstanceOf(ForbiddenException);
            expect(events.publish).not.toHaveBeenCalled();
        });

        it('setDockerFoldersComposeDescription is NOT gated — it runs even when management is disabled', async () => {
            const compose = fakeComposeService({
                getStatus: vi.fn(async () => ({
                    composeAvailable: false,
                    composeVersion: null,
                    composePluginInstalled: true,
                    managementEnabled: false,
                    composePluginDataExists: false,
                })),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            expect(resolver.setDockerFoldersComposeDescription('demo', 'text')).toBe(true);
            expect(compose.setDescription).toHaveBeenCalledWith('demo', 'text');
            expect(events.publish).not.toHaveBeenCalled();
        });
    });

    // Ported from compose.php's dev-branch fix (49a9a1b, then 7ded47c;
    // reported to the dev branch): `safePathComponent` plus a 128-character
    // cap, applied at this resolver's boundary via `requireValidProjectName`
    // for every action, and directly via `isValidProjectName` for the stream.
    describe('project-name validation', () => {
        it.each(['.', '..', '.hidden', '-x'])(
            'rejects %j on a gated action, before ever checking management_enabled',
            async (name) => {
                const compose = fakeComposeService({
                    getStatus: vi.fn(async () => ({
                        composeAvailable: false,
                        composeVersion: null,
                        composePluginInstalled: true,
                        managementEnabled: false,
                        composePluginDataExists: false,
                    })),
                });
                const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

                await expect(resolver.bringUpDockerFoldersComposeStack(name)).rejects.toBeInstanceOf(
                    BadRequestException
                );
                expect(compose.getStatus).not.toHaveBeenCalled();
                expect(compose.stackUp).not.toHaveBeenCalled();
            }
        );

        it('accepts a project name with dots, such as one imported from compose.manager', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await resolver.bringUpDockerFoldersComposeStack('my.stack');
            expect(compose.stackUp).toHaveBeenCalledWith('my.stack', false);
        });

        it('accepts a 128-character project name and rejects a 129-character one', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            const name128 = 'a'.repeat(128);
            await resolver.bringUpDockerFoldersComposeStack(name128);
            expect(compose.stackUp).toHaveBeenCalledWith(name128, false);

            const name129 = 'a'.repeat(129);
            await expect(resolver.bringUpDockerFoldersComposeStack(name129)).rejects.toBeInstanceOf(
                BadRequestException
            );
        });

        it('skips validation for an empty project on a non-stream action, matching compose.php', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await resolver.bringUpDockerFoldersComposeStack('');
            expect(compose.stackUp).toHaveBeenCalledWith('', false);
        });

        it('does NOT skip an empty project on the stream, unlike every other action', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await expect(resolver.dockerFoldersComposeStream('', 'up')).rejects.toBeInstanceOf(BadRequestException);
            expect(compose.streamStackUp).not.toHaveBeenCalled();
        });

        it('applies the same rule (safePathComponent + 128-char cap) to the stream', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await expect(resolver.dockerFoldersComposeStream('..', 'up')).rejects.toBeInstanceOf(BadRequestException);

            const name129 = 'a'.repeat(129);
            await expect(resolver.dockerFoldersComposeStream(name129, 'up')).rejects.toBeInstanceOf(
                BadRequestException
            );
        });
    });

    describe('publish semantics', () => {
        it('up publishes compose/up even when the compose command itself failed', async () => {
            const compose = fakeComposeService({
                stackUp: vi.fn(async () => ({ success: false, output: 'oops', error: 'boom', exitCode: 1 })),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            const result = await resolver.bringUpDockerFoldersComposeStack('demo');
            expect(result.success).toBe(false);
            expect(events.publish).toHaveBeenCalledWith('compose', 'up');
        });

        it('save_file publishes only on success, and throws (without publishing) on failure', async () => {
            const events = fakeEventBus();

            const okCompose = fakeComposeService();
            await new ComposeResolver(okCompose, events, testPaths).saveDockerFoldersComposeFile('demo', 'x');
            expect(events.publish).toHaveBeenCalledWith('compose', 'save_file');

            events.publish = vi.fn();
            const failingCompose = fakeComposeService({
                saveComposeFileContent: vi.fn(() => ({ success: false, error: 'disk full', path: null })),
            });
            await expect(
                new ComposeResolver(failingCompose, events, testPaths).saveDockerFoldersComposeFile('demo', 'x')
            ).rejects.toThrow('disk full');
            expect(events.publish).not.toHaveBeenCalled();
        });

        it('restore_version reads the version before restoring and only publishes on success', async () => {
            const compose = fakeComposeService();
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            const result = await resolver.restoreDockerFoldersComposeFileVersion('demo', 1);
            expect(result).toEqual({ content: 'old content', path: '/mnt/demo/docker-compose.yml' });
            expect(events.publish).toHaveBeenCalledWith('compose', 'restore_version');
        });

        it('restore_version throws NotFoundException when the version does not exist, without calling restoreFileVersion', async () => {
            const compose = fakeComposeService({
                getFileVersionContent: vi.fn(() => ({ success: false, error: 'Version not found', version: null })),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            await expect(resolver.restoreDockerFoldersComposeFileVersion('demo', 999)).rejects.toBeInstanceOf(
                NotFoundException
            );
            expect(compose.restoreFileVersion).not.toHaveBeenCalled();
            expect(events.publish).not.toHaveBeenCalled();
        });

        it('create publishes compose/create and folder/updated only on success', () => {
            const events = fakeEventBus();

            const okResolver = new ComposeResolver(fakeComposeService(), events, testPaths);
            okResolver.createDockerFoldersComposeStack({ projectName: 'demo' });
            expect(events.publish).toHaveBeenCalledWith('compose', 'create');
            expect(events.publish).toHaveBeenCalledWith('folder', 'updated');

            events.publish = vi.fn();
            const failingCompose = fakeComposeService({
                createStack: vi.fn(() => ({ success: false, error: 'bad name', projectName: null })),
            });
            new ComposeResolver(failingCompose, events, testPaths).createDockerFoldersComposeStack({
                projectName: 'x',
            });
            expect(events.publish).not.toHaveBeenCalled();
        });

        it('import publishes compose/import only when at least one stack was imported', () => {
            const events = fakeEventBus();

            const noneImported = fakeComposeService({
                importFromComposePlugin: vi.fn(() => ({ success: true, stacksImported: 0, stacksSkipped: 3, errors: [] })),
            });
            new ComposeResolver(noneImported, events, testPaths).importDockerFoldersComposeStacks();
            expect(events.publish).not.toHaveBeenCalled();

            const someImported = fakeComposeService({
                importFromComposePlugin: vi.fn(() => ({ success: true, stacksImported: 2, stacksSkipped: 0, errors: [] })),
            });
            new ComposeResolver(someImported, events, testPaths).importDockerFoldersComposeStacks();
            expect(events.publish).toHaveBeenCalledWith('compose', 'import');
        });

        it('validate and export never publish anything', async () => {
            const compose = fakeComposeService();
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            await resolver.validateDockerFoldersComposeContent('demo', 'x');
            resolver.exportDockerFoldersComposeConfigs();
            await resolver.installDockerFoldersComposeBinary();

            expect(events.publish).not.toHaveBeenCalled();
        });
    });

    describe('setDockerFoldersComposeEnvPath boundary validation', () => {
        it('an empty path clears env_file back to the default', async () => {
            const compose = fakeComposeService();
            const events = fakeEventBus();
            await new ComposeResolver(compose, events, testPaths).setDockerFoldersComposeEnvPath('demo', '   ');
            expect(compose.setEnvFilePath).toHaveBeenCalledWith('demo', null);
            expect(events.publish).toHaveBeenCalledWith('compose', 'set_env_path');
        });

        it('a relative path with no working_dir is rejected', async () => {
            const compose = fakeComposeService({ getStackWorkingDir: vi.fn(() => null) });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            await expect(resolver.setDockerFoldersComposeEnvPath('demo', 'custom.env')).rejects.toBeInstanceOf(
                BadRequestException
            );
        });

        it('a path outside /mnt, stacksDir, and the stack\'s own working_dir is rejected', async () => {
            const compose = fakeComposeService({ getStackWorkingDir: vi.fn(() => '/mnt/demo') });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            await expect(
                resolver.setDockerFoldersComposeEnvPath('demo', '/etc/passwd')
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('a path under the stack\'s own working_dir is allowed even though it is outside /mnt and stacksDir', async () => {
            const compose = fakeComposeService({ getStackWorkingDir: vi.fn(() => '/opt/stacks/demo') });
            const events = fakeEventBus();
            await new ComposeResolver(compose, events, testPaths).setDockerFoldersComposeEnvPath(
                'demo',
                '/opt/stacks/demo/custom.env'
            );
            expect(compose.setEnvFilePath).toHaveBeenCalledWith('demo', '/opt/stacks/demo/custom.env');
        });

        it('a path under /mnt is allowed regardless of working_dir', async () => {
            const compose = fakeComposeService({ getStackWorkingDir: vi.fn(() => null) });
            const events = fakeEventBus();
            await new ComposeResolver(compose, events, testPaths).setDockerFoldersComposeEnvPath(
                'demo',
                '/mnt/user/appdata/demo/.env'
            );
            expect(compose.setEnvFilePath).toHaveBeenCalledWith('demo', '/mnt/user/appdata/demo/.env');
        });

        it('a relative path resolves against the stack\'s working_dir', async () => {
            const compose = fakeComposeService({ getStackWorkingDir: vi.fn(() => '/mnt/user/appdata/demo') });
            const events = fakeEventBus();
            await new ComposeResolver(compose, events, testPaths).setDockerFoldersComposeEnvPath(
                'demo',
                'secrets/.env'
            );
            expect(compose.setEnvFilePath).toHaveBeenCalledWith('demo', '/mnt/user/appdata/demo/secrets/.env');
        });
    });

    describe('read queries', () => {
        it('dockerFoldersComposeFile throws NotFoundException on failure', () => {
            const compose = fakeComposeService({
                getComposeFileContent: vi.fn(() => ({ success: false, error: 'Compose file not found', content: null, path: null })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            expect(() => resolver.dockerFoldersComposeFile('demo')).toThrow(NotFoundException);
        });

        it('dockerFoldersComposeEnv does not throw when the file is simply absent', () => {
            const compose = fakeComposeService({
                getEnvFileContent: vi.fn(() => ({ success: true, error: null, content: '', path: null })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            expect(resolver.dockerFoldersComposeEnv('demo')).toEqual({ content: '', path: '' });
        });

        it('dockerFoldersComposeEnv throws a plain Error on a real read failure', () => {
            const compose = fakeComposeService({
                getEnvFileContent: vi.fn(() => ({ success: false, error: 'Failed to read env file', content: null, path: '/mnt/demo/.env' })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            expect(() => resolver.dockerFoldersComposeEnv('demo')).toThrow('Failed to read env file');
        });

        it('dockerFoldersComposeFileVersions throws BadRequestException on an invalid file type', () => {
            const compose = fakeComposeService({
                getFileVersions: vi.fn(() => ({ success: false, error: 'Invalid file type', versions: [] })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            expect(() => resolver.dockerFoldersComposeFileVersions('demo', 'nope')).toThrow(BadRequestException);
        });

        it('dockerFoldersComposeFileVersion throws NotFoundException when missing', () => {
            const compose = fakeComposeService({
                getFileVersionContent: vi.fn(() => ({ success: false, error: 'Version not found', version: null })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);
            expect(() => resolver.dockerFoldersComposeFileVersion('demo', 999)).toThrow(NotFoundException);
        });
    });

    describe('dockerFoldersComposeStream subscription', () => {
        it('refuses an invalid action before ever checking management_enabled', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await expect(resolver.dockerFoldersComposeStream('demo', 'restart')).rejects.toBeInstanceOf(
                BadRequestException
            );
            expect(compose.getStatus).not.toHaveBeenCalled();
            expect(compose.streamStackUp).not.toHaveBeenCalled();
            expect(compose.streamStackPull).not.toHaveBeenCalled();
        });

        it('refuses an invalid project name before ever checking management_enabled', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await expect(resolver.dockerFoldersComposeStream('bad name!', 'up')).rejects.toBeInstanceOf(
                BadRequestException
            );
            expect(compose.getStatus).not.toHaveBeenCalled();
            expect(compose.streamStackUp).not.toHaveBeenCalled();
        });

        it('refuses when compose management is disabled, without starting a stream', async () => {
            const compose = fakeComposeService({
                getStatus: vi.fn(async () => ({
                    composeAvailable: false,
                    composeVersion: null,
                    composePluginInstalled: true,
                    managementEnabled: false,
                    composePluginDataExists: false,
                })),
            });
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await expect(resolver.dockerFoldersComposeStream('demo', 'up')).rejects.toBeInstanceOf(
                ForbiddenException
            );
            expect(compose.streamStackUp).not.toHaveBeenCalled();
        });

        it('wraps every event as { dockerFoldersComposeStream: {event, data} } and publishes compose/up on the complete event', async () => {
            const compose = fakeComposeService();
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            const iterator = await resolver.dockerFoldersComposeStream('demo', 'up', true);
            const values = await drain(iterator);

            expect(values).toEqual([
                { dockerFoldersComposeStream: { event: 'status', data: JSON.stringify({ message: 'Starting demo...' }) } },
                {
                    dockerFoldersComposeStream: {
                        event: 'complete',
                        data: JSON.stringify({ message: 'demo started successfully', project: 'demo' }),
                    },
                },
                { dockerFoldersComposeStream: { event: 'done', data: JSON.stringify({ finished: true }) } },
            ]);
            expect(compose.streamStackUp).toHaveBeenCalledWith('demo', true);
            expect(events.publish).toHaveBeenCalledTimes(1);
            expect(events.publish).toHaveBeenCalledWith('compose', 'up');
        });

        it('calls streamStackPull, not streamStackUp, for action "pull"', async () => {
            const compose = fakeComposeService();
            const resolver = new ComposeResolver(compose, fakeEventBus(), testPaths);

            await drain(await resolver.dockerFoldersComposeStream('demo', 'pull'));

            expect(compose.streamStackPull).toHaveBeenCalledWith('demo');
            expect(compose.streamStackUp).not.toHaveBeenCalled();
        });

        it('does not publish when the stream never reaches a complete event', async () => {
            const compose = fakeComposeService({
                streamStackUp: vi.fn(
                    () =>
                        new Observable<DockerFoldersComposeStreamEvent>((subscriber) => {
                            subscriber.next({ type: 'error', message: 'Failed to start demo: exit 1' });
                            subscriber.next({ type: 'done', finished: true });
                            subscriber.complete();
                        })
                ),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            await drain(await resolver.dockerFoldersComposeStream('demo', 'up'));

            expect(events.publish).not.toHaveBeenCalled();
        });
    });

    describe('dockerFoldersComposeLogStream subscription', () => {
        it('wraps each chunk as { dockerFoldersComposeLogStream: { output } }, publishing nothing', async () => {
            const compose = fakeComposeService({
                logStream: vi.fn(
                    (project: string, tail: number) =>
                        new Observable<string>((subscriber) => {
                            subscriber.next(`tail for ${project}/${tail}`);
                            subscriber.next('live line');
                            subscriber.complete();
                        })
                ),
            });
            const events = fakeEventBus();
            const resolver = new ComposeResolver(compose, events, testPaths);

            const values = await drain(resolver.dockerFoldersComposeLogStream('demo', 250));

            expect(values).toEqual([
                { dockerFoldersComposeLogStream: { output: 'tail for demo/250' } },
                { dockerFoldersComposeLogStream: { output: 'live line' } },
            ]);
            expect(compose.logStream).toHaveBeenCalledWith('demo', 250);
            expect(events.publish).not.toHaveBeenCalled();
        });
    });
});
