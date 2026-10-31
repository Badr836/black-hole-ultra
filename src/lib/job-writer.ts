/**
 * Serialised, monotonic database writer for one download job.
 *
 * Why this exists: the engine used to fire `void this.update(...)` for progress
 * events while awaiting the terminal "completed" update. Two unawaited writes on
 * the same row have no ordering guarantee, so a 99.9% progress write could land
 * *after* `completed` and leave the row stuck in "downloading" forever.
 *
 * This class guarantees:
 *   1. writes for a single job are applied strictly in enqueue order;
 *   2. once a terminal state is written, later *progress* writes are dropped;
 *   3. write failures are reported once instead of being swallowed.
 */

export const TERMINAL_STATUSES = new Set(["completed", "cancelled", "missing"]);

export type WriterPatch = {
  status?: string | null;
  progress?: number | null;
  [key: string]: unknown;
};

export type JobWriterOptions<T extends WriterPatch> = {
  onError?: (error: unknown) => void;
  /** Injected for tests: `patch.status` is the status being written. */
  onWrite?: (patch: T) => void;
};

export class JobWriter<T extends WriterPatch> {
  private chain: Promise<void> = Promise.resolve();
  private sealed = false;
  private errorReported = false;
  private pending = 0;

  constructor(
    private readonly sink: (patch: T) => Promise<void> | void,
    private readonly options: JobWriterOptions<T> = {},
  ) {}

  get isSealed(): boolean {
    return this.sealed;
  }

  get pendingWrites(): number {
    return this.pending;
  }

  /** Queue a patch. Resolves when this patch (and everything before it) is applied. */
  enqueue(patch: T): Promise<void> {
    if (this.sealed && isProgressOnly(patch)) return Promise.resolve();
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      try {
        if (this.sealed && isProgressOnly(patch)) return;
        await this.sink(patch);
        this.options.onWrite?.(patch);
        if (patch.status && TERMINAL_STATUSES.has(patch.status)) this.sealed = true;
      } catch (error) {
        if (!this.errorReported) {
          this.errorReported = true;
          this.options.onError?.(error);
        }
      } finally {
        this.pending -= 1;
      }
    });
    return this.chain;
  }

  /** Await everything queued so far. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** Re-open the writer when a job is retried after a terminal state. */
  reset(): void {
    this.sealed = false;
  }
}

/** Statuses that must never be written once a terminal state was recorded. */
export const NON_TERMINAL_STATUSES = new Set(["queued", "downloading", "converting", "paused"]);

/**
 * A patch that may advance *towards* a terminal state. Progress updates carry
 * `status: "downloading"`, so they are covered by this predicate too.
 */
export function isProgressOnly(patch: WriterPatch): boolean {
  return patch.status === undefined || patch.status === null || NON_TERMINAL_STATUSES.has(patch.status);
}
