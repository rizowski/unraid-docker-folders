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
 * Prefer the Unraid template's image reference over Docker's, then the
 * container's own `Config.Image` when the caller has it. The same rule
 * `DockerClient::resolveImageTag` applies in PHP, and the one the container
 * list uses too.
 *
 * Docker lists a container under its bare `sha256:` image id once the tag it
 * was created from moves to a newer image. A container created outside Unraid
 * has no template, so without `Config.Image` it would show the digest.
 *
 * PHP has one more fallback this does not: the old image's own `RepoTags`.
 * After a pull moves the tag, the old image usually has none left, so the
 * two only differ on an image that was retagged by hand.
 */
export function resolveImageTag(imageRef: string, containerName: string, configImage = ''): string {
    if (!imageRef.startsWith('sha256:')) return imageRef;
    const fromTemplate = imageFromTemplate(containerName);
    if (fromTemplate !== null) return fromTemplate;
    if (isTagReference(configImage)) return configImage;
    return imageRef;
}

/**
 * Whether a reference names an image by tag, so it can move to a newer
 * image. A bare `sha256:` id and a digest pin never move.
 * `DockerClient::isTagReference`.
 */
export function isTagReference(ref: string): boolean {
    return ref !== '' && !ref.startsWith('sha256:') && !ref.includes('@');
}

/**
 * Whether the container runs an older image than its tag now names.
 * `DockerClient::isImageOutdated`.
 *
 * Docker's list reports a container's `Config.Image` only while that
 * reference still resolves to the image the container runs. Once a pull
 * moves the tag, the list reports the image id instead. So a `sha256:` id in
 * the list, for a container created from a tag, means a newer image is on
 * disk and the container has to be recreated to use it.
 */
export function isImageOutdated(listImage: string, configImage: string): boolean {
    return listImage.startsWith('sha256:') && isTagReference(configImage);
}

export interface RecreateCandidate {
    id: string;
    name: string;
    /** The resolved image reference, as the container list shows it. */
    image: string;
    /** The image ID the container runs. */
    imageId?: string;
}

/**
 * Pick the containers a pull recreates, `selectRecreateTargets()` in PHP.
 *
 * Without ids, every container using the image. With ids, those containers
 * and no others, and each still has to use the pulled image. An id that does
 * not end up in the list comes back in `missing`, so the caller can report
 * it instead of ending the pull with "Pull complete" and recreating nothing.
 */
export function selectRecreateTargets(
    containers: RecreateCandidate[],
    image: string,
    onlyContainerIds: Set<string> | null
): { targets: RecreateCandidate[]; missing: string[] } {
    const targets = containers.filter(
        (container) =>
            (onlyContainerIds === null || onlyContainerIds.has(container.id)) && container.image === image
    );
    const found = new Set(targets.map((container) => container.id));
    const missing = onlyContainerIds === null ? [] : [...onlyContainerIds].filter((id) => !found.has(id));
    return { targets, missing };
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
