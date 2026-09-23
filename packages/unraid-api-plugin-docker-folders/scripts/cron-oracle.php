<?php
/**
 * Generates __tests__/php-next-run.fixture.json.
 *
 * Reads ScheduleManager.php, lifts its three pure static cron methods out
 * verbatim, and runs them. Lifting rather than reimplementing is the point:
 * the fixture has to record what PHP actually answers, or the differential
 * test only proves the port agrees with a second reading of the same code.
 *
 * Run it where PHP is - the target server is the easiest place:
 *
 *   scp scripts/cron-oracle.php tower:/tmp/
 *   ssh tower 'php /tmp/cron-oracle.php' > src/schedules/__tests__/php-next-run.fixture.json
 *
 * The zone is fixed here and pinned again in the test, because the
 * daylight-saving cases only differ in a zone that observes it.
 */

date_default_timezone_set('America/Denver');

$source = __DIR__ . '/../../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';
if (!is_file($source)) {
    // On the server, where only the installed plugin is present.
    $source = '/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/ScheduleManager.php';
}
if (!is_file($source)) {
    fwrite(STDERR, "Cannot find ScheduleManager.php\n");
    exit(1);
}

$php = file_get_contents($source);
$start = strpos($php, '  public static function computeNextRun(');
$end = strrpos($php, '}');
if ($start === false || $end === false) {
    fwrite(STDERR, "Could not locate computeNextRun in ScheduleManager.php\n");
    exit(1);
}

eval('class Oracle {' . substr($php, $start, $end - $start) . '}');

$expressions = [
    '0 3 * * *', '*/15 * * * *', '0 */6 * * *', '0 3 * * 0', '0 3 * * 7',
    '30 2 1 * *', '0 0 1 1 *', '0 3,15 * * *', '5-25/10 * * * *', '0 9-17 * * 1-5',
    '*/7 * * * *', '0 0 29 2 *', '59 23 31 12 *', '0 2 * * 6', '0/3 * * * *',
    '0 1 15 6 *', '* * * * *', '0 0 * * 1,3,5', '45 */4 * * *', '0 3 */2 * *',
];

// Fixed anchors straddle both daylight-saving boundaries in the zone above,
// a leap day, and a year boundary. The rest are spread over three years.
$anchors = [
    1772103600, 1772866800, 1773126000, 1792076400,
    1793286000, 1793890800, 1767250800, 1740787200,
];

mt_srand(20260921);
$out = [];
foreach ($expressions as $expr) {
    foreach ($anchors as $after) {
        $out[] = ['expr' => $expr, 'after' => $after, 'next' => Oracle::computeNextRun($expr, $after)];
    }
    for ($i = 0; $i < 6; $i++) {
        $after = mt_rand(1735689600, 1830297600);
        $out[] = ['expr' => $expr, 'after' => $after, 'next' => Oracle::computeNextRun($expr, $after)];
    }
}

echo json_encode($out, JSON_PRETTY_PRINT), "\n";
