import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from '../src/bot-registry.js';
import { createPresetSavedWorkflow } from '../src/workflows/v3/preset-service.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { recoverDevelopmentReviewRun } from '../src/workflows/v3/development-review-recovery.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { DEVELOPMENT_REVIEW_RESOURCES } from '../src/workflows/v3/presets/development-review-resources.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-review-recovery-'))); dirs.push(root);
  const repo = join(root, 'repo'), worktree = join(root, 'task'), baseDir = join(root, 'runs'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'value'), 'before'); git(repo, 'add', 'value'); git(repo, 'commit', '-qm', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'task', worktree, baseSha);
  writeFileSync(join(worktree, 'value'), 'after'); git(worktree, 'add', 'value'); git(worktree, 'commit', '-qm', 'candidate');
  const headSha = git(worktree, 'rev-parse', 'HEAD');
  const context = { actor: { larkAppId: 'cli_dev', openId: 'ou_owner' }, chatId: 'oc_task', rootMessageId: 'om_task' };
  const selected = { developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regress' };
  const bots = [...Object.values(selected), 'cli_replacement'].map(larkAppId => ({ larkAppId, cliId: 'codex', workingDir: repo })) as BotConfig[];
  const saved = await createPresetSavedWorkflow({ dataDir: root, context, presetId: 'development-review', bots, roleSelections: selected });
  const run = await instantiatePublishedSavedWorkflow({ dataDir: root, context, ref: saved.metadata.workflowId, bots, baseDir, runId: 'parent',
    rawParams: { mode: { kind: 'string', value: 'new' }, repo_path: { kind: 'string', value: repo }, requirement: { kind: 'string', value: 'Task' },
      target_branch: { kind: 'string', value: 'main' }, validation_commands: { kind: 'json', value: [{ id: 'test', argv: ['node', '--version'] }] } } });
  const journal = join(run.runDir, 'journal.ndjson'); appendEvent(journal, { type: 'runStarted', runId: run.runId });
  const publish = (nodeId: string, name: string, value: unknown) => {
    const attemptId = nodeId + '/attempts/001', output = join(run.runDir, attemptId, 'work'); mkdirSync(output, { recursive: true });
    const path = join(output, name), content = JSON.stringify(value); writeFileSync(path, content);
    const manifestPath = join(run.runDir, attemptId, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'fixture', files: [{ name, path: name,
      kind: 'json', bytes: Buffer.byteLength(content), sha256: sha(path).slice(7), mime: 'application/json' }] }));
    appendEvent(journal, { type: 'nodeDispatched', nodeId, attemptId });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId, attemptId, manifestPath });
    return path;
  };
  const contextPath = publish('prepare', 'context.json', { schemaVersion: 1, runId: run.runId, mode: 'new', repo, worktree, branch: 'task',
    baseSha, startSha: baseSha, roles: selected });
  const candidatePath = publish('development-review-loop.i001.implement', 'candidate.json', {
    schemaVersion: 1, runId: run.runId, repo, baseSha, headSha, round: 1, contextSha256: sha(contextPath),
  });
  appendEvent(journal, { type: 'runFailed', failedNodeId: 'development-review-loop.i001.review-correctness' });
  const input = { dataDir: root, baseDir, sourceRunId: run.runId, runId: 'recovered', context, bots,
    roleSelections: { developer: 'cli_replacement' } };
  return { input, journal, run, root, worktree, candidatePath, repo, git, headSha, baseSha, env };
}

