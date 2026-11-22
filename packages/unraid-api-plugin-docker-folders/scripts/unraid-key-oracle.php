<?php
/**
 * Builds the fixture for the Unraid update-status key, from Unraid's own code.
 *
 * Unraid keys /var/lib/docker/unraid-update-status.json by
 * DockerUtil::ensureImageTag(). Both backends write that file after a pull,
 * so both must build the same key Unraid does. The two methods below are
 * copied verbatim from unraid/webgui
 * emhttp/plugins/dynamix.docker.manager/include/DockerClient.php (class
 * DockerUtil), so the fixture records Unraid's answer, not a second reading
 * of it.
 *
 *   php unraid-key-oracle.php > src/updates/__tests__/unraid-image-keys.fixture.json
 *
 * tests/php/UnraidUpdateStatusTest.php and
 * src/updates/__tests__/unraid-update-status.spec.ts both read the fixture.
 */
class Oracle {
	public static function ensureImageTag($image): string {
		extract(static::parseImageTag($image));
		return "$strRepo:$strTag";
	}

	public static function parseImageTag($image): array {
		if (strpos($image, 'sha256:') === 0) {
			// sha256 was provided instead of actual repo name so truncate it for display:
			$strRepo = substr($image, 7, 12);
		} elseif (strpos($image, '/') === false) {
			return static::parseImageTag('library/' . $image);
		} else {
			$parsedImage = static::splitImage($image);
			if (!empty($parsedImage)) {
				$strRepo = $parsedImage['strRepo'];
				$strTag = $parsedImage['strTag'];
			} else {
				// Unprocessable input
				$strRepo = $image;
			}
		}
		// Add :latest tag to image if it's absent
		if (empty($strTag)) $strTag = 'latest';
		return array_map('trim', ['strRepo' => $strRepo, 'strTag' => $strTag]);
	}

	private static function splitImage($image): ?array {
		if (false === preg_match('@^(.+/)*([^/:]+)(:[^:/]*)*$@', $image, $newSections) || count($newSections) < 3) {
			return null;
		} else {
			[, $strRepo, $image, $strTag] = array_merge($newSections, ['']);
			$strTag = str_replace(':','',$strTag??'');
			return [
				'strRepo' => $strRepo . $image,
				'strTag' => $strTag,
			];
		}
	}
}

$cases = [
  'nginx',
  'nginx:1.25',
  'nginx:latest',
  'library/nginx',
  'library/nginx:stable-alpine',
  'lscr.io/linuxserver/sonarr',
  'lscr.io/linuxserver/sonarr:latest',
  'lscr.io/linuxserver/sonarr:develop',
  'linuxserver/plex',
  'registry.local:5000/foo/bar',
  'registry.local:5000/foo/bar:tag',
  'localhost:5000/app',
  'ghcr.io/a/b:v1.2.3',
  'ghcr.io/home-assistant/home-assistant:2024.10.1',
  'docker.io/library/postgres:16',
  ' jlesage/firefox ',
  'foo:a:b',
  'a/b:c/d',
];

$out = [];
foreach ($cases as $case) {
  $out[] = ['image' => $case, 'key' => Oracle::ensureImageTag($case)];
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
