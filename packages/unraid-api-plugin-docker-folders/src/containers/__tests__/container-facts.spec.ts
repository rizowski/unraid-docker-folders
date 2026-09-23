import { describe, expect, it } from 'vitest';

import { envValue, extractFacts, parsePortBindings } from '../container-facts.js';

/**
 * These cases are synthetic on purpose.
 *
 * The port was checked against PHP the strong way first: `extractFacts` was
 * lifted out of `DockerClient.php` and run against `docker inspect` for all 39
 * containers on the live server, and this implementation agreed on every one.
 * That sample covered the branches that matter - 30 containers with published
 * ports, 3 privileged, 1 with added capabilities, 14 setting PUID and 9 setting
 * UMASK.
 *
 * None of it is committed. An inspect payload carries `Config.Env`, which on a
 * real server holds API keys and passwords, so the fixture stays off disk and
 * the suite keeps the same branches with data that was made up. Rerun the
 * comparison with `scripts/facts-oracle.php` after changing anything here.
 */
describe('extractFacts', () => {
    it('reads everything the container list cannot get from Docker', () => {
        const facts = extractFacts({
            HostConfig: {
                Privileged: true,
                CapAdd: ['SYS_ADMIN', 'NET_RAW'],
                PortBindings: { '8080/tcp': [{ HostIp: '0.0.0.0', HostPort: '18080' }] },
            },
            Config: {
                ExposedPorts: { '8080/tcp': {}, '9000/udp': {} },
                User: 'abc',
                Env: ['PUID=99', 'PGID=100', 'UMASK=022'],
            },
        });

        expect(facts).toEqual({
            ports: [{ hostIp: '0.0.0.0', hostPort: 18080, containerPort: 8080, type: 'tcp' }],
            privileged: true,
            capAdd: ['SYS_ADMIN', 'NET_RAW'],
            exposedPorts: ['8080/tcp', '9000/udp'],
            user: 'abc',
            puid: '99',
            pgid: '100',
            umask: '022',
        });
    });

    // A container with neither section is the common case for a stopped
    // container inspected through a partial payload, and it must not throw.
    it('answers empty for a payload with nothing in it', () => {
        expect(extractFacts({})).toEqual({
            ports: [],
            privileged: false,
            capAdd: [],
            exposedPorts: [],
            user: '',
            puid: '',
            pgid: '',
            umask: '',
        });
    });

    it('survives a null HostConfig and Config', () => {
        expect(extractFacts({ HostConfig: null, Config: null }).privileged).toBe(false);
    });

    // PHP reads Privileged with empty(), so anything falsy is false.
    it('reads privileged the way PHP does', () => {
        expect(extractFacts({ HostConfig: { Privileged: false } }).privileged).toBe(false);
        expect(extractFacts({ HostConfig: {} }).privileged).toBe(false);
        expect(extractFacts({ HostConfig: { Privileged: true } }).privileged).toBe(true);
    });
});

describe('envValue', () => {
    it('splits on the first equals only, because a value contains more', () => {
        expect(envValue(['JWT=a=b=c'], 'JWT')).toBe('a=b=c');
    });

    it('answers empty for a variable that is not set', () => {
        expect(envValue(['PATH=/usr/bin'], 'PUID')).toBe('');
        expect(envValue([], 'PUID')).toBe('');
        expect(envValue(null, 'PUID')).toBe('');
    });

    // PUID_EXTRA must not answer a request for PUID.
    it('does not match a variable whose name merely starts the same', () => {
        expect(envValue(['PUID_EXTRA=1'], 'PUID')).toBe('');
    });

    it('keeps an empty value distinct from an absent one only by position', () => {
        expect(envValue(['UMASK='], 'UMASK')).toBe('');
    });
});

describe('parsePortBindings', () => {
    it('flattens every binding of every port', () => {
        expect(
            parsePortBindings({
                '80/tcp': [
                    { HostIp: '0.0.0.0', HostPort: '8080' },
                    { HostIp: '::', HostPort: '8080' },
                ],
                '53/udp': [{ HostIp: '', HostPort: '5353' }],
            })
        ).toEqual([
            { hostIp: '0.0.0.0', hostPort: 8080, containerPort: 80, type: 'tcp' },
            { hostIp: '::', hostPort: 8080, containerPort: 80, type: 'tcp' },
            { hostIp: '', hostPort: 5353, containerPort: 53, type: 'udp' },
        ]);
    });

    // A port declared but not published. PHP's json_decode turns Docker's
    // empty object into an empty array, which falls out the same way.
    it('skips a port with no bindings', () => {
        expect(parsePortBindings({ '80/tcp': [], '443/tcp': null })).toEqual([]);
    });

    /**
     * An empty HostPort means Docker assigns a new one on every start. These
     * facts are cached per container id and never invalidated, because every
     * other field is immutable for that id, so caching a random port would
     * serve a stale number from then on. The live value already arrives in the
     * list endpoint's own `ports`, which is refetched every time. Confirmed as
     * deliberate against the PHP side rather than assumed.
     */
    it('skips a binding whose host port Docker picks at random', () => {
        expect(parsePortBindings({ '80/tcp': [{ HostIp: '', HostPort: '' }] })).toEqual([]);
    });

    it('defaults a port with no protocol to tcp', () => {
        expect(parsePortBindings({ '80': [{ HostPort: '8080' }] })[0].type).toBe('tcp');
    });

    it('answers empty for anything that is not a map', () => {
        expect(parsePortBindings(null)).toEqual([]);
        expect(parsePortBindings('nonsense')).toEqual([]);
    });
});
