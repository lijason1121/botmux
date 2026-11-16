/** Real Git/worktrees, frozen tools, commands, manifests and scheduler. Only
 * model-authored preflight/reviews and the external PR API are fixture adapters. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import type { RunNode, ValidateManifest } from '../src/workflows/v3/contract.js';
import { createPresetSavedWorkflow } from '../src/workflows/v3/preset-service.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { DEVELOPMENT_REVIEW_RESOURCES, DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 } from '../src/workflows/v3/presets/development-review-resources.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { resolveWait } from '../src/workflows/v3/gate-wait-store.js';
import { recoverDevelopmentReviewRun } from '../src/workflows/v3/development-review-recovery.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const sha = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');

async function fixture(mode: 'new' | 'continue', failure?: 'readiness' | 'environment' | 'review' | 'stagnant', cancelBeforeSettlement = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devrev-real-'))); roots.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), baseDir = join(root, 'runs');
  mkdirSync(repo);
  const gitConfig = join(root, 'gitconfig'); writeFileSync(gitConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); mkdirSync(join(repo, 'checks'));
  writeFileSync(join(repo, 'value.txt'), 'before');
  writeFileSync(join(repo, 'checks', 'verify.cjs'), `
if (process.argv.includes('--probe')) { ${failure === 'readiness' ? 'console.error("browserType.launch: Executable doesn\'t exist"); process.exit(1);' : 'process.exit(0);'} }
${failure === 'environment' ? 'console.error("ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE"); process.exit(1);' : ''}
require('node:assert/strict').equal(require('node:fs').readFileSync('../value.txt', 'utf8'), 'after');
`);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(root, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main');
  let reviewTarget: Record<string, string> | undefined;
  if (mode === 'continue') {
    git(repo, 'checkout', '-qb', 'feature'); writeFileSync(join(repo, 'pr.txt'), 'existing change');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'PR'); git(repo, 'push', '-q', 'origin', 'feature');
    reviewTarget = { url: 'https://example.invalid/example/repo/pull/1', author: 'fixture', remote: 'origin',
      sourceBranch: 'feature', targetBranch: 'main', headSha: git(repo, 'rev-parse', 'HEAD') };
    git(repo, 'checkout', '-q', 'main');
  }
  const context = { actor: { larkAppId: 'cli_dev', openId: 'ou_owner' }, chatId: 'oc_fixture' };
  const selected = { developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regress' };
  const bots = Object.values(selected).map(larkAppId => ({ larkAppId, cliId: 'codex', workingDir: repo })) as BotConfig[];
  const saved = await createPresetSavedWorkflow({ dataDir: root, context, presetId: 'development-review', bots, roleSelections: selected });
  const run = await instantiatePublishedSavedWorkflow({ dataDir: root, context, ref: saved.metadata.workflowId, bots, baseDir,
    runId: 'actual-' + mode + (failure || ''), rawParams: {
      mode: { kind: 'string', value: mode }, repo_path: { kind: 'string', value: repo }, requirement: { kind: 'string', value: 'Change value to after' },
      target_branch: { kind: 'string', value: 'main' }, validation_commands: { kind: 'json', value: [] },
    } });
  const calls: string[] = [];
  let prepared = '', script = '', implemented = '';
  const runNode: RunNode = async req => {
    calls.push(req.node.id);
    const output = req.outputDir, manifestPath = join(req.attemptDir, 'manifest.json');
    const tool = (command: string, args: string[] = []) => spawnSyncTsScript(script,
      [command, '--expected-tools-sha', DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256, ...args],
      { encoding: 'utf8', timeout: 15000, env: { ...env, ...req.env } });
    const publish = (entries: string[][]) => {
      const result = tool('publish', entries.flatMap(entry => ['--entry', ...entry]));
      expect(result.status, String(result.stderr)).toBe(0);
    };
    const inputs = read(req.inputsPath).inputs;
    const input = (from: string, name: string) => inputs.find((i: any) => i.from === from && i.name === name).path;
    if (req.node.id === 'preflight') {
      const file = join(output, 'result.json');
      write(file, { schemaVersion: 1, state: 'READY', runId: run.runId, repoPath: repo, identity: 'fixture', login: 'fixture',
        repositoryAccess: true, targetBranch: 'main', worktreePath: join(root, 'task'), worktreeAllowed: true, branch: 'task/' + run.runId,
        ...(reviewTarget ? { reviewTarget } : {}), validationCommands: [{ id: 'behavior', cwd: 'checks',
          argv: [process.execPath, 'verify.cjs'], readinessArgv: [process.execPath, 'verify.cjs', '--probe'], timeoutSec: 10 }] });
      write(manifestPath, { schemaVersion: 1, status: 'ok', summary: 'Fixture role verified repository and command entry', files: [
        { name: 'preflight', path: 'result.json', kind: 'json', bytes: Buffer.byteLength(readFileSync(file)), sha256: sha(file).slice(7), mime: 'application/json' },
      ] });
    } else if (req.node.id === 'prepare') {
      prepared = output; script = join(output, 'tools.mjs'); writeFileSync(script, DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
      const roles = join(output, 'roles.json'); write(roles, run.resolvedRoles);
      const result = tool('prepare', ['--preflight', input('preflight', 'preflight'), '--params', input('workflow', 'params'), '--roles', roles]);
      if (result.status === 0) publish([['context', 'json', 'context.json'], ['tools', 'text', 'tools.mjs'], ['resources', 'json', 'resources.json'],
        ['preparation', 'json', 'result.json'], ['readiness', 'json', 'readiness.json']]);
    } else if (req.node.id.endsWith('.implement')) {
      implemented = output;
      const ctx = read(join(prepared, 'context.json'));
      const round = String(Number(/\.i(\d+)\./.exec(req.node.id)![1]));
      if (round === '1') { writeFileSync(join(ctx.worktree, 'value.txt'), 'after'); git(ctx.worktree, 'commit', '-qam', 'candidate'); }
      expect(tool('candidate', ['--context', join(prepared, 'context.json'), '--round', round]).status).toBe(0);
      const result = tool('record', ['--context', join(prepared, 'context.json'), '--candidate', join(output, 'candidate.json'), '--round', round]);
      if (result.status === 0) {
        writeFileSync(join(output, 'change-summary.md'), 'value.txt now returns after; behavior check executed');
        publish([['candidate', 'json', 'candidate.json'], ['validation', 'json', 'validation.json'], ['change-summary', 'markdown', 'change-summary.md'], ['log', 'log', 'behavior.log']]);
      }
      if (cancelBeforeSettlement) appendEvent(join(run.runDir, 'journal.ndjson'), { type: 'runCancelRequested',
        cancelRequestId: 'cancel-at-checkpoint', by: 'ou_owner', reason: 'Cancel after artifact persistence, before host settlement' });
    } else if (req.node.id.includes('.review-')) {
      const role = req.node.id.endsWith('correctness') ? 'correctness' : 'regression';
      const candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
      write(join(output, 'result.json'), { ...read(candidate), role, reviewerId: selected[role],
        decision: failure === 'review' ? 'blocked' : failure === 'stagnant' ? 'changes_requested' : 'approve',
        findings: failure === 'stagnant' ? [{ blocking: false, location: 'value.txt:1', impact: 'Missing final newline', evidence: 'File ends with after' }] : [],
        coverage: ['value output'], evidence: ['Independent fixture reads value.txt and actual behavior log'],
        candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(join(prepared, 'context.json')) });
      writeFileSync(join(output, 'review.md'), 'Fixture review'); publish([['review', 'json', 'result.json'], ['report', 'markdown', 'review.md']]);
    } else if (req.node.id === 'create-mr') {
      const planPath = input('prepare-mr', 'delivery-plan'), plan = read(planPath);
      const result = tool('push', ['--context', join(prepared, 'context.json'), '--release', input('development-review-loop', 'release-candidate'), '--plan', planPath]);
      expect(result.status, String(result.stderr)).toBe(0);
      write(join(output, 'mr-result.json'), { schemaVersion: 1, action: plan.action, url: reviewTarget?.url || 'https://example.invalid/example/repo/pull/2',
        sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch, headSha: plan.headSha });
      publish([['mr-result', 'json', 'mr-result.json'], ['push', 'json', 'push.json']]);
    } else {
      if (req.node.id === 'prepare-mr') {
        write(join(output, 'mr-draft.json'), { repository: 'example/repo', summary: 'Changed value output', pushRemote: 'origin',
          ...(reviewTarget ? { existingPr: { ...reviewTarget, state: 'OPEN' } } : {}) });
        writeFileSync(join(output, 'mr-title.txt'), 'Fixture change'); writeFileSync(join(output, 'mr-body.md'), 'Behavior validated');
      }
      if (req.node.id === 'verify-publication') {
        const plan = read(input('prepare-mr', 'delivery-plan'));
        write(join(output, 'observed-pr.json'), { url: reviewTarget?.url || 'https://example.invalid/example/repo/pull/2', state: 'OPEN',
          sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch, headSha: git(remote, 'rev-parse', 'refs/heads/' + plan.sourceBranch) });
      }
      const result = tool('stage');
      expect(result.status, String(result.stderr)).toBe(0);
    }
    expect(existsSync(manifestPath), req.node.id).toBe(true);
    return { status: 'ok', manifestPath };
  };
  const validateManifest: ValidateManifest = async (path, output) => {
    try { return { ok: true, manifest: await readAndValidateManifest(path, output) }; }
    catch (error) { return { ok: false, problems: [String(error)] }; }
  };
  const drive = () => runWorkflow(run.dag, { runNode, validateManifest, resolveBotSnapshot: bot => run.botSnapshots.get(bot!)! },
    { baseDir, gateMode: 'suspend', frozenBotSnapshots: run.botSnapshots, authorizedArtifacts: true,
      executionContext: { params: run.resolvedParams, context: run.resolvedContext as Record<string, string> } });
  return { run, calls, drive, outcome: await drive(), recoveryInput: { dataDir: root, baseDir, sourceRunId: run.runId, context, bots } };
}

describe('development validation on the production scheduler with actual tools', () => {
  it.each(['new', 'continue'] as const)('runs %s through real validation, an approval boundary, local publication and verified completion', async mode => {
    const f = await fixture(mode);
    expect(f.outcome.reason).toBe('awaitingGate');
    if (f.outcome.reason !== 'awaitingGate') throw new Error(JSON.stringify(f.outcome));
    const pending = f.outcome.pendingWaits[0]!;
    const wait = resolveWait(f.run.runDir, pending.waitId, 'approved', 'ou_owner', 'approve');
    appendEvent(join(f.run.runDir, 'journal.ndjson'), { type: 'gateResolved', nodeId: pending.nodeId, instanceId: wait.instanceId,
      waitId: pending.waitId, resolution: 'approved', by: 'ou_owner' });
    expect(await f.drive()).toMatchObject({ runStatus: 'succeeded' });
    expect(f.calls.filter(id => id.endsWith('.implement'))).toHaveLength(1);
    expect(f.calls).toContain('complete');
  });

  it.each(['readiness', 'environment', 'review'] as const)('stops %s failure without a second development round, including after redrive', async failure => {
    const f = await fixture('new', failure), calls = [...f.calls];
    expect(f.outcome.runStatus).not.toBe('succeeded');
    expect(f.calls.some(id => id.includes('.i002.'))).toBe(false);
    if (failure === 'readiness') expect(f.calls).toEqual(['preflight', 'prepare']);
    if (failure === 'environment') expect(f.calls.some(id => id.includes('.review-'))).toBe(false);
    const events = readJournal(join(f.run.runDir, 'journal.ndjson'));
    expect(events.some(event => event.type === 'nodeBlocked' && event.errorCode ===
      (failure === 'review' ? 'REVIEW_EVIDENCE_INCOMPLETE' : 'VALIDATION_ENVIRONMENT_BLOCKED'))).toBe(true);
    await f.drive();
    expect(f.calls).toEqual(calls);
  });

  it('stops repeated feedback on the same commit after one rework opportunity', async () => {
    const f = await fixture('new', 'stagnant');
    expect(f.outcome.runStatus).not.toBe('succeeded');
    expect(f.calls.filter(id => id.endsWith('.implement'))).toHaveLength(2);
    expect(f.calls.some(id => id.includes('.i003.'))).toBe(false);
    expect(readJournal(join(f.run.runDir, 'journal.ndjson')).some(event => event.type === 'nodeBlocked' && event.errorCode === 'DEVELOPMENT_NO_PROGRESS')).toBe(true);
  });

  it('recovers a complete failure checkpoint when cancellation wins the host settlement race', async () => {
    const f = await fixture('new', 'environment', true);
    expect(f.outcome.runStatus).toBe('cancelled');
    const journal = join(f.run.runDir, 'journal.ndjson'), original = readFileSync(journal, 'utf8');
    expect(readJournal(journal).some(event => event.type === 'nodeCancelled' && event.nodeId.endsWith('.implement'))).toBe(true);
    const recovered = await recoverDevelopmentReviewRun({ ...f.recoveryInput, rediscoverValidation: true });
    expect(recovered.resolvedParams.validation_commands).toEqual([]);
    expect(recovered.resolvedParams.recovery_source).toMatchObject({ sourceRunId: f.run.runId,
      sourceAttemptId: 'development-review-loop.i001.implement/attempts/001' });
    expect(readFileSync(journal, 'utf8')).toBe(original);
    expect(readJournal(join(recovered.runDir, 'journal.ndjson')).map(event => event.type)).toEqual(['runRecovered']);
  });
});
