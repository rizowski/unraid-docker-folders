/**
 * Turn a raw `/containers/{id}/logs` response into display-ready text, newest
 * line first. Ported from `DockerClient::formatLogStream`,
 * `looksMultiplexed`, and `demuxLogStream`.
 *
 * Pure (no socket access), the same reason `container-facts.ts` is: it can be
 * exercised against byte fixtures without a Docker socket.
 *
 * Operates on a `Buffer`, not a string, until the very last step. Docker's
 * multiplexed frame size is a byte count, and a container's log line can
 * legitimately contain multi-byte UTF-8 sequences that must not be split
 * mid-character while framing is still being parsed.
 *
 * Also exports `LogStreamDecoder`, the incremental counterpart used by
 * `ContainerLogsService.logStream` for a `follow: true` stream: the same
 * per-line formatting as `formatLogStream` (see `formatOneLine` below),
 * applied to lines that complete one chunk at a time instead of arriving as
 * one whole buffer.
 */

import { formatInTimeZone } from '../util/timezone.js';

/** PHP clamps `tail` to this range and defaults to 50. `containers.php:63`. */
const MIN_TAIL = 1;
const MAX_TAIL = 500;
const DEFAULT_TAIL = 50;

/** `max(1, min(500, (int)$tail))`, default 50 when `tail` was never sent. */
export function clampTail(tail: number | null | undefined): number {
    if (tail === null || tail === undefined || Number.isNaN(tail)) return DEFAULT_TAIL;
    // PHP's (int) cast on a float truncates toward zero, not rounds.
    const truncated = Math.trunc(tail);
    return Math.max(MIN_TAIL, Math.min(MAX_TAIL, truncated));
}

/**
 * Does this response use Docker's multiplexed framing?
 *
 * Docker only frames the log stream when the container was created *without*
 * a TTY. Because logs are always requested with `timestamps=1`, a raw (TTY)
 * stream begins with the ASCII digit of the year (`0x32`), which fails the
 * stream-type test below; a framed stream begins with `0x00`-`0x02` followed
 * by three NUL bytes. Real log text cannot plausibly start that way.
 */
export function looksMultiplexed(raw: Buffer): boolean {
    if (raw.length < 8) return false;

    // byte 0: stream type (0 = stdin, 1 = stdout, 2 = stderr)
    if (raw[0] > 2) return false;

    // bytes 1-3: reserved, always NUL
    if (raw[1] !== 0 || raw[2] !== 0 || raw[3] !== 0) return false;

    // bytes 4-7: payload size (big-endian uint32)
    return raw.readUInt32BE(4) > 0;
}

/**
 * Strip Docker's 8-byte multiplexed stream headers, concatenating payloads.
 *
 * Mirrors `DockerClient::demuxLogStream`'s bounds check exactly: a frame
 * whose declared size runs past the end of the buffer (a truncated final
 * frame) is dropped rather than partially read.
 */
export function demuxLogStream(raw: Buffer): Buffer {
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset + 8 <= raw.length) {
        const frameSize = raw.readUInt32BE(offset + 4);
        offset += 8;
        if (frameSize > 0 && offset + frameSize <= raw.length) {
            chunks.push(raw.subarray(offset, offset + frameSize));
        }
        offset += frameSize;
    }

    return Buffer.concat(chunks);
}

/** Docker's simplified timestamp prefix is exactly this many characters. */
const TIMESTAMP_PREFIX_LENGTH = 20;

