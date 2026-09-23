import { Observable, type Subscription } from 'rxjs';

/**
 * Converts a cold RxJS `Observable` into an `AsyncIterableIterator`, the
 * shape `@nestjs/graphql` (backed by `graphql-subscriptions`) expects a
 * `@Subscription` resolver method to return — see `EventResolver` for the
 * existing example (`pubsub.asyncIterableIterator(...)`), which this plugin's
 * streaming subscriptions cannot use because their source isn't a pubsub
 * topic, it's a one-off Observable started by the subscribe call itself
 * (`UpdatesService.pullImageEvents`, `ComposeService.streamStackUp`/
 * `streamStackPull`).
 *
 * Buffers every value the source pushes before a consumer calls `.next()`.
 * Both source Observables above emit synchronously, before the GraphQL
 * execution engine ever awaits anything, so an implementation that only
 * pulled on demand would drop early events.
 *
 * `.return()` — called when the execution engine tears a subscription down,
 * e.g. a client unsubscribing or a dropped websocket — unsubscribes from the
 * source. Whether that stops the underlying work is entirely up to the
 * source's own teardown; this helper only forwards the unsubscribe and does
 * not itself decide anything about cancellation. `UpdatesService.pullImageEvents`
 * and `ComposeService.streamStackUp`/`streamStackPull` deliberately have a
 * no-op teardown, so the background pull/compose run keeps going to
 * completion after this happens — the same behavior as
 * `pull.php`/`compose-stream.php`'s `ignore_user_abort(true)`. The log follow
 * stream (`ContainerLogsService.logStream`) and a stats stream being added
 * separately are the exception: unsubscribing from either really does stop
 * the underlying work (the Docker follow socket is `destroy()`'d), because
 * there is no PHP-side "keep going after the browser tab closes" behavior to
 * match for either — both exist only to feed one connected client.
 */
export function observableToAsyncIterator<T>(source: Observable<T>): AsyncIterableIterator<T> {
    type Item = { done: false; value: T } | { done: true; error?: unknown };

    const queue: Item[] = [];
    const waiting: Array<(item: Item) => void> = [];
    let finished = false;

    const push = (item: Item): void => {
        // A source that keeps emitting after its own complete()/error() would
        // violate the Observable contract; guard against it anyway so a
        // buggy source can't resurrect an iterator a consumer already ended.
        if (finished) return;
        if (item.done) finished = true;

        const resolve = waiting.shift();
        if (resolve) {
            resolve(item);
        } else {
            queue.push(item);
        }
    };

    const subscription: Subscription = source.subscribe({
        next: (value) => push({ done: false, value }),
        error: (error: unknown) => push({ done: true, error }),
        complete: () => push({ done: true }),
    });

    return {
        async next(): Promise<IteratorResult<T>> {
            const item = queue.length > 0 ? (queue.shift() as Item) : await new Promise<Item>((resolve) => waiting.push(resolve));

            if (item.done) {
                if ('error' in item && item.error !== undefined) {
                    throw item.error;
                }
                return { value: undefined, done: true };
            }

            return { value: item.value, done: false };
        },

        async return(value?: unknown): Promise<IteratorResult<T>> {
            finished = true;
            subscription.unsubscribe();
            return { value: value as T, done: true };
        },

        async throw(error?: unknown): Promise<IteratorResult<T>> {
            finished = true;
            subscription.unsubscribe();
            throw error;
        },

        [Symbol.asyncIterator]() {
            return this;
        },
    };
}

/**
 * Maps each value of an Observable to a new value, without pulling in
 * `rxjs/operators` for one call site. Errors and completion pass through
 * unchanged; unsubscribing from the result unsubscribes from `source`.
 */
export function mapObservable<T, R>(source: Observable<T>, project: (value: T) => R): Observable<R> {
    return new Observable<R>((subscriber) => {
        const subscription = source.subscribe({
            next: (value) => subscriber.next(project(value)),
            error: (error: unknown) => subscriber.error(error),
            complete: () => subscriber.complete(),
        });

        return () => subscription.unsubscribe();
    });
}
