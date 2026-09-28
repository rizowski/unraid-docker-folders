<?php

declare(strict_types=1);

require_once __DIR__ . '/../../src/backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/classes/DockerStreamDemuxer.php';

use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\Test;

final class DockerExecDemuxTest extends TestCase
{
    private string $out = '';
    private string $err = '';

    private function demuxer(): DockerStreamDemuxer
    {
        $this->out = '';
        $this->err = '';
        return new DockerStreamDemuxer(
            function (string $p) { $this->out .= $p; },
            function (string $p) { $this->err .= $p; }
        );
    }

    private static function frame(int $stream, string $payload): string
    {
        return pack('CxxxN', $stream, strlen($payload)) . $payload;
    }

    #[Test]
    public function splitsStdoutAndStderr(): void
    {
        $d = $this->demuxer();
        $d->feed(self::frame(1, 'hello ') . self::frame(2, 'warn') . self::frame(1, 'world'));

        $this->assertSame('hello world', $this->out);
        $this->assertSame('warn', $this->err);
        $this->assertFalse($d->hasPartialFrame());
    }

    #[Test]
    public function joinsAFrameSplitAtEveryByte(): void
    {
        // Binary data with CR, LF and NUL, as a pg_dump archive has.
        $payload = "PGDMP\r\n\0\x01\xff" . str_repeat('x', 300);
        $stream = self::frame(1, $payload) . self::frame(2, 'err');
        $d = $this->demuxer();
        foreach (str_split($stream) as $byte) {
            $this->assertSame(1, $d->feed($byte));
        }

        $this->assertSame($payload, $this->out);
        $this->assertSame('err', $this->err);
        $this->assertFalse($d->hasPartialFrame());
    }

    #[Test]
    public function reportsATruncatedStream(): void
    {
        $d = $this->demuxer();
        $d->feed(substr(self::frame(1, 'abcdef'), 0, 10));

        $this->assertSame('', $this->out);
        $this->assertTrue($d->hasPartialFrame());
    }

    #[Test]
    public function stopsWhenStdoutAsksTo(): void
    {
        $seen = [];
        $d = new DockerStreamDemuxer(
            function (string $p) use (&$seen) { $seen[] = $p; return $p !== 'full'; },
            function (string $p) {}
        );
        // 0 is what makes curl abort the transfer.
        $this->assertSame(0, $d->feed(self::frame(1, 'a') . self::frame(1, 'full') . self::frame(1, 'never')));
        $this->assertSame(['a', 'full'], $seen);
    }

    #[Test]
    public function acceptsAnEmptyFrame(): void
    {
        $d = $this->demuxer();
        $d->feed(self::frame(1, '') . self::frame(1, 'x'));

        $this->assertSame('x', $this->out);
        $this->assertFalse($d->hasPartialFrame());
    }
}
