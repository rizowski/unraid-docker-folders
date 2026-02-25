<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/auth.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\Attributes\DataProvider;

final class AuthTest extends TestCase
{
    private const VAR_INI_DIR = '/var/local/emhttp';
    private const VAR_INI_PATH = '/var/local/emhttp/var.ini';
    private const SYSTEM_TOKEN = 'abc123systemtoken';

    protected function setUp(): void
    {
        // Reset superglobals
        $_SERVER = [];
        $_COOKIE = [];
        $_POST = [];
        $_GET = [];

        // Reset getRawBody() cache
        getRawBody('');

        // Create var.ini with a known CSRF token
        if (!is_dir(self::VAR_INI_DIR)) {
            mkdir(self::VAR_INI_DIR, 0755, true);
        }
        file_put_contents(self::VAR_INI_PATH, 'csrf_token="' . self::SYSTEM_TOKEN . '"' . "\n");
    }

    protected function tearDown(): void
    {
        if (file_exists(self::VAR_INI_PATH)) {
            unlink(self::VAR_INI_PATH);
        }
    }

    // ---------------------------------------------------------------
    // Helper: build a Flask-style session cookie
    // Format: base64url(json_payload).timestamp.signature
    // ---------------------------------------------------------------

    private static function makeFlaskCookie(array $payload): string
    {
        $json = json_encode($payload);
        $b64 = strtr(base64_encode($json), '+/', '-_');
        return $b64 . '.1234567890.fakesig';
    }

    // ---------------------------------------------------------------
    // getRawBody() tests
    // ---------------------------------------------------------------

    #[Test]
    public function getRawBody_returns_override_value(): void
    {
        $result = getRawBody('hello=world');
        $this->assertSame('hello=world', $result);
    }

    #[Test]
    public function getRawBody_caches_value_on_subsequent_calls(): void
    {
        getRawBody('cached_body');
        // Second call without override should return the cached value
        $this->assertSame('cached_body', getRawBody());
    }

    #[Test]
    public function getRawBody_can_be_reset_with_new_override(): void
    {
        getRawBody('first');
        $this->assertSame('first', getRawBody());

        getRawBody('second');
        $this->assertSame('second', getRawBody());
    }

    // ---------------------------------------------------------------
    // getSystemCsrfToken() tests
    // ---------------------------------------------------------------

    #[Test]
    public function getSystemCsrfToken_reads_from_default_var_ini(): void
    {
        $token = getSystemCsrfToken();
        $this->assertSame(self::SYSTEM_TOKEN, $token);
    }

    #[Test]
    public function getSystemCsrfToken_reads_from_custom_path(): void
    {
        $tmpFile = tempnam(sys_get_temp_dir(), 'varini');
        file_put_contents($tmpFile, 'csrf_token="custom_token_value"' . "\n");

        $token = getSystemCsrfToken($tmpFile);
        $this->assertSame('custom_token_value', $token);

        unlink($tmpFile);
    }

    #[Test]
    public function getSystemCsrfToken_returns_null_when_file_missing(): void
    {
        $token = getSystemCsrfToken('/nonexistent/path/var.ini');
        $this->assertNull($token);
    }

    #[Test]
    public function getSystemCsrfToken_returns_null_when_token_key_missing(): void
    {
        $tmpFile = tempnam(sys_get_temp_dir(), 'varini');
        file_put_contents($tmpFile, 'some_other_key="value"' . "\n");

        $token = getSystemCsrfToken($tmpFile);
        $this->assertNull($token);

        unlink($tmpFile);
    }

    // ---------------------------------------------------------------
    // validateSession() tests
    // ---------------------------------------------------------------

    #[Test]
    public function validateSession_returns_false_with_no_cookie(): void
    {
        $_COOKIE = [];
        $this->assertFalse(validateSession());
    }

    #[Test]
    public function validateSession_returns_true_with_valid_flask_cookie(): void
    {
        $_COOKIE['session'] = self::makeFlaskCookie(['csrf_token' => 'some_token']);
        $this->assertTrue(validateSession());
    }

