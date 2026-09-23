import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DockerFoldersScheduleInput, DockerFoldersScheduleToggle } from '../schedule.model.js';

/**
 * The same pipe the API installs (see `folder.model.spec.ts` for the full
 * rationale): `whitelist: true` keeps only decorated properties, and
 * `forbidNonWhitelisted: true` turns anything else into a 400. Building the
 * pipe here, rather than trusting the decorators by eye, is the point — a
 * schema probe stops at auth, and a service-level test never goes through a
 * resolver, so neither would catch a property missing its decorator.
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

async function reasons(input: unknown, metatype: unknown): Promise<string[]> {
    try {
        await apiPipe().transform(input, meta(metatype));
    } catch (error) {
        const response = (error as { getResponse(): { message?: string[] } }).getResponse();
        return response.message ?? [];
    }
    throw new Error('The pipe accepted input it should have refused');
}

describe('DockerFoldersScheduleInput, against the API validation pipe', () => {
    it('keeps every field of a full create/update body', async () => {
        const input = {
            name: 'Nightly backup',
            targetType: 'container',
            targetId: 'plex',
            action: 'backup',
            cronExpression: '0 3 * * *',
            enabled: true,
            backupConfigJson: '{"paths":["/config"]}',
        };

        await expect(apiPipe().transform(input, meta(DockerFoldersScheduleInput))).resolves.toEqual(input);
    });

    it('accepts an empty body, the way a partial PUT sends one', async () => {
        await expect(apiPipe().transform({}, meta(DockerFoldersScheduleInput))).resolves.toEqual({});
    });

    /**
     * `create()` in schedule.service.ts stores `enabled === undefined ? 1 :
     * enabled ? 1 : 0`, which reads `enabled: null` as `0` — unlike PHP's
     * `isset($data['enabled'])`, which reads a `null` value as absent and
     * defaults to `1`. `@IsOptional()` lets `null` straight through the pipe
     * (it only skips the other validators), so this is the input shape that
     * reaches the service when a GraphQL caller sends `enabled: null`
     * explicitly. See the differential report for the recommended fix.
     */
    it('lets enabled: null through, which is the reachable case behind the create() divergence', async () => {
        await expect(
            apiPipe().transform({ enabled: null }, meta(DockerFoldersScheduleInput))
        ).resolves.toEqual({ enabled: null });
    });

    it('still refuses a property no field declares', async () => {
        expect(await reasons({ name: 'x', dropTable: 1 }, DockerFoldersScheduleInput)).toContain(
            'property dropTable should not exist'
        );
    });

    it('refuses a target type outside the allowlist', async () => {
        expect((await reasons({ targetType: 'vm' }, DockerFoldersScheduleInput)).join(' ')).toMatch(/targetType/);
    });

    it('refuses an action outside the allowlist', async () => {
        expect((await reasons({ action: 'delete' }, DockerFoldersScheduleInput)).join(' ')).toMatch(/action/);
    });

    it('refuses a name of the wrong type', async () => {
        expect((await reasons({ name: 42 }, DockerFoldersScheduleInput)).join(' ')).toMatch(/name/);
    });

    it('refuses an enabled of the wrong type', async () => {
        expect((await reasons({ enabled: 'yes' }, DockerFoldersScheduleInput)).join(' ')).toMatch(/enabled/);
    });
});

describe('DockerFoldersScheduleToggle, against the API validation pipe', () => {
    it('keeps both required fields', async () => {
        const input = { id: 7, enabled: false };

        await expect(apiPipe().transform(input, meta(DockerFoldersScheduleToggle))).resolves.toEqual(input);
    });

    it('refuses a missing id, unlike the optional schedule input', async () => {
        expect((await reasons({ enabled: true }, DockerFoldersScheduleToggle)).join(' ')).toMatch(/id/);
    });

    it('refuses a missing enabled', async () => {
        expect((await reasons({ id: 1 }, DockerFoldersScheduleToggle)).join(' ')).toMatch(/enabled/);
    });

    it('still refuses a property no field declares', async () => {
        expect(await reasons({ id: 1, enabled: true, extra: 'x' }, DockerFoldersScheduleToggle)).toContain(
            'property extra should not exist'
        );
    });
});
