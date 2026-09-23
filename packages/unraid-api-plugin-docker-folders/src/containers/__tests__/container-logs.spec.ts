import { describe, expect, it } from 'vitest';

import { LogStreamDecoder, clampTail, demuxLogStream, formatLogStream, looksMultiplexed } from '../container-logs.js';

/** One Docker multiplexed frame: 8-byte header (stream type + reserved + big-endian size) plus payload. */
function frame(streamType: number, payload: string): Buffer {
    const body = Buffer.from(payload, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt8(streamType, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

describe('clampTail', () => {
    it('defaults to 50 when absent', () => {
        expect(clampTail(undefined)).toBe(50);
        expect(clampTail(null)).toBe(50);
    });

    it('clamps below the minimum to 1', () => {
        expect(clampTail(0)).toBe(1);
        expect(clampTail(-5)).toBe(1);
    });

    it('clamps above the maximum to 500', () => {
        expect(clampTail(1000)).toBe(500);
    });

    it('passes an in-range value through', () => {
        expect(clampTail(250)).toBe(250);
    });

    it('truncates a float toward zero, like PHP (int)', () => {
        expect(clampTail(3.9)).toBe(3);
    });
});

describe('looksMultiplexed', () => {
    it('is true for a well-formed frame header', () => {
        expect(looksMultiplexed(frame(1, 'hello'))).toBe(true);
    });

    it('is false for fewer than 8 bytes', () => {
        expect(looksMultiplexed(Buffer.from('short'))).toBe(false);
    });

    it('is false when the stream-type byte exceeds 2', () => {
        const buf = frame(1, 'hello');
        buf[0] = 3;
        expect(looksMultiplexed(buf)).toBe(false);
    });

    it('is false when the reserved bytes are not NUL', () => {
        const buf = frame(1, 'hello');
        buf[1] = 1;
        expect(looksMultiplexed(buf)).toBe(false);
    });

    it('is false for a zero-length payload', () => {
        expect(looksMultiplexed(frame(1, ''))).toBe(false);
    });

    it('is false for a raw TTY stream beginning with a timestamp digit', () => {
        // '2' is 0x32, which fails the stream-type test (must be <= 2 as a byte value... it IS 0x32=50 > 2).
        expect(looksMultiplexed(Buffer.from('2024-01-01T00:00:00.000000000Z hello\n', 'utf8'))).toBe(false);
    });
});

describe('demuxLogStream', () => {
    it('strips a single frame header', () => {
        expect(demuxLogStream(frame(1, 'hello')).toString('utf8')).toBe('hello');
    });

    it('concatenates multiple frames in order', () => {
        const buf = Buffer.concat([frame(1, 'first '), frame(2, 'second')]);
        expect(demuxLogStream(buf).toString('utf8')).toBe('first second');
    });

    it('drops a truncated final frame rather than partially reading it', () => {
        const good = frame(1, 'complete');
        const header = Buffer.alloc(8);
        header.writeUInt32BE(100, 4); // declares 100 bytes, but none follow
        const buf = Buffer.concat([good, header]);

        expect(demuxLogStream(buf).toString('utf8')).toBe('complete');
    });
});

describe('formatLogStream', () => {
    it('demuxes, simplifies timestamps, and reverses lines newest-first', () => {
        const buf = Buffer.concat([
            frame(1, '2024-01-01T00:00:00.123456789Z first message\n'),
            frame(1, '2024-01-01T00:00:01.987654321Z second message\n'),
        ]);

        expect(formatLogStream(buf, 'UTC')).toBe(
            '2024-01-01 00:00:01 second message\n2024-01-01 00:00:00 first message'
        );
    });

    it('passes a raw (TTY) stream through without demuxing', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z hello\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 hello');
    });

    it('normalises CRLF to LF', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z one\r\n2024-01-01T00:00:01.000000000Z two\r\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:01 two\n2024-01-01 00:00:00 one');
    });

    it('strips CSI escape sequences, including private-parameter forms', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z \x1b[?25l\x1b[32mGreen\x1b[0m\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 Green');
    });

    it('strips an OSC title sequence terminated by BEL', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z \x1b]0;My Title\x07Visible\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 Visible');
    });

    it('strips an OSC title sequence terminated by ST (ESC backslash)', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z \x1b]0;My Title\x1b\\Visible\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 Visible');
    });

    /**
     * Regression test for a divergence found while porting: PCRE's `.`
     * matches `\r`, so PHP's greedy `.*\r` backtracks across every embedded
     * CR on a line to the LAST one, keeping only the text after it — the same
     * thing a terminal would show after two in-place rewrites. A naive JS
     * translation using `.` (which never matches a line terminator) only
     * matches the FIRST `\r`, and the multiline `^` anchor then refuses to
     * match again mid-line, leaking the middle segment into the output. This
     * asserts the two-CR case collapses to the same single visible segment
     * PHP would produce.
     */
    it('collapses multiple carriage returns on one line to the text after the last one', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z progress1\rprogress2\rprogress3\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 progress3');
    });

    it('keeps a timestamped prefix while collapsing a CR-rewritten line', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z 10%\r50%\r100% done\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 100% done');
    });

    it("strips Docker's own prefix when the log line already carries its own timestamp", () => {
        const raw = Buffer.from(
            '2024-01-01T00:00:00.000000000Z 2024-06-01 10:00:00 something happened\n',
            'utf8'
        );

        expect(formatLogStream(raw, 'UTC')).toBe('2024-06-01 10:00:00 something happened');
    });

    it('leaves a line with no timestamp of its own untouched apart from the reversal', () => {
        const raw = Buffer.from('2024-01-01T00:00:00.000000000Z plain application log line\n', 'utf8');

        expect(formatLogStream(raw, 'UTC')).toBe('2024-01-01 00:00:00 plain application log line');
    });
});