function prepareRecovered(f: Awaited<ReturnType<typeof fixture>>, run: Awaited<ReturnType<typeof recoverDevelopmentReviewRun>>) {
  const attempt = join(run.runDir, 'prepare', 'attempts', '001'), output = join(attempt, 'work'); mkdirSync(output, { recursive: true });
  const script = join(output, 'tools.mjs'), roles = join(output, 'roles.json'), preflight = join(output, 'preflight.json');
  writeFileSync(script, DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
  writeFileSync(roles, JSON.stringify(run.resolvedRoles));
  const worktree = join(f.root, 'recovered-worktree');
  writeFileSync(preflight, JSON.stringify({ schemaVersion: 1, state: 'READY', repositoryAccess: true, identity: 'fixture',
    runId: run.runId, repoPath: f.repo, targetBranch: 'main', worktreePath: worktree, worktreeAllowed: true, branch: 'workflow/' + run.runId }));
  const result = spawnSyncTsScript(script, ['prepare', '--expected-tools-sha', DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256,
    '--preflight', preflight, '--params', join(run.runDir, 'params.resolved.json'), '--roles', roles], {
    encoding: 'utf8', timeout: 10000, env: { ...f.env, BOTMUX_GOAL_ATTEMPT_DIR: attempt, BOTMUX_GOAL_OUTPUT_DIR: output },
  });
  return { result, output, worktree };
}

describe('authorized development role recovery', () => {
  it('creates a new run with a digest-bound candidate and new independent roles, without changing old failure or approval history', async () => {
    const f = await fixture(), before = readFileSync(f.journal, 'utf8'), envelope = readFileSync(join(f.run.runDir, 'run.json'));
    const recovered = await recoverDevelopmentReviewRun(f.input);
    expect(recovered.runId).toBe('recovered');
    expect(recovered.resolvedRoles?.developer.bot).toBe('cli_replacement');
    expect(recovered.resolvedRoles?.correctness.bot).toBe('cli_check');
    expect(recovered.resolvedParams.recovery_source).toMatchObject({ sourceRunId: 'parent', candidatePath: f.candidatePath, candidateSha256: sha(f.candidatePath) });
    expect(readFileSync(f.journal, 'utf8')).toBe(before);
    expect(readFileSync(join(f.run.runDir, 'run.json'))).toEqual(envelope);
    expect(materialize(readJournal(f.journal)).runStatus).toBe('failed');
    const events = readJournal(join(recovered.runDir, 'journal.ndjson'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'runRecovered', previousRoles: { developer: 'cli_dev' }, roles: { developer: 'cli_replacement' } });
    expect(events.some(e => e.type === 'gateResolved' || e.type === 'nodeSucceeded')).toBe(false);
    expect((await recoverDevelopmentReviewRun(f.input)).runId).toBe(recovered.runId);
    expect(readJournal(join(recovered.runDir, 'journal.ndjson'))).toEqual(events);
    const prepared = prepareRecovered(f, recovered);
    expect(prepared.result.status, String(prepared.result.stderr)).toBe(0);
    expect(f.git(prepared.worktree, 'rev-parse', 'HEAD')).toBe(f.headSha);
    expect(JSON.parse(readFileSync(join(prepared.output, 'context.json'), 'utf8'))).toMatchObject({
      runId: 'recovered', baseSha: f.baseSha, startSha: f.headSha,
      recoveredFrom: { runId: 'parent' }, roles: { developer: { bot: 'cli_replacement' } },
    });
  });

  it('does not treat a recovery_source parameter as authority without the host fork record', async () => {
    const f = await fixture(), run = await recoverDevelopmentReviewRun(f.input);
    writeFileSync(join(run.runDir, 'journal.ndjson'), '');
    const prepared = prepareRecovered(f, run);
    expect(prepared.result.status).not.toBe(0);
    expect(String(prepared.result.stderr)).toContain('authorized recovery record missing');
  });

  it('rejects changed source history at actual preparation before creating a worktree', async () => {
    const f = await fixture(), run = await recoverDevelopmentReviewRun(f.input);
    appendEvent(f.journal, { type: 'runFailed', detail: 'source history changed' });
    const prepared = prepareRecovered(f, run);
    expect(prepared.result.status).not.toBe(0);
    expect(String(prepared.result.stderr)).toContain('recovery source changed');
  });

  it.each(['foreign-owner', 'foreign-chat', 'same-reviewer', 'dirty', 'changed-candidate', 'worker-open', 'publication-started'] as const)(
    'refuses unsafe recovery: %s', async mode => {
      const f = await fixture();
      if (mode === 'foreign-owner') f.input.context.actor.openId = 'ou_other';
      if (mode === 'foreign-chat') f.input.context.chatId = 'oc_other';
      if (mode === 'same-reviewer') f.input.roleSelections.developer = 'cli_check';
      if (mode === 'dirty') writeFileSync(join(f.worktree, 'value'), 'unfinished');
      if (mode === 'changed-candidate') writeFileSync(f.candidatePath, '{}');
      if (mode === 'worker-open' || mode === 'publication-started') {
        const nodeId = mode === 'worker-open' ? 'review' : 'create-mr';
        appendEvent(f.journal, { type: 'nodeDispatched', nodeId, attemptId: nodeId + '/attempts/001' });
        if (mode === 'publication-started') appendEvent(f.journal, { type: 'nodeFailed', nodeId, attemptId: nodeId + '/attempts/001', errorClass: 'workerError' });
      }
      await expect(recoverDevelopmentReviewRun(f.input)).rejects.toThrow();
      expect(materialize(readJournal(f.journal)).runStatus).toBe('failed');
    });
});
