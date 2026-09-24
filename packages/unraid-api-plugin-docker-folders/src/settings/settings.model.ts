import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { IsString } from 'class-validator';

/**
 * One row of `key`/`value`, ported from `api/settings.php`.
 *
 * The settings table is a schemaless key-value store, so there is no fixed
 * set of typed fields to give it the way `DockerFolder` has one. An array of
 * these is the GraphQL-native shape for that: it mirrors what the PHP
 * endpoint answers as `{settings: {key: value, ...}}`, just as a list of
 * pairs instead of an object, the same tradeoff `DockerFolderMember[]` makes
 * for folder membership.
 */
@ObjectType()
export class DockerFoldersSetting {
    @Field(() => String)
    key!: string;

    @Field(() => String, { nullable: true })
    value!: string | null;
}

/**
 * Every field needs a class-validator decorator as well as `@Field`, or the
 * API's global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted:
 * true`) rejects the property outright. See `folder.model.ts` for the full
 * story — this bit tower once already.
 *
 * Both fields are required, matching `settings.php`'s
 * `!isset($data['key']) || !isset($data['value'])` guard: a settings write
 * with either missing is not a valid request, not a no-op.
 */
@InputType()
export class DockerFoldersSettingInput {
    @Field(() => String)
    @IsString()
    key!: string;

    @Field(() => String)
    @IsString()
    value!: string;
}

/**
 * The key allowlist from `settings.php`'s `handlePost()`, in the same order.
 * A key outside this list is rejected, not silently ignored — keep this list
 * in sync with the PHP one, including entries (like `show_legacy_containers`)
 * that have no per-key validation of their own. The one deliberate exception
 * is `backend_mode`: switching it installs or removes this plugin, which only
 * the PHP settings page can do.
 */
export const ALLOWED_SETTING_KEYS = [
    'distinguish_healthy',
    'show_stats',
    'replace_docker_section',
    'show_legacy_containers',
    'show_legacy_buttons',
    'show_folder_ports',
    'show_inline_logs',
    'enable_adopt',
    'enable_security_advisor',
    'enable_update_checks',
    'update_check_schedule',
    'notify_on_updates',
    'update_check_exclude',
    'post_pull_action',
    'update_concurrency',
    'log_refresh_interval',
    'stats_refresh_interval',
    'compose_export_dir',
    'backup_destination',
    'default_retention_count',
    'sort_mode',
    'sort_folders',
] as const;

export type AllowedSettingKey = (typeof ALLOWED_SETTING_KEYS)[number];

export function isAllowedSettingKey(key: string): key is AllowedSettingKey {
    return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key);
}