describe('Docker line stamps in the server zone', () => {
    // Docker stamps in UTC. A line with its own local timestamp loses Docker's
    // stamp, so Docker's must be local too, or the pane jumps between clocks.
    const raw = Buffer.from(
        [
            '2026-09-09T05:29:29.100000000Z [info] Attempting to start Privoxy...',
            '2026-09-09T05:29:30.200000000Z 2026-09-08 23:29:30,822 DEBG watchdog output',
            '2026-09-09T05:29:30.300000000Z [info] Privoxy process started',
            '',
        ].join('\n'),
    );

    it('shows Docker stamps in the given zone, newest first', () => {
        expect(formatLogStream(raw, 'America/Denver').split('\n')).toEqual([
            '2026-09-08 23:29:30 [info] Privoxy process started',
            '2026-09-08 23:29:30,822 DEBG watchdog output',
            '2026-09-08 23:29:29 [info] Attempting to start Privoxy...',
        ]);
    });

    it('keeps UTC when the server is UTC', () => {
        expect(formatLogStream(raw, 'UTC').split('\n')[2]).toBe('2026-09-09 05:29:29 [info] Attempting to start Privoxy...');
    });

    it('converts only the stamp at the start of the line', () => {
        const line = Buffer.from('2026-09-09T05:29:29.1Z build 2026-09-09T05:00:00.5Z\n');
        expect(formatLogStream(line, 'America/Denver')).toBe('2026-09-08 23:29:29 build 2026-09-09 05:00:00');
    });

    it('does the same in the follow decoder', () => {
        const decoder = new LogStreamDecoder('America/Denver');
        expect(decoder.push(Buffer.from('2026-09-09T05:29:29.1Z hello\n'))).toEqual(['2026-09-08 23:29:29 hello']);
    });
});

describe('LogStreamDecoder', () => {
    it('returns nothing until a line completes', () => {
        const decoder = new LogStreamDecoder('UTC');
        expect(decoder.push(Buffer.from('no newline yet', 'utf8'))).toEqual([]);
    });

    it('reassembles a multiplexed frame header split across chunks, waiting for the payload', () => {
        const full = frame(1, 'hello\n');
        const decoder = new LogStreamDecoder('UTC');

        // First 5 of the 8 header bytes: not enough to decide framing yet.
        expect(decoder.push(full.subarray(0, 5))).toEqual([]);
        // Completes the header (8 bytes total seen) but the payload hasn't arrived.
        expect(decoder.push(full.subarray(5, 8))).toEqual([]);
        // Payload (+ its newline) arrives last.
        expect(decoder.push(full.subarray(8))).toEqual(['hello']);
    });

    it('reassembles a multiplexed frame payload split across chunks', () => {
        const full = frame(1, 'hello world\n');
        const decoder = new LogStreamDecoder('UTC');
        const header = full.subarray(0, 8);
        const payloadPart1 = full.subarray(8, 11);
        const payloadPart2 = full.subarray(11);

        expect(decoder.push(header)).toEqual([]);
        expect(decoder.push(payloadPart1)).toEqual([]);
        expect(decoder.push(payloadPart2)).toEqual(['hello world']);
    });

    it('holds a line pending across chunks until its newline arrives', () => {
        const full = frame(1, 'no newline yet more text\n');
        const decoder = new LogStreamDecoder('UTC');
        const splitAt = 8 + 10; // header + "no newline" (10 bytes, no \n in this prefix)

        expect(decoder.push(full.subarray(0, splitAt))).toEqual([]);
        expect(decoder.push(full.subarray(splitAt))).toEqual(['no newline yet more text']);
    });

    it('decodes a multi-byte UTF-8 character split across chunks', () => {
        const raw = Buffer.from('hello 日 done\n', 'utf8');
        const decoder = new LogStreamDecoder('UTC');

        // First 8 bytes: "hello " (6 bytes) plus the first 2 of "日"'s 3 UTF-8 bytes.
        expect(decoder.push(raw.subarray(0, 8))).toEqual([]);
        expect(decoder.push(raw.subarray(8))).toEqual(['hello 日 done']);
    });

    it('passes raw TTY bytes through without demuxing, across chunks', () => {
        const decoder = new LogStreamDecoder('UTC');
        const raw = Buffer.from('first tty line\nsecond tty line\n', 'utf8');
        const mid = 10; // arbitrary split point, not aligned to a line boundary

        expect(decoder.push(raw.subarray(0, mid))).toEqual([]);
        expect(decoder.push(raw.subarray(mid))).toEqual(['first tty line', 'second tty line']);
    });

    it('demuxes stdout and stderr frames arriving in sequence', () => {
        const decoder = new LogStreamDecoder('UTC');
        const chunk = Buffer.concat([frame(1, 'out line\n'), frame(2, 'err line\n')]);

        expect(decoder.push(chunk)).toEqual(['out line', 'err line']);
    });

    it('formats a line identically whether read through formatLogStream or the incremental decoder', () => {
        const buf = Buffer.concat([
            frame(1, '2024-01-01T00:00:00.123456789Z first message\n'),
            frame(1, '2024-01-01T00:00:01.987654321Z second message\n'),
        ]);
        const decoder = new LogStreamDecoder('UTC');

        const lines = decoder.push(buf);

        // decoder returns oldest-first (arrival order); formatLogStream returns newest-first.
        expect(lines.slice().reverse().join('\n')).toBe(formatLogStream(buf, 'UTC'));
    });
});
