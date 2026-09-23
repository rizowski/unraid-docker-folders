/**
 * Process execution for `docker compose`, ported from `ComposeManager`'s
 * `execCommand` and `execCommandStreaming` (ComposeManager.php:527-757).
 *
 * SECURITY: no shell, ever. PHP builds a single command STRING —
 * `'docker compose -p ' . escapeshellarg($project) . ' ... 2>&1'`, sometimes
 * prefixed with `'cd ' . escapeshellarg($dir) . ' && '` — and hands it to
 * `proc_open()`, which on a string command runs it through `/bin/sh -c`.
 * Every value that reaches that string (project name, file paths, working
 * directory) has to be individually escaped with `escapeshellarg()`, and a
 * missed call anywhere in that chain is a shell injection running as root.
 *
 * Node's `execFile`/`spawn` take the argv as an array and, with `shell:
 * false` (the default for both, set explicitly below anyway), pass it
 * straight to `execve()`. There is no shell to inject into, so there is
 * nothing to escape: `-f`, the project name, and every path are just argv
 * entries. This is the one property this port must not regress, so every
 * value that was `escapeshellarg()`-wrapped in PHP is instead simply an
 * element of the `args` array here.
 *
 * `cwd` replaces PHP's `'cd ' . escapeshellarg($dir) . ' && '` prefix —
 * `child_process`'s own option for "start the child in this directory",
 * rather than a shell built-in.
 */

import { execFile, spawn } from 'node:child_process';
import { Observable } from 'rxjs';

/** Injection token for the `ComposeRunner`. Overridden with a fake in every test. */
export const COMPOSE_RUNNER_TOKEN = 'DOCKER_FOLDERS_COMPOSE_RUNNER';

export interface ComposeRunOptions {
    /** Replaces PHP's `cd $dir &&` prefix. Only ever a stack's `working_dir`. */
    cwd?: string;
    /** Milliseconds. See the two DEFAULT_*_TIMEOUT_MS constants below for why non-streaming and streaming disagree. */
    timeoutMs?: number;
}

export interface ComposeExecResult {
    success: boolean;
    stdout: string;
    stderr: string;
    /** null when the process could not be started or never reported one. */
    exitCode: number | null;
    /** True when the run was killed for exceeding `timeoutMs`. */
    timedOut: boolean;
}

/**
 * One event out of a streamed run.
 *
 * Mirrors the two SSE event families `compose-stream.php` emits from its
 * `$onLine`/`$onPhase` callbacks (`sendSSE('log', ...)`), collapsed to what
 * this layer alone is responsible for: raw output lines and the final exit
 * status. `phase` events ("pulling", "starting", ...) are the caller's
 * concern — they describe which compose subcommand is running, which this
 * runner has no notion of — and are added by `ComposeService`, not here.
 */
export type ComposeStreamEvent =
    | { type: 'line'; stream: 'out' | 'err'; line: string }
    | { type: 'result'; success: boolean; exitCode: number | null; timedOut: boolean };

export interface ComposeRunner {
    /** Run to completion, buffering stdout/stderr in full. `ComposeManager::execCommand`. */
    exec(args: string[], options?: ComposeRunOptions): Promise<ComposeExecResult>;
    /**
     * Run to completion, emitting each output line as it is produced instead
     * of buffering it. `ComposeManager::execCommandStreaming`. The returned
     * Observable is cold: nothing runs until it is subscribed, exactly one
     * process per subscription, and it always completes on its own (a
     * `{type: 'result'}` event immediately followed by `complete()`) — it
     * never errors the Observable itself, so a failed compose command is a
     * value, not an RxJS error.
     */
    execStreaming(args: string[], options?: ComposeRunOptions): Observable<ComposeStreamEvent>;
}

/**
 * PHP's `execCommand($cmd, $timeout = 120)` declares a default of 120 seconds.
 * It used to accept `$timeout` and never read it again past the parameter
 * list; `ef7ead6` (reported to the dev branch) fixed that — a
 * `stream_select()` poll now checks a wall-clock deadline on every iteration
 * and terminates the process past it, returning the "Command timed out after
 * N seconds. It may still be running." message `ComposeService.toActionResult`
 * reproduces (ComposeManager.php:624-636). Every call site passes its own
 * explicit seconds (30s for `validate`/`logs`/`ps`, 600s for
 * `stackUp`/`stackDown`/`stackStop`/`stackPull` as of `3b09007`), so this
 * 120s default is PHP's unused parameter fallback, not a value anything
 * actually runs with.
 *
 * `exec()` enforces `timeoutMs` the same way, via `execFile`'s own `timeout`
 * option, so both backends time a stuck `docker compose` out on the same
 * budget instead of relying on PHP-FPM's `max_execution_time` (which this
 * port, a long-lived Node process rather than a request-scoped worker, has
 * no equivalent of anyway).
 */
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * `execCommandStreaming`'s default (ComposeManager.php:674), which — unlike
 * `execCommand`'s — is actually enforced (`stream_select` polls a wall-clock
 * check on every iteration). Kept identical here.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 600_000;

