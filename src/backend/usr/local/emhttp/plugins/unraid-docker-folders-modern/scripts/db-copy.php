<?php
/**
 * Unraid Docker Folders - Copy the database through SQLite
 *
 * Usage:
 *   php db-copy.php backup  <database> <backup-file>
 *   php db-copy.php restore <backup-file> <database>
 *
 * The .plg used `cp` for both. A raw copy of a WAL database is not safe while
 * anything has it open, and during an install something always does: the
 * running Unraid API plugin, a PHP request, or the schedule runner. A copy
 * made with `cp` misses commits that are still in `data.db-wal`, and a `cp`
 * over the live file leaves the old WAL beside the new file, where the next
 * connection applies it to the wrong database.
 *
 * SQLite's online backup API avoids both. It reads a consistent snapshot,
 * WAL included, and it writes the destination through SQLite's own locking,
 * so connections that already have the file open see the new content rather
 * than a file swapped under them. Exits non-zero on any failure.
 *
 * @package UnraidDockerModern
 */

if (PHP_SAPI !== 'cli') {
  exit(1);
}

[$mode, $from, $to] = array_slice(array_pad($argv, 4, ''), 1, 3);
if (!in_array($mode, ['backup', 'restore'], true) || $from === '' || $to === '') {
  fwrite(STDERR, "Usage: php db-copy.php backup|restore <from> <to>\n");
  exit(2);
}
if (!is_file($from)) {
  fwrite(STDERR, "Not a file: $from\n");
  exit(1);
}

try {
  $source = new SQLite3($from, SQLITE3_OPEN_READONLY);
  $source->busyTimeout(5000);
  // A restore writes into the live database, so it waits for other writers
  // the way every other connection to it does.
  $dest = new SQLite3($to, SQLITE3_OPEN_READWRITE | SQLITE3_OPEN_CREATE);
  $dest->busyTimeout(5000);
  if (!$source->backup($dest)) {
    throw new Exception($dest->lastErrorMsg());
  }
  $check = $dest->querySingle('PRAGMA quick_check');
  if ($check !== 'ok') {
    throw new Exception("quick_check on $to: $check");
  }
  $dest->close();
  $source->close();
} catch (Throwable $e) {
  fwrite(STDERR, "$mode failed: " . $e->getMessage() . "\n");
  exit(1);
}
