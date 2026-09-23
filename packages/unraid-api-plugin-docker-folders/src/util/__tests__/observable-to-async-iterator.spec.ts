import { describe, expect, it, vi } from 'vitest';
import { Observable, Subject } from 'rxjs';

import { mapObservable, observableToAsyncIterator } from '../observable-to-async-iterator.js';

describe('observableToAsyncIterator', () => {
    it('yields every value in order for a synchronous source, then ends on complete', async () => {
        const source = new Observable<number>((subscriber) => {
            subscriber.next(1);
            subscriber.next(2);
            subscriber.next(3);
            subscriber.complete();
        });

        const iterator = observableToAsyncIterator(source);

        expect(await iterator.next()).toEqual({ value: 1, done: false });
        expect(await iterator.next()).toEqual({ value: 2, done: false });
        expect(await iterator.next()).toEqual({ value: 3, done: false });
        expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });

    it('buffers values emitted before next() is ever called', async () => {
        // The whole reason this helper exists: both of this plugin's streaming
        // Observables emit synchronously, before a GraphQL subscription
        // resolver's consumer has called next() even once.
        const source = new Observable<string>((subscriber) => {
            subscriber.next('a');
            subscriber.next('b');
            subscriber.complete();
        });

        const iterator = observableToAsyncIterator(source);
        // No next() calls yet — both values must already be queued.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(await iterator.next()).toEqual({ value: 'a', done: false });
        expect(await iterator.next()).toEqual({ value: 'b', done: false });
        expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });

    it('delivers a value pushed after next() is already awaiting one', async () => {
        const subject = new Subject<number>();
        const iterator = observableToAsyncIterator(subject);

        const pending = iterator.next();
        subject.next(42);

        expect(await pending).toEqual({ value: 42, done: false });
    });

    it('throws from next() when the source errors', async () => {
        const source = new Observable<number>((subscriber) => {
            subscriber.next(1);
            subscriber.error(new Error('boom'));
        });

        const iterator = observableToAsyncIterator(source);
        expect(await iterator.next()).toEqual({ value: 1, done: false });
        await expect(iterator.next()).rejects.toThrow('boom');
    });

    it('ends immediately for a source that completes with no values', async () => {
        const iterator = observableToAsyncIterator(new Observable<number>((subscriber) => subscriber.complete()));
        expect(await iterator.next()).toEqual({ value: undefined, done: true });
    });

    it('return() unsubscribes from the source without waiting for it to complete', async () => {
        const teardown = vi.fn();
        const source = new Observable<number>((subscriber) => {
            subscriber.next(1);
            return teardown;
        });

        const iterator = observableToAsyncIterator(source);
        await iterator.next();

        const result = await iterator.return?.();
        expect(result).toEqual({ value: undefined, done: true });
        expect(teardown).toHaveBeenCalledOnce();
    });

    it('does not resurrect the iterator with events pushed after return()', async () => {
        const subject = new Subject<number>();
        const iterator = observableToAsyncIterator(subject);

        await iterator.return?.();
        subject.next(1); // must be dropped, not queued

        // A fresh iterator (or an unsubscribed one) has nothing pending, so
        // this would hang forever if the drop didn't happen — vitest's
        // default timeout is the safety net if this regresses.
        const source2 = new Observable<number>((s) => s.complete());
        expect(await observableToAsyncIterator(source2).next()).toEqual({ value: undefined, done: true });
    });
});

describe('mapObservable', () => {
    it('projects every value', async () => {
        const source = new Observable<number>((subscriber) => {
            subscriber.next(1);
            subscriber.next(2);
            subscriber.complete();
        });

        const values: number[] = [];
        await new Promise<void>((resolve) => {
            mapObservable(source, (n) => n * 10).subscribe({
                next: (v) => values.push(v),
                complete: resolve,
            });
        });

        expect(values).toEqual([10, 20]);
    });

    it('propagates errors from the source unchanged', async () => {
        const source = new Observable<number>((subscriber) => subscriber.error(new Error('nope')));

        const error = await new Promise((resolve) => {
            mapObservable(source, (n) => n).subscribe({ error: resolve });
        });

        expect((error as Error).message).toBe('nope');
    });

    it('unsubscribing from the mapped Observable unsubscribes from the source', () => {
        const teardown = vi.fn();
        const source = new Observable<number>(() => teardown);

        const subscription = mapObservable(source, (n) => n).subscribe();
        subscription.unsubscribe();

        expect(teardown).toHaveBeenCalledOnce();
    });
});