/**
 * A stack's compose file, logs, or `ps` output are ordinary text with no
 * fixed upper bound. PHP's `proc_open` pipes never truncate; Node's
 * `execFile` buffers into a fixed-size buffer and throws once it is
 * exceeded, so this is set generously rather than left at the 1 MB default,
 * which a multi-service `logs --tail=5000` can exceed easily.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * The real runner. Always spawns `binary` (in production, `docker`) with the
 * given argv, e.g. `['compose', '-p', 'myproject', 'up', '-d']` — the caller
 * is responsible for supplying `'compose'` as the first element, since this
 * class has no opinion about what command it runs; that keeps it exercisable
 * in tests without ever touching the real `docker` binary.
 */
export function createComposeRunner(binary = 'docker'): ComposeRunner {
    return new RealComposeRunner(binary);
}

class RealComposeRunner implements ComposeRunner {
    constructor(private readonly binary: string) {}

    exec(args: string[], options: ComposeRunOptions = {}): Promise<ComposeExecResult> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;

        return new Promise((resolve) => {
            execFile(
                this.binary,
                args,
                {
                    cwd: options.cwd,
                    timeout: timeoutMs,
                    maxBuffer: MAX_BUFFER_BYTES,
                    killSignal: 'SIGTERM',
                    // Explicit even though execFile never spawns a shell by
                    // default — this is the property the whole module exists
                    // to guarantee, so it is asserted rather than assumed.
                    shell: false,
                },
                (error, stdout, stderr) => {
                    if (error === null) {
                        resolve({ success: true, stdout, stderr, exitCode: 0, timedOut: false });
                        return;
                    }

                    const nodeError = error as NodeJS.ErrnoException & {
                        code?: number | string;
                        killed?: boolean;
                        signal?: string | null;
                    };

                    resolve({
                        success: false,
                        stdout: stdout ?? '',
                        stderr: stderr ?? '',
                        exitCode: typeof nodeError.code === 'number' ? nodeError.code : null,
                        // execFile kills with `killSignal` on timeout and sets
                        // `killed`, which is otherwise only set by an explicit
                        // kill nothing here performs — a reliable signal.
                        timedOut: nodeError.killed === true,
                    });
                }
            );
        });
    }

    execStreaming(args: string[], options: ComposeRunOptions = {}): Observable<ComposeStreamEvent> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
        const binary = this.binary;

        return new Observable<ComposeStreamEvent>((subscriber) => {
            const child = spawn(binary, args, { cwd: options.cwd, shell: false });

            let settled = false;
            let timedOut = false;
            const buffers: { out: string; err: string } = { out: '', err: '' };

            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          timedOut = true;
                          child.kill('SIGTERM');
                      }, timeoutMs)
                    : null;

            /** Split a growing buffer on "\n", emitting each complete line. Mirrors PHP's byte-buffer loop (ComposeManager.php:709-721). */
            const onChunk = (stream: 'out' | 'err') => (chunk: Buffer) => {
                buffers[stream] += chunk.toString('utf8');
                let newlineIndex: number;
                while ((newlineIndex = buffers[stream].indexOf('\n')) !== -1) {
                    const line = buffers[stream].slice(0, newlineIndex).replace(/\r$/, '');
                    buffers[stream] = buffers[stream].slice(newlineIndex + 1);
                    if (line !== '') subscriber.next({ type: 'line', stream, line });
                }
            };
            child.stdout.on('data', onChunk('out'));
            child.stderr.on('data', onChunk('err'));

            const finish = (success: boolean, exitCode: number | null) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);

                // Flush whatever partial line is left unterminated, the way
                // PHP drains its buffers once `proc_get_status` reports the
                // process is no longer running (ComposeManager.php:724-741).
                for (const stream of ['out', 'err'] as const) {
                    if (buffers[stream] !== '') {
                        subscriber.next({ type: 'line', stream, line: buffers[stream].replace(/\r$/, '') });
                        buffers[stream] = '';
                    }
                }

                subscriber.next({ type: 'result', success, exitCode, timedOut });
                subscriber.complete();
            };

            child.on('error', () => finish(false, null));
            child.on('close', (code) => finish(!timedOut && code === 0, code));

            // Unsubscribe (the caller went away) kills a still-running child
            // rather than leaking it, which proc_open-based PHP never has to
            // consider since each request is its own process.
            return () => {
                if (timer) clearTimeout(timer);
                if (!settled) child.kill('SIGTERM');
            };
        });
    }
}
