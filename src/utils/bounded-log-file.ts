import { createWriteStream, statSync, type WriteStream } from 'node:fs';

/** Per-attempt diagnostics: bound both disk bytes and queued writes. Refusing
 * more log data is permanent, and the owner decides how to stop the task. */
export class BoundedLogFile {
  private stream?: WriteStream;
  private bytes = 0;
  private stopped = false;
  private initialized = false;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(private readonly path: string, private readonly options: {
    onLimit: (kind: 'disk' | 'buffer') => void;
    onError?: (error: Error) => void;
    maxBytes?: number;
    maxBufferedBytes?: number;
  }) {}

  write(text: string): void {
    if (this.stopped) return;
    try {
      if (!this.initialized) {
        this.initialized = true;
        try { this.bytes = statSync(this.path).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const bytes = Buffer.byteLength(text);
      const limit = this.bytes + bytes > (this.options.maxBytes ?? 64_000_000) ? 'disk'
        : (this.stream?.writableLength ?? 0) + bytes > (this.options.maxBufferedBytes ?? 16_000_000) ? 'buffer' : undefined;
      if (limit) { this.end(); this.options.onLimit(limit); return; }
      if (!this.stream) {
        this.stream = createWriteStream(this.path, { flags: 'a', mode: 0o600 });
        this.stream.once('error', error => {
          this.stopped = true; this.resolveClosed(); this.options.onError?.(error);
        });
        this.stream.once('finish', () => this.resolveClosed());
      }
      this.bytes += bytes;
      this.stream.write(text);
    } catch (error) {
      this.end();
      this.options.onError?.(error instanceof Error ? error : new Error('diagnostic log failed'));
    }
  }

  end(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.stream) this.stream.end();
    else this.resolveClosed();
  }
}
