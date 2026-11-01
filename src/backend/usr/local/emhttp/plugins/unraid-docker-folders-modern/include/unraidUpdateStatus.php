<?php
/**
 * Tell Unraid's own Docker manager that a pull made an image current.
 *
 * Unraid keeps its "update ready" flags in two files the plugin's pulls never
 * touched (issue #23):
 *
 * - /var/lib/docker/unraid-update-status.json, keyed by image tag, holding
 *   {local, remote, status}. The Docker tab reads it through
 *   DockerUpdate::getUpdateStatus() and the Unraid API reads it for
 *   isUpdateAvailable. After its own pull, Unraid calls setUpdateStatus(),
 *   which writes local = remote = the pulled digest. Its 00:10 and 12:10 check
 *   keeps the stored `local` and only fetches `remote`, so an entry the plugin
 *   left stale stays flagged until Unraid itself pulls the image.
 * - The Docker tab's cache, docker.json, keyed by container name. Its
 *   `updated` field is only recomputed when the entry has no `template` too,
 *   so the entry is dropped, as Unraid's removeContainer() does.
 *
 * Unraid's DockerUpdate class cannot be loaded here: its file declares a
 * global DockerClient, and so does the plugin. The pieces needed are ported
 * below instead.
 *
 * Unraid's job and the Unraid API write these files too, with a plain
 * file_put_contents and no lock. A file that is present but does not decode
 * is never written back, because that would erase every entry.
 */

/** Unraid's per-tag update status, dynamix.docker.manager's 'update-status'. */
const UNRAID_UPDATE_STATUS_PATH = '/var/lib/docker/unraid-update-status.json';
/** The Docker tab's container cache, dynamix.docker.manager's 'webui-info'. */
const UNRAID_DOCKER_WEBUI_INFO_PATH = '/usr/local/emhttp/state/plugins/dynamix.docker.manager/docker.json';

/**
 * The key Unraid files an image under: DockerUtil::ensureImageTag().
 *
 * Adds `library/` to a name with no slash and `:latest` to one with no tag.
 * A port of Unraid's code; packages/.../scripts/unraid-key-oracle.php builds
 * the fixture both backends are tested against from the original.
 *
 * @param string $image Image reference as the container was created from
 * @return string|null Null for an ID or a digest reference, which Unraid's
 *   parser turns into a meaningless key
 */
function unraidImageKey($image)
{
  $image = trim((string) $image);
  if ($image === '' || strpos($image, 'sha256:') === 0 || strpos($image, '@') !== false) {
    return null;
  }
  if (strpos($image, '/') === false) {
    $image = 'library/' . $image;
  }

  $repo = $image;
  $tag = '';
  if (preg_match('@^(.+/)*([^/:]+)(:[^:/]*)*$@', $image, $m) && count($m) >= 3) {
    $m = array_merge($m, ['']);
    $repo = $m[1] . $m[2];
    $tag = str_replace(':', '', $m[3]);
  }
  if ($tag === '') {
    $tag = 'latest';
  }
  return trim($repo) . ':' . trim($tag);
}

/**
 * A bare `sha256:<hex>` digest, from either that form or `repo@sha256:<hex>`.
 *
 * @param mixed $digest
 * @return string|null
 */
function bareImageDigest($digest)
{
  if (!is_string($digest) || $digest === '') {
    return null;
  }
  $at = strrpos($digest, '@');
  if ($at !== false) {
    $digest = substr($digest, $at + 1);
  }
  return preg_match('/^sha256:[0-9a-f]{64}$/', $digest) ? $digest : null;
}

/**
 * The digest in a pull stream's "Digest: sha256:..." status line.
 *
 * Docker sends it once, near the end of a successful pull. It is the digest
 * the tag resolved to, the same value Unraid's own updater records.
 *
 * @param mixed $status A pull chunk's `status` field
 * @return string|null
 */
function pullDigestFromStatus($status)
{
  if (!is_string($status)) {
    return null;
  }
  return preg_match('/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/', $status, $m) ? $m[1] : null;
}

/**
 * Read one of Unraid's JSON state files.
 *
 * @param string $path
 * @return array|null [] for a missing file, null for one that exists but does
 *   not decode to an object, including an empty file caught mid-write
 */
function readUnraidJson($path)
{
  if (!file_exists($path)) {
    return [];
  }
  $raw = @file_get_contents($path);
  if (!is_string($raw) || trim($raw) === '') {
    return null;
  }
  $data = json_decode($raw, true);
  return is_array($data) ? $data : null;
}

/**
 * Replace one of Unraid's JSON state files atomically, in Unraid's format.
 *
 * The temp file sits in the same directory, because /var/lib/docker is often
 * the docker.img loop mount and a rename across filesystems is not atomic.
 *
 * @param string $path
 * @param array $data
 * @return bool
 */
