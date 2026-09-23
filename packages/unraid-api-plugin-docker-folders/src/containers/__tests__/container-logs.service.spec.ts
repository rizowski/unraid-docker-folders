import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ContainerLogsService, type ContainerLogsResult } from '../container-logs.service.js';
import type {
    DockerFoldersExtraContainerHandle,
    DockerFoldersExtraDockerClient,
    DockerFoldersFollowLogsOptions,
    DockerFoldersLogsOptions,
} from '../extras-docker-client.js';

function fakeDocker(logsImpl: (options: DockerFoldersLogsOptions) => Promise<Buffer>): DockerFoldersExtraDockerClient {
    return {
        getContainer: () => ({
            inspect: () => Promise.reject(new Error('not used here')),
            // `getLogs()` (the only thing this fake serves) always calls
            // `logs()` with `follow: false`, so `logsImpl` only ever
            // implements that overload; the cast is only to satisfy the
            // two-overload type.
            logs: logsImpl as unknown as DockerFoldersExtraContainerHandle['logs'],
            stats: () => Promise.reject(new Error('not used here')),
        }),
        getImage: () => ({ inspect: () => Promise.reject(new Error('not used here')) }),
        getNetwork: () => ({ inspect: () => Promise.reject(new Error('not used here')) }),
    };
}

/**
 * A fake docker client for `logStream`, where `logs()` is only ever called
 * with `follow: true`. `open` supplies the stream (or a still-pending
 * promise of one, for the "unsubscribe before logs() resolves" case) and can
 * be a fresh `PassThrough` per call, or the same one reused — callers decide.
 */
