import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { createComposeRunner, type ComposeStreamEvent } from '../compose-runner.js';

/**
 * Exercises the REAL runner (spawn/execFile), never the `docker` binary —
 * `createComposeRunner()` takes the binary name, and every test here points
 * it at `process.execPath` running an inline script instead. This is the one
 * spec allowed to touch the real implementation; `compose.service.spec.ts`
 * and every other spec in this module hand `ComposeService` a hand-rolled
 * fake that implements the same `ComposeRunner` interface, so no test in the
 * suite ever shells out to `docker compose`.
 */
function nodeRunner() {
    return createComposeRunner(process.execPath);
}

/** `-e <script>` args for `node`, standing in for `compose`, `-p`, etc. */
function script(code: string): string[] {
    return ['-e', code];
}

describe('RealComposeRunner (via node, never docker)', () => {
    describe('exec', () => {
        it('reports success, stdout, and exit code 0', async () => {
            const result = await nodeRunner().exec(script("process.stdout.write('hi'); process.exit(0);"));
            expect(result).toEqual({ success: true, stdout: 'hi', stderr: '', exitCode: 0, timedOut: false });
        });

        it('reports failure and the real exit code on a non-zero exit', async () => {
            const result = await nodeRunner().exec(
                script("process.stderr.write('boom'); process.exit(7);")
            );
            expect(result.success).toBe(false);
            expect(result.exitCode).toBe(7);
            expect(result.stderr).toContain('boom');
            expect(result.timedOut).toBe(false);
        });

        it('never spawns a shell: a shell metacharacter in argv is inert', async () => {
            // If this ran through /bin/sh -c, the semicolon would start a
            // second command. Through execFile's argv array, it is just one
            // opaque string handed to the script as `process.argv[1]`.
            const marker = 'not-a-command; touch /tmp/should-not-exist-from-test';
            const result = await nodeRunner().exec([
                '-e',
                'process.stdout.write(process.argv[1])',
                marker,
            ]);
            expect(result.stdout).toBe(marker);
        });

        it('kills the process and reports timedOut on a timeout', async () => {
            const result = await nodeRunner().exec(script('setInterval(() => {}, 50);'), { timeoutMs: 200 });
            expect(result.success).toBe(false);
            expect(result.timedOut).toBe(true);
        }, 5000);

        it('passes cwd through to the child process, replacing PHP\'s `cd $dir &&` prefix', async () => {
            const dir = realpathSync(tmpdir());
            const result = await nodeRunner().exec(script('process.stdout.write(process.cwd())'), { cwd: dir });
            expect(result.stdout).toBe(dir);
        });
    });

    describe('execStreaming', () => {
        function collect(events: Observable<ComposeStreamEvent>): Promise<ComposeStreamEvent[]> {
            return new Promise((resolve, reject) => {
                const seen: ComposeStreamEvent[] = [];
                events.subscribe({
                    next: (event) => seen.push(event),
                    error: reject,
                    complete: () => resolve(seen),
                });
            });
        }

        it('emits each stdout/stderr line as its own event, in order per stream, then a success result', async () => {
            const events = await collect(
                nodeRunner().execStreaming(
                    script(
                        "process.stdout.write('out1\\n'); process.stderr.write('err1\\n'); process.stdout.write('out2\\n'); process.exit(0);"
                    )
                )
            );

            // stdout and stderr are two independent pipes: Node delivers
            // 'data' on each as its own OS read completes, so their events
            // can interleave in either relative order. Order WITHIN one
            // stream is still guaranteed and is what matters for parsing.
            const outLines = events.filter((e) => e.type === 'line' && e.stream === 'out');
            const errLines = events.filter((e) => e.type === 'line' && e.stream === 'err');
            expect(outLines).toEqual([
                { type: 'line', stream: 'out', line: 'out1' },
                { type: 'line', stream: 'out', line: 'out2' },
            ]);
            expect(errLines).toEqual([{ type: 'line', stream: 'err', line: 'err1' }]);
            expect(events.at(-1)).toEqual({ type: 'result', success: true, exitCode: 0, timedOut: false });
        });

        it('flushes a final unterminated line on close', async () => {
            const events = await collect(
                nodeRunner().execStreaming(script("process.stdout.write('no-newline'); process.exit(0);"))
            );

            expect(events).toContainEqual({ type: 'line', stream: 'out', line: 'no-newline' });
            expect(events.at(-1)).toEqual({ type: 'result', success: true, exitCode: 0, timedOut: false });
        });

        it('reports a non-zero exit as a failed result, not an Observable error', async () => {
            const events = await collect(nodeRunner().execStreaming(script('process.exit(1);')));
            expect(events.at(-1)).toEqual({ type: 'result', success: false, exitCode: 1, timedOut: false });
        });

        it('kills a hung stream on timeout and reports timedOut', async () => {
            const events = await collect(
                nodeRunner().execStreaming(script('setInterval(() => {}, 50);'), { timeoutMs: 200 })
            );
            expect(events.at(-1)).toEqual({ type: 'result', success: false, exitCode: null, timedOut: true });
        }, 5000);

        it('completes the Observable exactly once even if error and close both could fire', async () => {
            // A script that exits immediately with no output at all still
            // produces exactly one terminal event.
            const events = await collect(nodeRunner().execStreaming(script('process.exit(0);')));
            expect(events).toEqual([{ type: 'result', success: true, exitCode: 0, timedOut: false }]);
        });
    });
});

// Minimal structural type so this spec does not need to import rxjs's
// Observable type just to name it in `collect`'s signature.
type Observable<T> = { subscribe(observer: { next: (v: T) => void; error: (e: unknown) => void; complete: () => void }): void };
