<?php
/**
 * Unraid Docker Folders - Compose project names
 *
 * The name a Compose Manager stack runs under, and the rules that make it.
 * Compose Manager has two forms, and they differ:
 *
 * - dcflachs/compose_plugin (php/util.php sanitizeStr): replace ".", " " and
 *   "-" with "_", then lowercase. Nothing else is touched, so it can produce
 *   a name Compose refuses (an "@", say).
 * - Compose Manager Plus, mstrhakr/compose_plugin
 *   (include/ProjectNameSanitizer.php): lowercase, replace every character
 *   outside [a-z0-9_-] with "_", collapse runs of "_" and of "-", trim "_" and
 *   "-" from both ends. An empty result is the placeholder "compose", which
 *   this class treats as no name at all, so unrelated folders cannot collide.
 *
 * Compose itself accepts only ^[a-z0-9][a-z0-9_-]*$.
 *
 * The GraphQL plugin holds the same rules (compose/compose-project-name.ts).
 * Both read one table of cases, packages/unraid-api-plugin-docker-folders/
 * src/compose/__tests__/project-name-cases.json. Change them together.
 *
 * @package UnraidDockerModern
 */

class ComposeProjectName
{
  /** The rule Compose applies to a project name. */
  const VALID_PATTERN = '/^[a-z0-9][a-z0-9_-]*$/D';

  /** Name of the file Compose Manager Plus pins the identity in. */
  const PIN_FILE = 'project_name';

  /** True when Compose accepts the name. */
  public static function isValid($name)
  {
    return is_string($name) && preg_match(self::VALID_PATTERN, $name) === 1;
  }

  /**
   * Compose Manager Plus sanitizer.
   *
   * @param string $raw
   * @return string|null null when nothing usable is left
   */
  public static function plusSanitize($raw)
  {
    $s = strtolower(trim((string) $raw));
    $s = preg_replace('/[^a-z0-9_-]/', '_', $s);
    $s = preg_replace('/_+/', '_', $s);
    $s = preg_replace('/-+/', '-', $s);
    $s = trim($s, '_-');
    return $s === '' ? null : $s;
  }

  /**
   * dcflachs compose_plugin sanitizeStr. May return a name Compose refuses.
   *
   * @param string $raw
   * @return string
   */
  public static function dcflachsSanitize($raw)
  {
    return strtolower(str_replace(['.', ' ', '-'], '_', (string) $raw));
  }

  /**
   * The name Compose Manager itself gives a project folder when no container
   * tells us (see projectNameFromLabels for the name a running stack has).
   *
   * Order, as the real plugins do it:
   * 1. A "project_name" file (Plus pins the identity there). Used when it is a
   *    name Compose accepts. An invalid pin is an error, as in Plus.
   * 2. A "legacy-origin" marker (Plus writes it when it took stacks over from
   *    dcflachs): the dcflachs rule over the name file, else the folder name,
   *    when that gives a valid name. Then, with the marker or with Plus
   *    installed: the Plus sanitizer over the folder name. Plus takes its
   *    name from the folder, not from the name file.
   * 3. Otherwise dcflachs: the "name" file if there is one, else the folder
   *    name, through sanitizeStr.
   *
   * @param string $dirName Folder name under the projects directory
   * @param string|null $displayName Content of the "name" file, or null
   * @param string|null $pinned Content of the "project_name" file, or null when absent
   * @param bool $plusInstalled Whether Compose Manager Plus is installed
   * @param bool $legacyOrigin Whether the legacy-origin marker exists
   * @return array ['name' => string|null, 'source' => string, 'error' => string|null]
   */
  public static function fromFolder($dirName, $displayName, $pinned, $plusInstalled, $legacyOrigin)
  {
    if ($pinned !== null) {
      if (self::isValid($pinned)) {
        return ['name' => $pinned, 'source' => 'project_name file', 'error' => null];
      }
      return ['name' => null, 'source' => 'project_name file', 'error' => "the project_name file holds \"{$pinned}\", which Compose does not accept"];
    }

    $raw = trim((string) $displayName) !== '' ? trim((string) $displayName) : $dirName;

    if ($legacyOrigin) {
      $legacy = self::dcflachsSanitize($raw);
      if (self::isValid($legacy)) {
        return ['name' => $legacy, 'source' => 'legacy rule', 'error' => null];
      }
    }

    if ($plusInstalled || $legacyOrigin) {
      $plus = self::plusSanitize($dirName);
      if ($plus !== null && self::isValid($plus)) {
        return ['name' => $plus, 'source' => 'Compose Manager Plus rule', 'error' => null];
      }
      return ['name' => null, 'source' => 'Compose Manager Plus rule', 'error' => "\"{$dirName}\" gives no name Compose accepts"];
    }

    $legacy = self::dcflachsSanitize($raw);
    if (self::isValid($legacy)) {
      return ['name' => $legacy, 'source' => 'Compose Manager rule', 'error' => null];
    }
    return ['name' => null, 'source' => 'Compose Manager rule', 'error' => "\"{$raw}\" gives \"{$legacy}\", which Compose does not accept"];
  }

  /**
   * The project label of containers that run from one of the given source
   * directories.
   *
   * @param array $containers Container list with labels
   * @param string[] $sourceDirs Directories a stack's compose files live in
   * @return array ['name' => string|null, 'error' => string|null]; both null
   *               when no container matches
   */
  public static function fromLabels(array $containers, array $sourceDirs)
  {
    $wanted = [];
    foreach ($sourceDirs as $dir) {
      $n = is_string($dir) ? normalizePath($dir) : null;
      if ($n !== null) {
        $wanted[$n] = true;
      }
    }

    $found = [];
    foreach ($containers as $container) {
      $labels = $container['labels'] ?? [];
      $project = $labels['com.docker.compose.project'] ?? null;
      $workingDir = $labels['com.docker.compose.project.working_dir'] ?? null;
      if (!is_string($project) || !is_string($workingDir)) {
        continue;
      }
      $n = normalizePath($workingDir);
      if ($n !== null && isset($wanted[$n])) {
        $found[$project] = true;
      }
    }

    if (count($found) > 1) {
      return ['name' => null, 'error' => 'containers run it under more than one project name (' . implode(', ', array_keys($found)) . ')'];
    }
    if (count($found) === 1) {
      $name = (string) array_key_first($found);
      if (!self::isValid($name)) {
        return ['name' => null, 'error' => "its containers carry the project name \"{$name}\", which Compose does not accept"];
      }
      return ['name' => $name, 'error' => null];
    }
    return ['name' => null, 'error' => null];
  }
}
