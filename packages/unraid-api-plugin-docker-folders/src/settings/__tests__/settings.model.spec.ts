import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ALLOWED_SETTING_KEYS, DockerFoldersSettingInput, isAllowedSettingKey } from '../settings.model.js';

/**
 * The same pipe the API installs, with the same options. See
 * `folder.model.spec.ts` for why this is built here rather than trusted by
 * eye: the schema probes stop at auth, and a unit test calling the service
 * directly never goes through a resolver either, so neither would catch a
 * `@Field` that has no matching class-validator decorator.
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

describe('DockerFoldersSettingInput, against the API validation pipe', () => {
    it('keeps both fields, instead of rejecting them', async () => {
        const input = { key: 'sort_mode', value: 'name-asc' };

        await expect(apiPipe().transform(input, meta(DockerFoldersSettingInput))).resolves.toEqual(input);
    });

    async function reasons(input: unknown): Promise<string[]> {
        try {
            await apiPipe().transform(input, meta(DockerFoldersSettingInput));
        } catch (error) {
            const response = (error as { getResponse(): { message?: string[] } }).getResponse();
            return response.message ?? [];
        }
        throw new Error('The pipe accepted input it should have refused');
    }

    it('still refuses a property no field declares', async () => {
        expect(await reasons({ key: 'sort_mode', value: 'name-asc', dropTable: 1 })).toContain(
            'property dropTable should not exist'
        );
    });

    it('still refuses a missing value', async () => {
        expect((await reasons({ key: 'sort_mode' })).join(' ')).toMatch(/value/);
    });

    it('still refuses a value of the wrong type', async () => {
        expect((await reasons({ key: 'update_concurrency', value: 3 })).join(' ')).toMatch(/value/);
    });
});

describe('isAllowedSettingKey', () => {
    it('accepts every key in the allowlist', () => {
        for (const key of ALLOWED_SETTING_KEYS) {
            expect(isAllowedSettingKey(key)).toBe(true);
        }
    });

    it('rejects a key PHP does not recognize either', () => {
        expect(isAllowedSettingKey('csrf_token')).toBe(false);
    });

    it('rejects the synthetic read-only key', () => {
        expect(isAllowedSettingKey('server_timezone')).toBe(false);
    });
});
