<?php

declare(strict_types=1);

/**
 * PHPUnit bootstrap.
 *
 * PHPUnit writes its banner and progress output to stdout. Under the CLI SAPI
 * any unbuffered output makes PHP treat headers as sent, after which
 * session_name(), session_id() and session_start() all refuse to run:
 *
 *   session_start(): Session cannot be started after headers have already been sent
 *
 * That silently breaks every test covering validateSession()'s Unraid session
 * cookie path, because session_start() never loads the session file and the
 * function correctly reports "not authenticated".
 *
 * Starting an output buffer here — bootstrap runs before PHPUnit emits anything
 * — keeps headers_sent() false for the whole run. The buffer flushes normally at
 * shutdown, so test output is unaffected.
 */
ob_start();
