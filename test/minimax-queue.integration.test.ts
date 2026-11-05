import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { RunnerControlDecoder } from '../src/adapters/cli/runner-control-channel.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
let realTmux: string | undefined;
try { realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { /* optional backend */ }
let root: string | undefined;
let backend: TmuxPipeBackend | undefined;
let detector: IdleDetector | undefined;

afterEach(() => {
  detector?.dispose();
  detector = undefined;
  backend?.destroySession();
  backend = undefined;
  if (root) {
    try { execFileSync(realTmux!, ['-S', join(root, 'socket'), 'kill-server'], { stdio: 'ignore', timeout: 3000 }); }
    catch { /* destroying the only session may have already stopped the server */ }
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
  vi.unstubAllEnvs();
});

it.skipIf(!realTmux)('releases two MiniMax turns on their own ready edges while the runner stays open', async () => {
  // A short, existing socket root works on Linux and macOS, and cannot reach
  // the host's default or managed tmux servers, even outside the test fence.
  root = mkdtempSync('/tmp/bmx-mcode-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Strict pane startup scrubs TMUX_TMPDIR from the server environment. Pin
  // every client to an explicit private socket instead of relying on that env.
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh
exec ${quote(realTmux!)} -S ${quote(join(root, 'socket'))} "$@"
`, { mode: 0o700 });
  const runtime = tsRunnerPrefix();
  const realCat = execFileSync('which', ['cat'], { encoding: 'utf8' }).trim();
  const bufferedCat = join(root, 'buffered-cat.mjs');
  writeFileSync(bufferedCat, `const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks)));
`);
  // Identify the buffering implementation independently of the host's cat.
  // This exercises MiniMax's idle/final chain through the production relay;
  // generic byte forwarding is already covered by tmux-pipe-streaming.test.ts.
  writeFileSync(join(bin, 'cat'), `#!/bin/sh
if [ "$1" = --version ]; then echo 'cat (uutils coreutils) 0.8.0'; exit 0; fi
if [ "$#" -gt 0 ]; then exec ${quote(realCat)} "$@"; fi
exec ${quote(runtime.command)} ${quote(bufferedCat)}
`, { mode: 0o700 });
  const executable = join(bin, 'mcode');
  writeFileSync(executable, `#!/bin/sh
exec ${quote(runtime.command)} ${quote(resolve('test/fixtures/fake-minimax-acp.mjs'))} "$@"
`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('TMUX_TMPDIR', root);
  vi.stubEnv('TMUX', undefined);
  vi.stubEnv('TMUX_PANE', undefined);
  const nativeLog = join(root, 'native.jsonl');
  backend = new TmuxPipeBackend('mcode-queue', { createSession: true, ownsSession: true });
  const pane = backend;
  const adapter = createMinimaxAdapter(executable);
  detector = new IdleDetector(adapter);
  const idle = detector;
  const decoder = new RunnerControlDecoder();
  const finals: Array<{ turnId: string; content: string }> = [];
  const queued = [
    { content: 'first', turnId: 'queued-1' },
    { content: 'second', turnId: 'queued-2' },
  ];
  const idleTurns: number[] = [];
  const submissions: boolean[] = [];
  let runnerPid: number | null = null;
  let transcript = '';
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolveRun, rejectRun) => { finish = resolveRun; fail = rejectRun; });
  const timeout = setTimeout(() => fail(new Error(`MiniMax turns stalled: ${JSON.stringify({ finals, idleTurns, transcript })}`)), 15_000);
  idle.onIdle(() => {
    idleTurns.push(finals.length);
    const turn = queued.shift();
    if (!turn) { finish(); return; }
    runnerPid ??= pane.getChildPid();
    idle.reset();
    // The test supplies pending work only on the real detector's idle edge;
    // it never manufactures completion or writes padding to flush the pipe.
    void adapter.writeInput(pane, turn.content, { turnId: turn.turnId }).then(result => {
      const submitted = result?.submitted === true;
      submissions.push(submitted);
      if (!submitted) fail(new Error(`MiniMax input rejected: ${JSON.stringify(result)}`));
    }).catch(fail);
  });
  pane.onExit((code, signal) => fail(new Error(`MiniMax runner exited before both turns completed: ${code}/${signal}`)));
  pane.onData(data => {
    transcript = (transcript + data).slice(-4000);
    try {
      idle.feed(decoder.push(data, true, body => {
        const sep = body.indexOf(':');
        if (body.slice(0, sep) === 'final') finals.push(JSON.parse(Buffer.from(body.slice(sep + 1), 'base64').toString('utf8')));
      }));
    } catch (error) { fail(error as Error); }
  });
  try {
    pane.spawn(runtime.command, [...runtime.prefixArgs, resolve('src/minimax-runner.ts'), '--mcode-bin', executable, '--cwd', root], {
      cwd: resolve('.'), env: { ...process.env, HOME: root, MINIMAX_DATA_DIR: join(root, 'native'),
        MCODE_TEST_LOG: nativeLog, MCODE_ACP_SCENARIO: '' },
      cols: 120, rows: 40, strictEnv: true,
    });
    await completed;
    expect(finals).toEqual([
      expect.objectContaining({ turnId: 'queued-1', content: 'answer:first' }),
      expect.objectContaining({ turnId: 'queued-2', content: 'answer:second' }),
    ]);
    expect(idleTurns).toEqual([0, 1, 2]);
    expect(submissions).toEqual([true, true]);
    expect(runnerPid).toBeGreaterThan(0);
    expect(pane.getChildPid()).toBe(runnerPid);
    expect(() => process.kill(runnerPid!, 0)).not.toThrow();
    const requests = readJsonLines(nativeLog).filter(call => call.message).map(call => call.message);
    expect(requests.filter(request => request.method === 'session/prompt').map(request => request.params)).toEqual([
      { sessionId: 'session_fixture', prompt: [{ type: 'text', text: 'first' }] },
      { sessionId: 'session_fixture', prompt: [{ type: 'text', text: 'second' }] },
    ]);
    expect(requests.filter(request => request.method === 'session/new')).toHaveLength(1);
    expect(requests.filter(request => request.method === 'session/resume').map(request => request.params.sessionId)).toEqual(['session_fixture']);
  } finally {
    clearTimeout(timeout);
  }
});
