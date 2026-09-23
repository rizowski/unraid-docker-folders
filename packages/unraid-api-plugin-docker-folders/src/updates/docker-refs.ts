import { imageFromTemplate } from '../containers/unraid-templates.js';

/**
 * Small, pure helpers shared by `UpdatesService` and `RecreateService`. Both
 * read raw `docker.listContainers()`/`inspectContainerRaw()` responses rather
 * than the already-resolved `DockerFoldersContainer[]`, because that type has
 * no `imageId` (update checking) and no full `Config`/`HostConfig`
 * (recreating) — see each service's doc comment.
 */

export function stripLeadingSlash(name: string): string {
    return name.startsWith('/') ? name.slice(1) : name;
}

/**
 * Prefer the Unraid template's image reference over Docker's, the same rule
 * `ContainerListService.resolveImageTag` applies for the container list and
 * `DockerClient::resolveImageTag` applies in PHP.
 *
 * PHP has a second fallback this does not: when the template lookup misses,
 * it also checks the image's own `RepoTags` for a non-digest reference. That
 * fallback was already left out of `ContainerListService`'s port (not
 * something introduced here), so a `sha256:...` reference with no matching
 * template still displays as a digest in both cases, same as before.
 */
export function resolveImageTag(imageRef: string, containerName: string): string {
    if (!imageRef.startsWith('sha256:')) return imageRef;
    return imageFromTemplate(containerName) ?? imageRef;
}

/**
 * `fnmatch($pattern, $imageName)` without `FNM_PATHNAME` — PHP's call lets
 * `*` match `/` too, so an exclude pattern like `linuxserver/*` still needs
 * the segment-crossing behaviour, not a path-safe one.
 */
export function globMatch(pattern: string, value: string): boolean {
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*?')
        .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(value);
}

export function nullableString(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
