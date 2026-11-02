import { HttpErrorResponse } from '@angular/common/http';
import type { RequestQueue } from '@app/watch/request-queue';

/**
 * Retry policy for the wallet's API requests.
 *
 * Only answers that mean "come back later" are retried: 429 (rate limited) and 503 (busy).
 * 504 and 413 mean the query itself is too heavy for the server, so sending it again only
 * adds load; they fail at once. A request that got no response at all (status 0) is retried
 * once, since a dropped connection is usually transient but a blocked one is not.
 *
 * The wait doubles from RETRY_BASE_MS up to RETRY_CAP_MS, with jitter so that many tabs
 * rate limited together do not come back in step. A Retry-After header takes precedence;
 * one asking for longer than RETRY_CAP_MS fails at once rather than keeping the tab busy.
 * Browsers expose Retry-After on cross-origin responses only when the server lists it in
 * Access-Control-Expose-Headers, so without it the backoff alone applies.
 */
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const MAX_RETRIES = 4;
const MAX_NETWORK_RETRIES = 1;
const RETRYABLE_STATUSES = new Set([429, 503]);

export interface RetryWait {
  /** The status that caused the retry: 429, 503, or 0 for no response. */
  status: number;
  /** Whole seconds until the request is sent again. */
  seconds: number;
}

/** Thrown when the caller no longer wants the result, e.g. the user left the page. */
export class RequestCancelledError extends Error {
  constructor() {
    super('Request cancelled');
  }
}

/** Retry-After in milliseconds, from either delay-seconds or an HTTP date; null when absent or unreadable. */
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

/**
 * How long to wait before retry number `retry` (0 for the first), or null when the error
 * must not be retried.
 */
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
    // Up to a second of jitter on top, so clients told the same moment spread out a little.
    return retryAfter > RETRY_CAP_MS ? null : retryAfter + 1000 * random();
  }
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** retry);
  return Math.min(RETRY_CAP_MS, backoff * (0.75 + 0.5 * random()));
}

export interface RetryOptions {
  /** Called once a second while waiting to retry, and with null when the wait is over. */
  onWait?: (wait: RetryWait | null) => void;
  /** Checked before every attempt and during waits; true stops with RequestCancelledError. */
  isCancelled?: () => boolean;
  queue?: RequestQueue | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `request`, retrying as the policy above allows. When the retries run out, the last
 * error is thrown unchanged so the caller can say what went wrong.
 */
export async function withRetry<T>(request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { onWait, isCancelled, queue } = options;
  for (let retry = 0; ; retry++) {
    if (isCancelled?.()) {
      throw new RequestCancelledError();
    }
    await queue?.take({ isCancelled });
    try {
      return await request();
    } catch (error) {
      const delay = retryDelayMs(error, retry);
      if (delay === null) {
        throw error;
      }
      const status = (error as HttpErrorResponse).status;
      const resumeAt = Date.now() + delay;
      for (let left = delay; left > 0; left = resumeAt - Date.now()) {
        onWait?.({ status, seconds: Math.ceil(left / 1000) });
        await sleep(Math.min(left, 1000));
        if (isCancelled?.()) {
          throw new RequestCancelledError();
        }
      }
      onWait?.(null);
    }
  }
}
