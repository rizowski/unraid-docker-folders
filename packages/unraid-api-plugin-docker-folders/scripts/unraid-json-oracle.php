<?php
/**
 * Builds the fixture for how Unraid reads and writes its JSON state files,
 * from Unraid's own code.
 *
 * /var/lib/docker/unraid-update-status.json and the Docker tab's docker.json
 * are read with DockerUtil::loadJSON() and written with saveJSON(). Both
 * methods below are copied verbatim from unraid/webgui
 * emhttp/plugins/dynamix.docker.manager/include/DockerClient.php (class
 * DockerUtil), so the fixture records Unraid's answer, not a second reading
 * of it. Both backends must write the same bytes for the same content, and
 * read a list the way loadJSON() does.
 *
 *   php unraid-json-oracle.php > src/updates/__tests__/unraid-json.fixture.json
 *
 * tests/php/UnraidUpdateStatusTest.php and
 * src/updates/__tests__/unraid-update-status.spec.ts both read the fixture.
 * `input` is JSON text, `output` is what saveJSON() writes for it after
 * loadJSON()'s decode.
 */
class Oracle {
	public static function saveJSONString($content) {
		return json_encode($content, JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES);
	}

	public static function loadJSONString($raw) {
		$objContent = json_decode($raw, true);
		if (empty($objContent)) $objContent = [];
		return $objContent;
	}
}

$inputs = [
	'{}',
	'[]',
	'{"nginx":{"local":"sha256:a","remote":"sha256:b","status":"false"}}',
	'{"a/b:latest":{"status":"true"}}',
	'{"café":{"name":"Plèx ☃ 😀"}}',
	'{"plex":{"template":[],"ports":{}}}',
	'{"x":{"nested":{"deep":{"k":"v"}}}}',
	'["a","b"]',
	'{"0":"a","1":"b"}',
	'{"k":"line\nbreak\ttab \"quote\" \\\\ back"}',
	'{"n":1,"f":1.5,"t":true,"z":null}',
];

$cases = [];
foreach ($inputs as $input) {
	$cases[] = ['input' => $input, 'output' => Oracle::saveJSONString(Oracle::loadJSONString($input))];
}
// A non-empty list that gets a string key, as when a list file is added to.
$list = Oracle::loadJSONString('["a","b"]');
$list['lscr.io/linuxserver/sonarr:latest'] = ['status' => 'true'];
$cases[] = ['input' => '["a","b"] + key', 'output' => Oracle::saveJSONString($list)];

echo json_encode($cases, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