/** A log line that already carries its own timestamp in one of these shapes. */
const OWN_TIMESTAMP_PREFIX =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (\d{4}[-/]|\d{2}:\d{2}|\[\d{4}[-/]|\d{2}[-/]\w{3}[-/])/;

/** Strip terminal escape sequences: CSI (including private-parameter forms
 * like \x1b[?25l, which TTY containers emit constantly) and OSC title
 * sequences terminated by BEL or ST (ESC \). */
const ESCAPE_SEQUENCE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** RFC3339Nano UTC timestamps, shown as YYYY-MM-DD HH:MM:SS. */
const TIMESTAMP_SIMPLIFY_RE = /(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.\d+Z/g;

// A bare CR rewrites the current line in a terminal, so keep only what a
// terminal would leave visible. Docker timestamps each *write*, not each
// CR-separated segment, so the prefix is captured and put back, otherwise
// progress lines come out untimestamped among timestamped neighbours.
//
// `[^\n]` here, not `.` (the literal PHP source): PCRE's `.` matches `\r`
// by default, so PHP's greedy `.*\r` backtracks across embedded CRs to the
// LAST one on the line. JS's `.` never matches a line terminator,
// including `\r`, so the same pattern written with `.` would stop at the
// FIRST `\r` and, worse, the `^` anchor (multiline) would then refuse to
// match again mid-line, silently leaving every earlier "frame" of a
// multi-CR progress line in the output. `[^\n]` matches `\r` again, which
// restores the PHP greedy-to-last-CR behaviour.
//
// Applied per line (below), so the `m` flag and `^` anchor only ever see a
// single line's worth of text — kept anyway so this regex reads the same
// whether it runs over one line or, in principle, a whole blob.
const CR_REWRITE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?[^\n]*\r/gm;

/**
 * Format one already line-delimited (no `\n`), already UTF-8-decoded log
 * line: CRLF's trailing `\r` stripped, escape sequences stripped, Docker's
 * timestamp simplified, a CR-rewrite collapsed, and Docker's own timestamp
 * prefix removed when the line already carries one of its own. Order matches
 * `formatLogStream`'s original whole-blob pipeline exactly (escape strip,
 * then timestamp simplify, then CR-rewrite, then own-prefix strip); none of
 * those four steps can observe or change a `\n` that isn't there, so applying
 * them one line at a time — instead of once over the whole demuxed blob —
 * produces byte-identical output. This is what makes the step reusable by
 * `LogStreamDecoder`, which only ever has one complete line at a time.
 *
 * The CRLF normalisation `formatLogStream` used to do as a whole-blob
 * `/\r\n/g` replace is folded in here as "strip one trailing `\r`": since
 * `\n` only ever occurs as a line delimiter, a `\r\n` pair's `\r` can only
 * ever be the last byte of the line that precedes it, so a whole-blob
 * "replace every `\r\n` with `\n`" and a per-line "drop a trailing `\r`" are
 * the same operation.
 */
function formatOneLine(rawLine: string, timeZone: string): string {
    const withoutTrailingCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    let line = withoutTrailingCr.replace(ESCAPE_SEQUENCE_RE, '');
    // Docker's own stamp starts the line, in UTC. Show it in the server's
    // zone, as PHP does, so it reads in order beside lines whose own local
    // timestamp replaces it. Any other stamp keeps its UTC time.
    line = line.replace(TIMESTAMP_SIMPLIFY_RE, (_match, date: string, time: string, offset: number) =>
        offset === 0 ? formatInTimeZone(new Date(`${date}T${time}Z`), timeZone) : `${date} ${time}`
    );
    line = line.replace(CR_REWRITE_RE, '$1');
    return OWN_TIMESTAMP_PREFIX.test(line) ? line.slice(TIMESTAMP_PREFIX_LENGTH) : line;
}

/** `timeZone` is the zone Docker's line stamps are shown in, `detectServerTimezone()` in production. */
export function formatLogStream(raw: Buffer, timeZone: string): string {
    const demuxed = looksMultiplexed(raw) ? demuxLogStream(raw) : raw;
    const text = demuxed.toString('utf8').replace(/\n+$/, '');

    if (text.length === 0) {
        return '';
    }

    const lines = text.split('\n').map((line) => formatOneLine(line, timeZone));
    return lines.reverse().join('\n');
}

/**
 * Incremental counterpart to `formatLogStream`, for a `follow: true` log
 * stream (`ContainerLogsService.logStream`). Docker hands a followed stream
 * to the caller as arbitrary chunks — a chunk boundary can land inside the
 * 8-byte multiplexed frame header, inside a frame's payload, mid-line, or
 * mid-UTF-8-codepoint — so this buffers whatever isn't yet a complete,
 * decodable line and only ever returns newly-completed lines from `push()`.
 *
 * Framing (multiplexed vs. raw/TTY) is decided once, the first time at least
 * 8 bytes have been seen across one or more `push()` calls, using the same
 * rule as `looksMultiplexed`. A container's stream type cannot change
 * mid-connection, so this is safe to memoise; bytes seen before the decision
 * (fewer than 8 so far) are held and re-classified together with the next
 * chunk once there are enough of them.
 *
 * Multiplexed frame parsing deliberately does NOT reuse `demuxLogStream`:
 * that function is written for a complete one-shot buffer, where running out
 * of bytes mid-frame means the response was truncated (so it drops the
 * frame). Here, running out of bytes mid-frame just means the rest hasn't
 * arrived yet — this waits for it instead, keeping the partial frame in
 * `frameBuf` until the next `push()`.
 *
 * Line splitting happens on the raw 0x0a byte, before any UTF-8 decoding:
 * `toString('utf8')` only ever runs on a byte range that both starts and
 * ends on a line boundary, so a multi-byte character split across two
 * `push()` calls (which can only happen mid-line, since 0x0a never appears
 * inside a multi-byte UTF-8 sequence) is decoded correctly once the rest of
 * it arrives, instead of being mangled by decoding a partial byte sequence.
 *
 * Per-line formatting is `formatOneLine`, shared with `formatLogStream`, so
 * a line read back through this incremental path looks identical to the
 * same bytes read back through the one-shot `getLogs()` path.
 *
 * There is no `flush()`. A trailing partial line with no terminating `\n`
 * yet (for example a `\r`-only progress bar mid-write) simply stays pending
 * in `lineBuf` until its `\n` arrives — unlike `formatLogStream`, which
 * always sees a complete buffer and has no such case. If the underlying
 * stream ends with an unterminated line pending, that fragment is dropped:
 * Docker itself never treats a `\n`-less write as a line a viewer should be
 * able to read back later, and `ContainerLogsService.logStream` does not
 * synthesize one either.
 */
export class LogStreamDecoder {
    /** `timeZone` is the zone Docker's line stamps are shown in, as in `formatLogStream`. */
    constructor(private readonly timeZone: string) {}

    /** `null` until the first 8+ bytes decide multiplexed vs. raw framing. */
    private multiplexed: boolean | null = null;
    /** Bytes seen before there were enough of them (8) to decide framing. */
    private undecided: Buffer = Buffer.alloc(0);
    /** Multiplexed mode only: raw bytes not yet parsed into complete frames. */
    private frameBuf: Buffer = Buffer.alloc(0);
    /** Demuxed (or raw/TTY) payload bytes not yet forming a complete `\n`-terminated line. */
    private lineBuf: Buffer = Buffer.alloc(0);

    /** Feed one chunk in; returns newly-completed formatted lines, oldest (arrival) order first. */
    push(chunk: Buffer): string[] {
        if (this.multiplexed === null) {
            this.undecided = Buffer.concat([this.undecided, chunk]);
            if (this.undecided.length < 8) {
                return [];
            }
            this.multiplexed = looksMultiplexed(this.undecided);
            if (this.multiplexed) {
                this.frameBuf = this.undecided;
            } else {
                this.lineBuf = Buffer.concat([this.lineBuf, this.undecided]);
            }
            this.undecided = Buffer.alloc(0);
        } else if (this.multiplexed) {
            this.frameBuf = Buffer.concat([this.frameBuf, chunk]);
        } else {
            this.lineBuf = Buffer.concat([this.lineBuf, chunk]);
        }

        if (this.multiplexed) {
            this.drainFrames();
        }

        return this.drainLines();
    }

    /** Move every complete multiplexed frame's payload from `frameBuf` into `lineBuf`. */
    private drainFrames(): void {
        while (this.frameBuf.length >= 8) {
            const frameSize = this.frameBuf.readUInt32BE(4);
            if (this.frameBuf.length < 8 + frameSize) {
                break; // the rest of this frame hasn't arrived yet
            }
            const payload = this.frameBuf.subarray(8, 8 + frameSize);
            this.lineBuf = Buffer.concat([this.lineBuf, payload]);
            this.frameBuf = this.frameBuf.subarray(8 + frameSize);
        }
    }

    /** Pull every complete `\n`-terminated line out of `lineBuf` and format it. */
    private drainLines(): string[] {
        const lines: string[] = [];
        let start = 0;
        let newlineIndex = this.lineBuf.indexOf(0x0a, start);

        while (newlineIndex !== -1) {
            const rawLine = this.lineBuf.subarray(start, newlineIndex).toString('utf8');
            lines.push(formatOneLine(rawLine, this.timeZone));
            start = newlineIndex + 1;
            newlineIndex = this.lineBuf.indexOf(0x0a, start);
        }

        if (start > 0) {
            this.lineBuf = this.lineBuf.subarray(start);
        }

        return lines;
    }
}
