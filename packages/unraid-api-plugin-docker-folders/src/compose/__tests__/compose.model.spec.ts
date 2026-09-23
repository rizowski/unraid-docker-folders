import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DockerFoldersComposeAutostartInput, DockerFoldersComposeCreateInput } from '../compose.model.js';

/**
 * The same pipe the API installs, with the same options. See
 * `folder.model.spec.ts` for the full story: a `@Field` with no
 * class-validator decorator is invisible to `whitelist: true`, so the whole
 * property is rejected — "property name should not exist" — which is exactly
 * what happened to every folder write in GraphQL mode on tower before this
 * kind of test existed.
 */
function apiPipe() {
    return new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
}

function meta(metatype: unknown): ArgumentMetadata {
    return { type: 'body', metatype: metatype as ArgumentMetadata['metatype'] };
}

describe('compose inputs, against the API validation pipe', () => {
    describe('DockerFoldersComposeCreateInput', () => {
        it('keeps every field of a full create', async () => {
            const input = { projectName: 'grafana', composeContent: 'services:\n  app: {}\n', envContent: 'A=1' };
            await expect(apiPipe().transform(input, meta(DockerFoldersComposeCreateInput))).resolves.toEqual(input);
        });

        it('accepts a create with only the required project name', async () => {
            const input = { projectName: 'grafana' };
            await expect(apiPipe().transform(input, meta(DockerFoldersComposeCreateInput))).resolves.toEqual(input);
        });

        it('still refuses a property no field declares', async () => {
            await expect(
                apiPipe().transform({ projectName: 'x', dropTable: 1 }, meta(DockerFoldersComposeCreateInput))
            ).rejects.toMatchObject({
                response: { message: expect.arrayContaining(['property dropTable should not exist']) },
            });
        });

        it('still refuses a missing required field', async () => {
            await expect(apiPipe().transform({}, meta(DockerFoldersComposeCreateInput))).rejects.toBeDefined();
        });
    });

    describe('DockerFoldersComposeAutostartInput', () => {
        it('keeps both fields', async () => {
            const input = { enabled: true, forceRecreate: false };
            await expect(
                apiPipe().transform(input, meta(DockerFoldersComposeAutostartInput))
            ).resolves.toEqual(input);
        });

        it('accepts enabled alone, forceRecreate being optional', async () => {
            const input = { enabled: false };
            await expect(
                apiPipe().transform(input, meta(DockerFoldersComposeAutostartInput))
            ).resolves.toEqual(input);
        });

        it('refuses a non-boolean enabled', async () => {
            await expect(
                apiPipe().transform({ enabled: 'yes' }, meta(DockerFoldersComposeAutostartInput))
            ).rejects.toBeDefined();
        });
    });
});
