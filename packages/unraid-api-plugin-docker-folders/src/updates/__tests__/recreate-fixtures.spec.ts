import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Dockerode from 'dockerode';
import { describe, expect, it } from 'vitest';

import { buildCreateBody } from '../recreate.service.js';

/**
 * The same fixtures `tests/php/DockerClientRecreateBodyTest.php` reads: for
 * the same inspect data, both backends must build the same create body.
 * NetworkingConfig is left out of the comparison: PHP creates with the primary
 * network only and connects the rest afterwards, the plugin sends them all.
 */
interface Case {
    name: string;
    inspect: Dockerode.ContainerInspectInfo;
    oldImageConfig: Record<string, unknown> | null;
    newImageConfig: Record<string, unknown> | null;
    image: string;
    expected: Record<string, unknown>;
}

const fixturePath = resolve(fileURLToPath(import.meta.url), '../../../../../../tests/fixtures/recreate/cases.json');
const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as Case[];

describe('recreate create body: fixtures shared with PHP', () => {
    it('has fixtures', () => {
        expect(cases.length).toBeGreaterThan(0);
    });

    it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
        const body = buildCreateBody(c.inspect, 'app', c.oldImageConfig, c.newImageConfig);
        delete body.NetworkingConfig;
        expect(body).toEqual(c.expected);
    });
});
