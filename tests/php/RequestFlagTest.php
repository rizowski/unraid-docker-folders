<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/include/config.php';

error_reporting(E_ALL);
ini_set('display_errors', '1');

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

/**
 * requestFlag(), which reads a boolean flag from a request.
 */
final class RequestFlagTest extends TestCase
{
    #[Test]
    public function theStringFalseIsFalse(): void
    {
        // !empty() read this as true, which is the bug this helper replaces.
        $this->assertFalse(requestFlag('false'));
        $this->assertFalse(requestFlag('0'));
        $this->assertFalse(requestFlag('off'));
        $this->assertFalse(requestFlag(''));
    }

    #[Test]
    public function trueValuesAreTrue(): void
    {
        $this->assertTrue(requestFlag(true));
        $this->assertTrue(requestFlag(1));
        $this->assertTrue(requestFlag('1'));
        $this->assertTrue(requestFlag('true'));
        $this->assertTrue(requestFlag(' yes '));
    }

    #[Test]
    public function anythingElseIsFalse(): void
    {
        $this->assertFalse(requestFlag(false));
        $this->assertFalse(requestFlag(0));
        $this->assertFalse(requestFlag(null));
        $this->assertFalse(requestFlag('maybe'));
        $this->assertFalse(requestFlag(['true']));
    }
}