function fakeFollowDocker(
    open: () => NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>
): DockerFoldersExtraDockerClient {
    function logs(options: DockerFoldersLogsOptions): Promise<Buffer>;
    function logs(options: DockerFoldersFollowLogsOptions): Promise<NodeJS.ReadableStream>;
    function logs(
        options: DockerFoldersLogsOptions | DockerFoldersFollowLogsOptions
    ): Promise<Buffer> | Promise<NodeJS.ReadableStream> {
        if (!options.follow) {
            return Promise.reject<never>(new Error('logStream should only call logs() with follow: true'));
        }
        return Promise.resolve(open());
    }

    return {
        getContainer: () => ({
            inspect: () => Promise.reject(new Error('not used here')),
            logs,
            stats: () => Promise.reject(new Error('not used here')),
        }),
        getImage: () => ({ inspect: () => Promise.reject(new Error('not used here')) }),
        getNetwork: () => ({ inspect: () => Promise.reject(new Error('not used here')) }),
    };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Past the 150ms coalescing window `ContainerLogsService.logStream` uses. */
const PAST_COALESCE_WINDOW_MS = 250;

describe('ContainerLogsService', () => {
    it('returns the formatted, demuxed log tail on success', async () => {
        const service = new ContainerLogsService(
            fakeDocker(async () => Buffer.from('2024-01-01T00:00:00.000000000Z hello\n', 'utf8'))
        );

        const result = await service.getLogs('abc123', 50);

        expect(result).toEqual({ logs: '2024-01-01 00:00:00 hello', error: false, message: null });
    });

    it('passes the clamped tail through to the docker call', async () => {
        let received: DockerFoldersLogsOptions | null = null;
        const service = new ContainerLogsService(
            fakeDocker(async (options) => {
                received = options;
                return Buffer.alloc(0);
            })
        );

        await service.getLogs('abc123', 9999);

        expect(received).toEqual({ stdout: true, stderr: true, timestamps: true, tail: 500, follow: false });
    });

    it('returns an empty, non-error result for a container with no log output', async () => {
        const service = new ContainerLogsService(fakeDocker(async () => Buffer.alloc(0)));

        const result = await service.getLogs('abc123');

        expect(result).toEqual({ logs: '', error: false, message: null });
    });

    it('reports a refused read as an error envelope, not a thrown error', async () => {
        const error = Object.assign(new Error('(HTTP code 404) no such container'), { statusCode: 404 });
        const service = new ContainerLogsService(
            fakeDocker(async () => {
                throw error;
            })
        );

        const result = await service.getLogs('missing');

        expect(result.error).toBe(true);
        expect(result.logs).toBe('');
        expect(result.message).toContain('no such container');
    });

    it('appends the logging-driver hint on a 400', async () => {
        const error = Object.assign(new Error('bad request'), { statusCode: 400 });
        const service = new ContainerLogsService(
            fakeDocker(async () => {
                throw error;
            })
        );

        const result = await service.getLogs('abc123');

        expect(result.error).toBe(true);
        expect(result.message).toContain("logging driver may not support reading logs");
    });
});

describe('ContainerLogsService.logStream', () => {
    it('emits the formatted tail, newest line first, as the first batch — same shape as getLogs', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));
        const emissions: ContainerLogsResult[] = [];

        const sub = service.logStream('abc123', 50).subscribe((result) => emissions.push(result));
        await sleep(0); // let logs() resolve and the 'data' listener attach

        stream.write(
            Buffer.from(
                '2024-01-01T00:00:00.000000000Z first\n2024-01-01T00:00:01.000000000Z second\n',
                'utf8'
            )
        );
        await sleep(PAST_COALESCE_WINDOW_MS);

        expect(emissions).toEqual([
            { logs: '2024-01-01 00:00:01 second\n2024-01-01 00:00:00 first', error: false, message: null },
        ]);

        sub.unsubscribe();
    });

    it('sends an empty first batch for a quiet container, and nothing for an unterminated line', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));
        const emissions: ContainerLogsResult[] = [];

        const sub = service.logStream('abc123').subscribe((result) => emissions.push(result));
        await sleep(PAST_COALESCE_WINDOW_MS);

        expect(emissions).toEqual([{ logs: '', error: false, message: null }]);

        stream.write(Buffer.from('2024-01-01T00:00:00.000000000Z no newline yet', 'utf8'));
        await sleep(PAST_COALESCE_WINDOW_MS);

        expect(emissions).toHaveLength(1);

        sub.unsubscribe();
    });

    it('coalesces later writes into their own batch, separate from the first', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));
        const emissions: ContainerLogsResult[] = [];

        const sub = service.logStream('abc123').subscribe((result) => emissions.push(result));
        await sleep(0);

        stream.write(Buffer.from('2024-01-01T00:00:00.000000000Z first\n', 'utf8'));
        await sleep(PAST_COALESCE_WINDOW_MS);
        expect(emissions).toHaveLength(1);

        stream.write(Buffer.from('2024-01-01T00:00:01.000000000Z second\n', 'utf8'));
        stream.write(Buffer.from('2024-01-01T00:00:02.000000000Z third\n', 'utf8'));
        await sleep(PAST_COALESCE_WINDOW_MS);

        expect(emissions).toHaveLength(2);
        expect(emissions[1]).toEqual({
            logs: '2024-01-01 00:00:02 third\n2024-01-01 00:00:01 second',
            error: false,
            message: null,
        });

        sub.unsubscribe();
    });

    it('flushes any pending lines and completes when the docker stream ends', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));
        const emissions: ContainerLogsResult[] = [];
        let completed = false;

        const sub = service.logStream('abc123').subscribe({
            next: (result) => emissions.push(result),
            complete: () => {
                completed = true;
            },
        });
        await sleep(0);

        stream.write(Buffer.from('2024-01-01T00:00:00.000000000Z last line\n', 'utf8'));
        stream.end();
        // Well under the 150ms coalescing window — `end` must flush immediately, not wait for the timer.
        await sleep(50);

        expect(completed).toBe(true);
        expect(emissions).toEqual([{ logs: '2024-01-01 00:00:00 last line', error: false, message: null }]);

        sub.unsubscribe();
    });

    it('emits a refused envelope and completes when the initial logs() call rejects', async () => {
        const error = Object.assign(new Error('(HTTP code 404) no such container'), { statusCode: 404 });
        const service = new ContainerLogsService(
            fakeFollowDocker(() => Promise.reject(error))
        );
        const emissions: ContainerLogsResult[] = [];
        let completed = false;

        service.logStream('missing').subscribe({
            next: (result) => emissions.push(result),
            complete: () => {
                completed = true;
            },
        });
        await sleep(0);

        expect(completed).toBe(true);
        expect(emissions).toHaveLength(1);
        expect(emissions[0].error).toBe(true);
        expect(emissions[0].logs).toBe('');
        expect(emissions[0].message).toContain('no such container');
    });

    it('emits a refused envelope and completes when the docker stream itself errors', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));
        const emissions: ContainerLogsResult[] = [];
        let completed = false;

        const sub = service.logStream('abc123').subscribe({
            next: (result) => emissions.push(result),
            complete: () => {
                completed = true;
            },
        });
        await sleep(0);

        stream.emit('error', Object.assign(new Error('boom'), { statusCode: 500 }));
        await sleep(10);

        expect(completed).toBe(true);
        expect(emissions).toHaveLength(1);
        expect(emissions[0].error).toBe(true);
        expect(emissions[0].message).toContain('boom');

        sub.unsubscribe();
    });

    it('destroys the docker stream on unsubscribe', async () => {
        const stream = new PassThrough();
        const service = new ContainerLogsService(fakeFollowDocker(() => stream));

        const sub = service.logStream('abc123').subscribe();
        await sleep(0);

        expect(stream.destroyed).toBe(false);
        sub.unsubscribe();

        expect(stream.destroyed).toBe(true);
    });

    it('destroys the stream once logs() resolves, even when unsubscribed first', async () => {
        const stream = new PassThrough();
        let resolveLogs!: (value: NodeJS.ReadableStream) => void;
        const pending = new Promise<NodeJS.ReadableStream>((resolve) => {
            resolveLogs = resolve;
        });
        const service = new ContainerLogsService(fakeFollowDocker(() => pending));

        const sub = service.logStream('abc123').subscribe();
        sub.unsubscribe(); // before logs() has resolved

        expect(stream.destroyed).toBe(false);
        resolveLogs(stream);
        await sleep(10);

        expect(stream.destroyed).toBe(true);
    });
});
