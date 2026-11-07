import './helpers/require-fenced-data-dir.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { writeAttemptHistory } from '../src/workflows/v3/goal-checkpoint.js';
const hooks = vi.hoisted(() => ({ beforeOpen: undefined as undefined | ((p: unknown) => void) }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: (...args: any[]) => { hooks.beforeOpen?.(args[0]); return (actual.openSync as any)(...args); } };
});
const roots: string[] = [];
afterEach(() => { hooks.beforeOpen = undefined; for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function root() { const p = mkdtempSync(join(tmpdir(), 'budget-review-')); roots.push(p); return p; }
function historyFixture() {
  const runDir = root(), previousAttemptId = 'work#001/attempts/001', previousDir = join(runDir, previousAttemptId), attemptDir = join(runDir, 'work#001/attempts/002');
  mkdirSync(previousDir, { recursive: true }); mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(previousDir, 'pty.log'), 'own previous evidence');
  const hash = 'sha256:' + 'a'.repeat(64);
  return { previousDir, args: { runDir, runId: 'history-fixture', nodeId: 'work', previousAttemptId, attemptDir, inputHash: hash, previousInputHash: hash } };
}

describe('optional previous-attempt history', () => {
  it('rejects replacing a validated attempt directory with a sibling symlink before log open', () => {
    const f = historyFixture(), sibling = join(f.args.runDir, 'reviewer#001', 'attempts', '001');
    mkdirSync(sibling, { recursive: true }); writeFileSync(join(sibling, 'pty.log'), 'SIBLING_REVIEWER_PRIVATE_EVIDENCE');
    let swapped = false;
    hooks.beforeOpen = p => {
      if (p !== join(f.previousDir, 'pty.log')) return;
      hooks.beforeOpen = undefined;
      renameSync(f.previousDir, f.previousDir + '-saved'); symlinkSync(sibling, f.previousDir); swapped = true;
    };
    const result = writeAttemptHistory(f.args);
    expect(swapped).toBe(true);
    const bytes = result ? readFileSync(result.path, 'utf8') : '';
    expect(bytes).not.toContain('SIBLING_REVIEWER_PRIVATE_EVIDENCE');
  });

  it('a failed atomic history replacement leaves logs intact and allows a later retry', () => {
    const f = historyFixture(), output = join(f.args.attemptDir, 'previous-attempt.json');
    mkdirSync(output);
    expect(writeAttemptHistory(f.args)).toBeUndefined();
    expect(readdirSync(f.args.attemptDir)).toEqual(['previous-attempt.json']);
    expect(readFileSync(join(f.previousDir, 'pty.log'), 'utf8')).toBe('own previous evidence');
    rmSync(output, { recursive: true });
    const result = writeAttemptHistory(f.args)!;
    expect(JSON.parse(readFileSync(result.path, 'utf8'))).toMatchObject({ approval: false, logs: { 'pty.log': { text: 'own previous evidence' } } });
  });

});
