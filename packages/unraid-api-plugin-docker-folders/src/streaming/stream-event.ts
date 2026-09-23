import { Field, ObjectType } from '@nestjs/graphql';

/**
 * One SSE-equivalent event, generically. `event` is the SSE event name
 * `pull.php`/`compose-stream.php` would send (`status`, `progress`, `phase`,
 * `log`, `recreating`, `recreated`, `recreate_error`, `complete`, `error`,
 * `done`); `data` is that event's JSON payload, pre-encoded to a string —
 * exactly what would follow `data: ` on the wire. One GraphQL type serves
 * both the pull and the compose stream subscriptions this way, instead of a
 * GraphQL union per event variant: the frontend already treats SSE this way
 * (`JSON.parse` the `data:` line after reading `event:`), so this is a direct
 * translation of the existing contract, not a new one.
 *
 * Named `DockerFoldersStreamEvent`, not `DockerFoldersComposeStreamEvent` —
 * that name is already a (non-GraphQL) TypeScript interface in
 * `compose.model.ts` and reusing it here would collide on import. Every
 * plugin GraphQL type name must start with `DockerFolders`: a name upstream
 * already uses takes the whole server's GraphQL offline, not just this
 * plugin's part of the schema.
 */
@ObjectType()
export class DockerFoldersStreamEvent {
    @Field(() => String, {
        description: 'The SSE event name pull.php/compose-stream.php would send, e.g. "progress", "phase", "log", "complete", "error", "done".',
    })
    event!: string;

    @Field(() => String, {
        description:
            'JSON-encoded payload — the same object pull.php/compose-stream.php would put after ' +
            '"data: ". Parse it like an SSE data line.',
    })
    data!: string;
}

/**
 * Converts one `{type, ...fields}` discriminated-union member (the shape
 * `pull-events.ts` and `ComposeService`'s streaming events use internally)
 * into the wire shape above: `type` becomes `event`, and every other field
 * is JSON-encoded into `data`.
 */
export function toStreamEvent<T extends { type: string }>(event: T): DockerFoldersStreamEvent {
    const { type, ...rest } = event;
    return { event: type, data: JSON.stringify(rest) };
}
