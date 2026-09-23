import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DockerFolderCreateInput, DockerFolderUpdateInput } from '../folder.model.js';

/**
 * The same pipe the API installs, with the same options.
 *
 * `api/src/unraid-api/main.ts` sets `whitelist: true` and
 * `forbidNonWhitelisted: true`. Whitelisting keeps only the properties that
 * carry a class-validator decorator; forbidding the rest turns anything else
 * into a 400. An input declared with `@Field` alone therefore has every
 * property rejected, which is what tower did to every folder write in GraphQL
 * mode: "property name should not exist".
 *
 * Building the pipe here rather than trusting the decorators by eye is the
 * point. The schema probes cannot catch this, because they stop at auth, and
 * the equivalence test cannot, because it calls the service directly and never
 * goes through a resolver.
 */
function apiPipe() {
    return new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
    });
}

function meta(metatype: unknown): ArgumentMetadata {
    return { type: 'body', metatype: metatype as ArgumentMetadata['metatype'] };
}

describe('folder inputs, against the API validation pipe', () => {
    it('keeps every field of a create, instead of rejecting it', async () => {
        const input = {
            name: 'Media',
            icon: 'film',
            color: '#b7f019',
            composeProject: 'grafana',
            sortMode: 'name-asc',
        };

        await expect(apiPipe().transform(input, meta(DockerFolderCreateInput))).resolves.toEqual(
            input
        );
    });

    it('accepts a create with nothing in it, the way the default folder is made', async () => {
        await expect(apiPipe().transform({}, meta(DockerFolderCreateInput))).resolves.toEqual({});
    });

    it('keeps every field of an update, including the non-string ones', async () => {
        const input = {
            name: 'Movies',
            icon: 'film',
            color: '#fff',
            position: 2,
            collapsed: true,
            sortMode: 'manual',
        };

        await expect(apiPipe().transform(input, meta(DockerFolderUpdateInput))).resolves.toEqual(
            input
        );
    });

    /**
     * The reasons sit on the exception's response body, not its message, which
     * is the flat string "Bad Request Exception". That is why the GraphQL
     * error on tower carried the real detail under `originalError.message`.
     */
    async function reasons(input: unknown, metatype: unknown): Promise<string[]> {
        try {
            await apiPipe().transform(input, meta(metatype));
        } catch (error) {
            const response = (error as { getResponse(): { message?: string[] } }).getResponse();
            return response.message ?? [];
        }
        throw new Error('The pipe accepted input it should have refused');
    }

    it('still refuses a property no field declares', async () => {
        expect(await reasons({ name: 'Media', dropTable: 1 }, DockerFolderCreateInput)).toContain(
            'property dropTable should not exist'
        );
    });

    it('still refuses a field of the wrong type', async () => {
        expect((await reasons({ position: 'first' }, DockerFolderUpdateInput)).join(' ')).toMatch(
            /position/
        );
    });
});