function writeUnraidJson($path, array $data)
{
  $dir = dirname($path);
  if (!is_dir($dir)) {
    return false;
  }
  $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
  if ($json === false) {
    return false;
  }
  $mode = file_exists($path) ? (fileperms($path) & 0777) : 0644;
  $tmp = $dir . '/.' . basename($path) . '.dfm-' . getmypid() . '.tmp';
  if (@file_put_contents($tmp, $json) === false) {
    @unlink($tmp);
    return false;
  }
  @chmod($tmp, $mode);
  if (!@rename($tmp, $path)) {
    @unlink($tmp);
    return false;
  }
  return true;
}

/**
 * Drop containers from the Docker tab's cache, so it recomputes their status.
 *
 * Leaves a missing or unreadable file alone. Unraid builds it again itself.
 *
 * @param string[] $containerNames
 * @param string $webuiPath
 * @return bool True when the file changed
 */
function dropUnraidWebuiEntries(array $containerNames, $webuiPath = UNRAID_DOCKER_WEBUI_INFO_PATH)
{
  if (empty($containerNames) || !file_exists($webuiPath)) {
    return false;
  }
  $info = readUnraidJson($webuiPath);
  if ($info === null) {
    return false;
  }
  $changed = false;
  foreach ($containerNames as $name) {
    if (array_key_exists((string) $name, $info)) {
      unset($info[(string) $name]);
      $changed = true;
    }
  }
  return $changed && writeUnraidJson($webuiPath, $info);
}

/**
 * DockerUpdate::setUpdateStatus() for one pulled image, plus the cache drop.
 *
 * @param string $image Image reference that was pulled
 * @param string|null $digest Bare digest the pull resolved to
 * @param string[] $containerNames Containers created from that image
 * @param string $statusPath
 * @param string $webuiPath
 * @return bool True when the status file was written
 */
function markUnraidImageCurrent(
  $image,
  $digest,
  array $containerNames,
  $statusPath = UNRAID_UPDATE_STATUS_PATH,
  $webuiPath = UNRAID_DOCKER_WEBUI_INFO_PATH
) {
  $key = unraidImageKey($image);
  $digest = bareImageDigest($digest);
  // Nothing rather than an entry with no digests: the Unraid API reads a
  // status of "true" with no digests as an update.
  if ($key === null || $digest === null) {
    return false;
  }

  $status = readUnraidJson($statusPath);
  if ($status === null) {
    return false;
  }
  $status[$key] = ['local' => $digest, 'remote' => $digest, 'status' => 'true'];
  if (!writeUnraidJson($statusPath, $status)) {
    return false;
  }

  dropUnraidWebuiEntries($containerNames, $webuiPath);
  return true;
}

/**
 * Names of the containers whose image is $image, by Unraid's key.
 *
 * Reads the plugin's resolved `image` field, not Docker's raw one, which turns
 * into a bare ID once a pull moves the tag.
 *
 * @param array $containers DockerClient::listContainers() output
 * @param string $image
 * @return string[]
 */
function containerNamesForImage(array $containers, $image)
{
  $key = unraidImageKey($image);
  if ($key === null) {
    return [];
  }
  $names = [];
  foreach ($containers as $container) {
    $name = (string) ($container['name'] ?? '');
    if ($name !== '' && unraidImageKey($container['image'] ?? '') === $key) {
      $names[] = $name;
    }
  }
  return $names;
}

/**
 * Clear "update ready" flags left by pulls made before this fix.
 *
 * Touches only an entry with status "false" whose `remote` digest is one of
 * the local image's RepoDigests. Then the image on disk is the one the
 * registry serves, and Unraid would agree had it pulled it itself.
 *
 * @param DockerClient $dockerClient
 * @param array $containers DockerClient::listContainers() output
 * @param string $statusPath
 * @param string $webuiPath
 * @return string[] Keys that were repaired
 */
function repairUnraidUpdateStatus(
  $dockerClient,
  array $containers,
  $statusPath = UNRAID_UPDATE_STATUS_PATH,
  $webuiPath = UNRAID_DOCKER_WEBUI_INFO_PATH
) {
  $status = readUnraidJson($statusPath);
  if (empty($status)) {
    return [];
  }

  $repaired = [];
  foreach ($status as $key => $entry) {
    if (!is_array($entry) || ($entry['status'] ?? null) !== 'false') {
      continue;
    }
    $remote = bareImageDigest($entry['remote'] ?? null);
    if ($remote === null || ($entry['local'] ?? null) === $remote) {
      continue;
    }
    $info = $dockerClient->getImageInfo((string) $key);
    if (!is_array($info)) {
      continue;
    }
    $local = array_map('bareImageDigest', $info['RepoDigests'] ?? []);
    if (in_array($remote, $local, true)) {
      $status[$key] = ['local' => $remote, 'remote' => $remote, 'status' => 'true'];
      $repaired[] = (string) $key;
    }
  }

  if (empty($repaired) || !writeUnraidJson($statusPath, $status)) {
    return [];
  }

  $names = [];
  foreach ($repaired as $key) {
    $names = array_merge($names, containerNamesForImage($containers, $key));
  }
  dropUnraidWebuiEntries(array_values(array_unique($names)), $webuiPath);
  return $repaired;
}