    #[Test]
    public function validateSession_returns_false_with_malformed_base64_cookie(): void
    {
        // Not valid base64 at all, but explode will still give 3 parts
        $_COOKIE['session'] = '!!!invalid!!!.1234567890.sig';
        $this->assertFalse(validateSession());
    }

    #[Test]
    public function validateSession_returns_false_with_empty_csrf_token_in_cookie(): void
    {
        $_COOKIE['session'] = self::makeFlaskCookie(['csrf_token' => '']);
        $this->assertFalse(validateSession());
    }

    #[Test]
    public function validateSession_returns_false_with_missing_csrf_token_in_payload(): void
    {
        $_COOKIE['session'] = self::makeFlaskCookie(['user' => 'admin']);
        $this->assertFalse(validateSession());
    }

    #[Test]
    public function validateSession_returns_false_with_empty_cookie(): void
    {
        $_COOKIE['session'] = '';
        $this->assertFalse(validateSession());
    }

    #[Test]
    public function validateSession_returns_false_with_single_part_cookie(): void
    {
        // Only one part (no dots) — count($parts) < 2
        $_COOKIE['session'] = 'justastring';
        $this->assertFalse(validateSession());
    }

    // ---------------------------------------------------------------
    // validateCsrfToken() tests
    // ---------------------------------------------------------------

    #[Test]
    public function validateCsrfToken_returns_true_for_GET(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_OPTIONS(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'OPTIONS';
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_POST(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'POST';
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_PUT_with_valid_body_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        getRawBody('csrf_token=' . self::SYSTEM_TOKEN . '&name=test');
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_DELETE_with_valid_body_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'DELETE';
        getRawBody('csrf_token=' . self::SYSTEM_TOKEN);
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_PUT_with_valid_header_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        $_SERVER['HTTP_X_CSRF_TOKEN'] = self::SYSTEM_TOKEN;
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_true_for_DELETE_with_valid_header_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'DELETE';
        $_SERVER['HTTP_X_CSRF_TOKEN'] = self::SYSTEM_TOKEN;
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_prefers_header_over_body(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        $_SERVER['HTTP_X_CSRF_TOKEN'] = self::SYSTEM_TOKEN;
        // Body has a wrong token, but header is correct — should pass
        getRawBody('csrf_token=wrong_token');
        $this->assertTrue(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_false_for_PUT_with_no_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        getRawBody('');
        $this->assertFalse(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_false_for_PUT_with_wrong_token(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        getRawBody('csrf_token=wrong_token_value');
        $this->assertFalse(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_false_for_PUT_with_token_only_in_query(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        $_GET['csrf_token'] = self::SYSTEM_TOKEN;
        getRawBody('');
        $this->assertFalse(validateCsrfToken());
    }

    #[Test]
    public function validateCsrfToken_returns_false_when_var_ini_missing(): void
    {
        // Remove var.ini so getSystemCsrfToken() returns null
        if (file_exists(self::VAR_INI_PATH)) {
            unlink(self::VAR_INI_PATH);
        }

        $_SERVER['REQUEST_METHOD'] = 'PUT';
        getRawBody('csrf_token=anything');
        $this->assertFalse(validateCsrfToken());
    }

    // ---------------------------------------------------------------
    // Integration: body shared between CSRF and request parsing
    // ---------------------------------------------------------------

    #[Test]
    public function csrf_validation_does_not_consume_body_for_later_parsing(): void
    {
        $_SERVER['REQUEST_METHOD'] = 'PUT';
        $body = 'csrf_token=' . self::SYSTEM_TOKEN . '&name=TestFolder&color=%23ff0000';
        getRawBody($body);

        // CSRF validation reads the body
        $this->assertTrue(validateCsrfToken());

        // Subsequent getRawBody() still returns the full body
        $raw = getRawBody();
        $this->assertSame($body, $raw);

        // Parsing the body for API data still works
        parse_str($raw, $parsed);
        $this->assertSame('TestFolder', $parsed['name']);
        $this->assertSame('#ff0000', $parsed['color']);
        $this->assertSame(self::SYSTEM_TOKEN, $parsed['csrf_token']);
    }
}
