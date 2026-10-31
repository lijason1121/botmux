import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BoundedLogFile } from '../src/utils/bounded-log-file.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'bounded-log-')); dirs.push(dir); return join(dir, 'pty.log'); }
describe('bounded attempt diagnostics', () => {
  it('preserves raw UTF-8 and ANSI bytes and closes only after queued writes flush', async () => {
    const file = fixture(), onLimit = vi.fn(), log = new BoundedLogFile(file, { onLimit });
    const parts = ['\x1b[2J你好', '\r\n', 'done'];
    for (const part of parts) log.write(part);
    log.end(); await log.closed;
    expect(readFileSync(file, 'utf8')).toBe(parts.join('')); expect(onLimit).not.toHaveBeenCalled();
  });
  it('counts existing disk data and rejects further chunks once without growing the file', async () => {
    const file = fixture(); writeFileSync(file, 'before');
    const onLimit = vi.fn(), log = new BoundedLogFile(file, { onLimit, maxBytes: 10 });
    log.write('1234'); log.write('5'); log.write('must not append'); await log.closed;
    expect(readFileSync(file, 'utf8')).toBe('before1234');
    expect(statSync(file).size).toBe(10); expect(onLimit.mock.calls).toEqual([['disk']]);
  });
  it('bounds queued data independently of total disk budget', async () => {
    const file = fixture(), onLimit = vi.fn(), log = new BoundedLogFile(file, { onLimit, maxBytes: 1000, maxBufferedBytes: 10 });
    log.write('中'.repeat(4)); log.write('later'); await log.closed;
    expect(onLimit.mock.calls).toEqual([['buffer']]); expect(existsSync(file)).toBe(false);
  });
  it('settles close and records a failed log sink without retrying writes', async () => {
    const file = fixture(), onError = vi.fn(), onLimit = vi.fn();
    const log = new BoundedLogFile(join(file, 'missing', 'out'), { onError, onLimit });
    log.write('before'); await log.closed; log.write('after');
    expect(onError).toHaveBeenCalledTimes(1); expect(onLimit).not.toHaveBeenCalled();
  });
});
