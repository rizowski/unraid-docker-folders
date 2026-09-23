/**
 * The events `pull.php` streams over SSE, as a discriminated union rather
 * than GraphQL types: this plugin exposes them from `UpdatesService` as a
 * plain RxJS `Observable`, and the caller who asked for this (see the commit
 * that added it) owns turning that into a GraphQL subscription and a union
 * type — including whatever `DockerFolders`-prefixed type names it needs.
 * Nothing here is a `@ObjectType`.
 *
 * Every variant's fields match its `sendSSE()` call in `pull.php` — see
 * `UpdatesService.pullImage`'s doc for the terminal-event contract
 * (`complete`/`error` exactly once, then `done`, then the stream ends).
 */

export interface DockerFoldersPullStatusEvent {
    type: 'status';
    message: string;
}

export interface DockerFoldersPullProgressEvent {
    type: 'progress';
    id: string;
    status: string;
    current: number | null;
    total: number | null;
}

export interface DockerFoldersPullErrorEvent {
    type: 'error';
    message: string;
}

export interface DockerFoldersPullRecreatingEvent {
    type: 'recreating';
    container: string;
    message: string;
}

export interface DockerFoldersPullRecreatedEvent {
    type: 'recreated';
    container: string;
    message: string;
}

export interface DockerFoldersPullRecreateErrorEvent {
    type: 'recreate_error';
    container: string;
    message: string;
}

export interface DockerFoldersPullCompleteEvent {
    type: 'complete';
    message: string;
    image: string;
}

export interface DockerFoldersPullDoneEvent {
    type: 'done';
    finished: true;
}

export type DockerFoldersPullEvent =
    | DockerFoldersPullStatusEvent
    | DockerFoldersPullProgressEvent
    | DockerFoldersPullErrorEvent
    | DockerFoldersPullRecreatingEvent
    | DockerFoldersPullRecreatedEvent
    | DockerFoldersPullRecreateErrorEvent
    | DockerFoldersPullCompleteEvent
    | DockerFoldersPullDoneEvent;
