import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The two things Docker does not know but Unraid does: which containers start
 * with the array, and what a container's image is really called.
 *
 * Both answers live on the flash drive rather than in Docker. Ported from
 * `DockerClient::getAutostartMap` and `getImageFromTemplate`.
 *
 * Read with a regular expression rather than an XML parser, which is what the
 * PHP already does for `<Name>` and `<AutostartDelay>`. These templates are
 * flat, single-level documents written by Unraid itself, the plugin only ever
 * reads three leaf elements out of them, and an XML parser would be a
 * dependency the API does not already have.
 */

export const AUTOSTART_FILE = '/var/lib/docker/unraid-autostart';
export const TEMPLATE_DIR = '/boot/config/plugins/dockerMan/templates-user';

/**
 * Where to read from. Defaulted to the real Unraid locations, and overridable
 * only so the tests can point at a temporary directory - nothing in the plugin
 * passes anything else. Without this the two functions below can only be
 * exercised on an Unraid server, which is the one place a failing test is
 * least useful.
 */
export interface TemplateSources {
    autostartFile?: string;
    templateDir?: string;
}

export interface AutostartEntry {
    autostart: boolean;
    /** Seconds Unraid waits after the previous container. 0 when unset. */
    autostartDelay: number;
}

/**
 * Which containers autostart, and how long each waits.
 *
 * Two sources, because Unraid splits the answer. The flat file is
 * authoritative for whether a container autostarts at all and holds one bare
 * container name per line, confirmed on Unraid 7.3.2. The delay lives in the
 * container's dockerMan template instead.
 *
 * The map is keyed by every name either source mentions, not only the running
 * ones, so a container that exists as a template but not as a container still
 * reports its delay.
 */
export function readAutostartMap(sources: TemplateSources = {}): Map<string, AutostartEntry> {
    const autostartFile = sources.autostartFile ?? AUTOSTART_FILE;
    const templateDir = sources.templateDir ?? TEMPLATE_DIR;

    const autostartNames = new Set(readAutostartNames(autostartFile));
    const delays = readAutostartDelays(templateDir);

    const map = new Map<string, AutostartEntry>();
    for (const name of new Set([...autostartNames, ...delays.keys()])) {
        map.set(name, {
            autostart: autostartNames.has(name),
            autostartDelay: delays.get(name) ?? 0,
        });
    }
    return map;
}

function readAutostartNames(autostartFile: string): string[] {
    const text = readFileIfPresent(autostartFile);
    if (text === null) return [];

    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
}

function readAutostartDelays(templateDir: string): Map<string, number> {
    const delays = new Map<string, number>();

    // Only `my-*.xml`, matching the PHP. Unraid names every template it writes
    // that way, and the wider glob below is a fallback for a different lookup.
    for (const file of templateFiles(templateDir, 'my-')) {
        const xml = readFileIfPresent(file);
        if (xml === null) continue;

        const name = element(xml, 'Name');
        if (name === null) continue;

        const delay = element(xml, 'AutostartDelay');
        delays.set(name, delay === null ? 0 : Number.parseInt(delay, 10) || 0);
    }

    return delays;
}

/**
 * The image reference Unraid's template gives for a container.
 *
 * Needed because Docker reports an image as a bare `sha256:` digest once the
 * tag it was pulled under has been reused by a newer image, which happens to
 * every container whose image was updated. The template still records what the
 * user actually chose.
 *
 * The prefixed filename is tried first and is right almost always; the scan
 * exists for a template whose `<Name>` does not match its filename. Note the
 * scan deliberately looks at every `*.xml`, not only `my-*.xml`, which is
 * wider than the autostart lookup above. That difference is in the PHP too.
 */
export function imageFromTemplate(containerName: string, sources: TemplateSources = {}): string | null {
    const templateDir = sources.templateDir ?? TEMPLATE_DIR;
    // basename(), because this reaches a filesystem path and the name comes
    // from Docker rather than from us.
    const safeName = basename(containerName);

    const direct = readFileIfPresent(join(templateDir, `my-${safeName}.xml`));
    if (direct !== null) {
        const repository = element(direct, 'Repository');
        if (repository !== null) return repository;
    }

    for (const file of templateFiles(templateDir, '')) {
        const xml = readFileIfPresent(file);
        if (xml === null) continue;
        if (element(xml, 'Name') !== containerName) continue;

        const repository = element(xml, 'Repository');
        if (repository !== null) return repository;
    }

    return null;
}

function templateFiles(templateDir: string, prefix: string): string[] {
    if (!existsSync(templateDir)) return [];

    try {
        return readdirSync(templateDir)
            .filter((name) => name.startsWith(prefix) && name.endsWith('.xml'))
            .map((name) => join(templateDir, name));
    } catch {
        return [];
    }
}

/** The text of the first `<tag>` element, or null when it is absent or empty. */
function element(xml: string, tag: string): string | null {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    if (match === null) return null;

    const value = match[1].trim();
    return value === '' ? null : value;
}

/** Every read here is best effort: the flash drive may be absent in dev. */
function readFileIfPresent(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}
