// Mirrors api/src/unraid-api/plugin/plugin.interface.ts so an invalid export
// shape fails here instead of on the server, where it surfaces only as an
// Unraid notification and a line in /var/log/graphql-api.log.
import assert from 'node:assert/strict';

const mod = await import('../dist/index.js');
const isClass = (v) => typeof v === 'function' && v.toString().startsWith('class');

assert.equal(mod.adapter, 'nestjs', "export 'adapter' must be the literal 'nestjs'");
assert.ok(
    mod.ApiModule || mod.CliModule,
    'at least one of ApiModule or CliModule must be exported'
);
for (const name of ['ApiModule', 'CliModule']) {
    if (mod[name] !== undefined) {
        assert.ok(isClass(mod[name]), `${name} must be a class constructor`);
    }
}
console.log('plugin shape OK:', {
    adapter: mod.adapter,
    ApiModule: mod.ApiModule?.name ?? null,
    CliModule: mod.CliModule?.name ?? null,
});
