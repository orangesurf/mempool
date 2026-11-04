import { HttpErrorResponse } from '@angular/common/http';
import { defer, filter, firstValueFrom, interval, map, Observable, race, retry, switchMap, tap, timer } from 'rxjs';
import type { RequestQueue } from '@app/watch/request-queue';

// Only "come back later" answers (429, 503) are retried; 413 and 504 mean the query is too
// heavy, so resending only adds load. No response at all (status 0) is retried once.
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const MAX_RETRIES = 4;
const MAX_NETWORK_RETRIES = 1;
const RETRYABLE_STATUSES = new Set([429, 503]);

export interface RetryWait {
  status: number;
}

export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
  }
}

/** Retry-After in milliseconds, from delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Delay before retry number `retry` (0-based), or null if the error is not retried. */
export function retryDelayMs(error: unknown, retry: number, random: () => number = Math.random): number | null {
  if (!(error instanceof HttpErrorResponse)) {
    return null;
  }
  if (error.status === 0) {
    return retry < MAX_NETWORK_RETRIES ? RETRY_BASE_MS * (0.75 + 0.5 * random()) : null;
  }
  if (!RETRYABLE_STATUSES.has(error.status) || retry >= MAX_RETRIES) {
    return null;
  }
  const retryAfter = parseRetryAfter(error.headers?.get('Retry-After'));
  if (retryAfter !== null) {
    // Jitter, so clients told the same moment do not all return in step. A wait beyond the
    // cap fails at once rather than keeping the tab busy.
    return retryAfter > RETRY_CAP_MS ? null : retryAfter + 1000 * random();
  }
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retry);
  return Math.min(RETRY_CAP_MS, backoff * (0.75 + 0.5 * random()));
}

export interface RetryOptions {
  /** Called with the status when a wait before a retry starts, and with null when it is over. */
  onWait?: (wait: RetryWait | null) => void;
  isCancelled?: () => boolean;
  queue?: RequestQueue | null;
}

/** Subscribes to `request$`, after queue admission each time, until it succeeds or the error is not retried. */
export function withRetry<T>(request$: Observable<T>, options: RetryOptions = {}): Promise<T> {
  const { onWait, isCancelled, queue } = options;
  // Waits can be long, so a cancelled scan is noticed within a second rather than at the end.
  const cancelled$ = interval(1000).pipe(
    filter(() => !!isCancelled?.()),
    map(() => { throw new RequestCancelledError(); }),
  );
  const attempt$ = defer(async () => {
    if (isCancelled?.()) {
      throw new RequestCancelledError();
    }
    await queue?.take({ isCancelled });
  }).pipe(switchMap(() => request$));
  return firstValueFrom(attempt$.pipe(
    retry({
      delay: (error, retryCount) => {
        const delay = retryDelayMs(error, retryCount - 1);
        if (delay === null) {
          throw error;
        }
        onWait?.({ status: (error as HttpErrorResponse).status });
        return race(timer(delay), cancelled$).pipe(tap(() => onWait?.(null)));
      },
    }),
  ));
}
