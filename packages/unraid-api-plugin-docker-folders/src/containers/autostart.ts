import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { pathIsWithin, safePathComponent } from '../paths/paths.js';
import { AUTOSTART_FILE, TEMPLATE_DIR, type TemplateSources } from './unraid-templates.js';

/**
 * Same charset `containers.php`'s `preg_match` (containers.php:181) enforces
 * before `$name` reaches the autostart file or a template path — it blocks
 * path separators and newline injection into the flat file. Checked first,
 * unconditionally, before either write below. `safePathComponent` from
 * paths.ts (which accepts the same set, just written in a different order) is
 * applied again in `findTemplateFile`, right before the value is joined into
 * a filesystem path: belt and suspenders, not either/or, per this repo's
 * "every path from a request" rule.
 */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function isValidAutostartName(name: string): boolean {
    return CONTAINER_NAME_PATTERN.test(name);
}

export interface AutostartWriteResult {
    success: boolean;
    autostart: boolean;
    autostartDelay: number | null;
}

/**
 * `containers.php`'s `autostart` POST branch (containers.php:173-243), split
 * into the two independent writes the PHP does: the flat file is the only
 * thing that decides whether a container autostarts at all, and the XML
 * template only ever records a delay, never membership.
 *
 * `sources` defaults to the real Unraid paths and is only ever overridden by
 * tests, the same contract `unraid-templates.ts`'s `TemplateSources` already
 * has — reused here rather than re-declared.
 */
export function setAutostart(
    name: string,
    enabled: boolean,
    delay: number | null | undefined,
    sources: TemplateSources = {}
): AutostartWriteResult {
    if (!isValidAutostartName(name)) {
        throw new Error('Invalid container name');
    }

    const autostartFile = sources.autostartFile ?? AUTOSTART_FILE;
    const templateDir = sources.templateDir ?? TEMPLATE_DIR;

    writeAutostartFlag(autostartFile, name, enabled);

    // `max(0, (int)$delay)` in the PHP; `null`/`undefined` means "delay was
    // not sent", left as null rather than coerced to 0 so the flat-file-only
    // write above is not accompanied by a spurious template write.
    const clampedDelay = delay === null || delay === undefined ? null : Math.max(0, Math.trunc(delay));
    if (clampedDelay !== null) {
        writeAutostartDelay(templateDir, name, clampedDelay);
    }

    return { success: true, autostart: enabled, autostartDelay: clampedDelay };
}

/**
 * Append `name` if it should autostart and is not already listed, drop it if
 * it should not. One bare name per line, always rewritten with a trailing
 * newline — matches `containers.php:189-204`
 * (`FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES` on read,
 * `implode(PHP_EOL, ...) . PHP_EOL` on write, unconditionally, even when
 * nothing changed). Every other name's line survives untouched; only this
 * name's membership and position (appended on enable, removed in place on
 * disable) can move.
 */
function writeAutostartFlag(autostartFile: string, name: string, enabled: boolean): void {
    const names = readAutostartNames(autostartFile);

    const next = enabled
        ? names.includes(name)
            ? names
            : [...names, name]
        : names.filter((existing) => existing !== name);

    try {
        writeFileSync(autostartFile, next.length > 0 ? `${next.join('\n')}\n` : '\n');
    } catch {
        // `containers.php:202-204` reports this generically too
        // ("Failed to update autostart file") rather than surfacing PHP's own
        // `file_put_contents` warning, which would leak the flash-drive path
        // into a client-visible error message.
        throw new Error('Failed to update autostart file');
    }
}

function readAutostartNames(autostartFile: string): string[] {
    const text = readFileIfPresent(autostartFile);
    if (text === null) return [];

    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

/**
 * Patch `<AutostartDelay>` in the container's dockerMan template, touching
 * only that one element and leaving every other byte of the file unchanged.
 *
 * `containers.php:227-239` does this with `DOMDocument`
 * (`preserveWhiteSpace = true`, `formatOutput = false`) instead: load, find
 * or create the `AutostartDelay` node, set it, `$doc->save()`. That round trip
 * is not byte-identical to the source file even with those flags — `save()`
 * can still normalise attribute quoting, self-closing tags, and the XML
 * declaration depending on what was loaded. `unraid-templates.ts` already
 * decided against an XML parser dependency for reading `<Name>` and
 * `<Repository>`; this mirrors that choice for writing `<AutostartDelay>`,
 * with a targeted string replace instead of load-mutate-serialize. The result
 * is a STRONGER byte-parity guarantee for every line the delay does not touch
 * than the PHP itself gives, at the cost of not being a real XML patch (a
 * value containing `</` would break it; Unraid never writes one there).
 */
export function patchAutostartDelay(xml: string, delay: number): string {
    const existing = /<AutostartDelay>[^<]*<\/AutostartDelay>/;
    if (existing.test(xml)) {
        return xml.replace(existing, `<AutostartDelay>${delay}</AutostartDelay>`);
    }

    // No existing element: insert one as the last child of the root, the same
    // position `$doc->documentElement->appendChild(...)` puts it in. Templates
    // are flat, single-level documents (see unraid-templates.ts), so the
    // root's own closing tag is the last tag in the file.
    const rootClose = /<\/[A-Za-z][\w:-]*>\s*$/.exec(xml);
    if (rootClose === null) return xml;

    return `${xml.slice(0, rootClose.index)}<AutostartDelay>${delay}</AutostartDelay>${xml.slice(rootClose.index)}`;
}

function writeAutostartDelay(templateDir: string, name: string, delay: number): void {
    const xmlPath = findTemplateFile(templateDir, name);
    if (xmlPath === null) return;

    const xml = readFileIfPresent(xmlPath);
    if (xml === null) return;

    writeFileSync(xmlPath, patchAutostartDelay(xml, delay));
}

/**
 * Find the template file for `name`, mirroring `containers.php:208-224`: try
 * `my-<basename(name)>.xml` first (used as-is if it exists, with no check
 * that its own `<Name>` matches — the PHP does not check either), then scan
 * every `my-*.xml` for a matching `<Name>` element.
 *
 * `name` was already validated by `isValidAutostartName` before this is
 * reached. `basename` and `safePathComponent` are applied anyway, and every
 * candidate path is confirmed with `pathIsWithin` before use, so nothing here
 * can escape `templateDir` even if a future caller skips that earlier gate.
 */
function findTemplateFile(templateDir: string, name: string): string | null {
    const safeName = safePathComponent(basename(name));
    if (safeName === null) return null;

    const direct = join(templateDir, `my-${safeName}.xml`);
    if (pathIsWithin(direct, templateDir) && existsSync(direct)) {
        return direct;
    }

    if (!existsSync(templateDir)) return null;

    let files: string[];
    try {
        files = readdirSync(templateDir);
    } catch {
        return null;
    }

    for (const file of files) {
        // PHP's `substr($f, -4) === '.bak'` skip is dead code after a
        // `my-*.xml` glob — nothing matching that pattern can end in `.bak` —
        // so it is not ported.
        if (!file.startsWith('my-') || !file.endsWith('.xml')) continue;

        const path = join(templateDir, file);
        if (!pathIsWithin(path, templateDir)) continue;

        const xml = readFileIfPresent(path);
        if (xml === null) continue;

        const match = /<Name>([^<]+)<\/Name>/.exec(xml);
        if (match !== null && match[1].trim() === name) {
            return path;
        }
    }

    return null;
}

/** Every read here is best effort: the flash drive may be absent in dev. */
function readFileIfPresent(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}
