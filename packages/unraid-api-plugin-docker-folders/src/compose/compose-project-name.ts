import { normalizePath } from '../paths/paths.js';

/**
 * The name a Compose Manager stack runs under, ported from
 * `classes/ComposeProjectName.php`. Both read one table of cases,
 * `__tests__/project-name-cases.json`. Change them together.
 *
 * Compose Manager has two forms and they differ:
 * - dcflachs/compose_plugin (`php/util.php` `sanitizeStr`): replace ".", " "
 *   and "-" with "_", then lowercase. It can produce a name Compose refuses.
 * - Compose Manager Plus, mstrhakr/compose_plugin
 *   (`include/ProjectNameSanitizer.php`): lowercase, replace every character
 *   outside [a-z0-9_-] with "_", collapse runs of "_" and of "-", trim "_" and
 *   "-" from both ends. An empty result is Plus's placeholder "compose", which
 *   is treated here as no name at all.
 *
 * Compose itself accepts only `^[a-z0-9][a-z0-9_-]*$`.
 */

/** Name of the file Compose Manager Plus pins the identity in. */
export const PIN_FILE = 'project_name';

const VALID = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidComposeName(name: string): boolean {
    return VALID.test(name);
}

/** Compose Manager Plus sanitizer. `null` when nothing usable is left. */
export function plusSanitize(raw: string): string | null {
    const cleaned = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/-+/g, '-')
        .replace(/^[_-]+|[_-]+$/g, '');
    return cleaned === '' ? null : cleaned;
}

/** dcflachs `sanitizeStr`. May return a name Compose refuses. */
export function dcflachsSanitize(raw: string): string {
    return raw.replace(/[. -]/g, '_').toLowerCase();
}

export interface FolderNameResult {
    name: string | null;
    source: string;
    error: string | null;
}

/**
 * The name Compose Manager itself gives a project folder when no container
 * tells us. Order, as the real plugins do it: a valid `project_name` pin; with
 * a legacy-origin marker, the dcflachs rule over the name file (else the
 * folder), when valid; then, with the marker or Plus installed, the Plus
 * sanitizer over the folder name; otherwise the dcflachs rule.
 */
export function nameFromFolder(input: {
    dirName: string;
    displayName: string | null;
    pinned: string | null;
    plusInstalled: boolean;
    legacyOrigin: boolean;
}): FolderNameResult {
    const { dirName, displayName, pinned, plusInstalled, legacyOrigin } = input;

    if (pinned !== null) {
        if (isValidComposeName(pinned)) return { name: pinned, source: 'project_name file', error: null };
        return {
            name: null,
            source: 'project_name file',
            error: `the project_name file holds "${pinned}", which Compose does not accept`,
        };
    }

    const raw = displayName !== null && displayName.trim() !== '' ? displayName.trim() : dirName;

    if (legacyOrigin) {
        const legacy = dcflachsSanitize(raw);
        if (isValidComposeName(legacy)) return { name: legacy, source: 'legacy rule', error: null };
    }

    if (plusInstalled || legacyOrigin) {
        const plus = plusSanitize(dirName);
        if (plus !== null && isValidComposeName(plus)) {
            return { name: plus, source: 'Compose Manager Plus rule', error: null };
        }
        return {
            name: null,
            source: 'Compose Manager Plus rule',
            error: `"${dirName}" gives no name Compose accepts`,
        };
    }

    const legacy = dcflachsSanitize(raw);
    if (isValidComposeName(legacy)) return { name: legacy, source: 'Compose Manager rule', error: null };
    return {
        name: null,
        source: 'Compose Manager rule',
        error: `"${raw}" gives "${legacy}", which Compose does not accept`,
    };
}

/** The slice of a container the label lookup reads. */
export interface LabelledContainer {
    labels: Readonly<Record<string, string>>;
}

/**
 * The project label of containers that run from one of the given source
 * directories. Both fields null when no container matches.
 */
export function nameFromLabels(
    containers: readonly LabelledContainer[],
    sourceDirs: readonly (string | null)[]
): { name: string | null; error: string | null } {
    const wanted = new Set<string>();
    for (const dir of sourceDirs) {
        const normalized = dir === null ? null : normalizePath(dir);
        if (normalized !== null) wanted.add(normalized);
    }

    const found = new Set<string>();
    for (const container of containers) {
        const project = container.labels['com.docker.compose.project'];
        const workingDir = container.labels['com.docker.compose.project.working_dir'];
        if (typeof project !== 'string' || typeof workingDir !== 'string') continue;
        const normalized = normalizePath(workingDir);
        if (normalized !== null && wanted.has(normalized)) found.add(project);
    }

    if (found.size > 1) {
        return { name: null, error: `containers run it under more than one project name (${[...found].join(', ')})` };
    }
    if (found.size === 1) {
        const name = [...found][0];
        if (!isValidComposeName(name)) {
            return { name: null, error: `its containers carry the project name "${name}", which Compose does not accept` };
        }
        return { name, error: null };
    }
    return { name: null, error: null };
}
