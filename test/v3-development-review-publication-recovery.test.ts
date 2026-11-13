import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, linkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BotConfig } from '../src/bot-registry.js';
import type { BotSnapshot, RunNode, ValidateManifest } from '../src/workflows/v3/contract.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { createPresetSavedWorkflow } from '../src/workflows/v3/preset-service.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { recoverDevelopmentReviewPublicationRun } from '../src/workflows/v3/development-review-publication-recovery.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { materialize } from '../src/workflows/v3/state.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import { DEVELOPMENT_REVIEW_RESOURCES } from '../src/workflows/v3/presets/development-review-resources.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = (file: string) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(path)) : [[path, sha(path)]];
  }));
}
async function fixture(legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'publication-recovery-'))); roots.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), baseDir = join(root, 'runs'); mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'value'), 'base\n'); git(repo, 'add', 'value'); git(repo, 'commit', '-qm', 'base');
  git(root, 'init', '-q', '--bare', remote);
  git(repo, 'config', 'url.' + remote + '.insteadOf', 'https://example.invalid/fixture/repo.git');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/fixture/repo.git'); git(repo, 'push', '-q', 'origin', 'main');
  const context = { actor: { larkAppId: 'cli_dev', openId: 'ou_owner' }, chatId: 'oc_task', rootMessageId: 'om_task' };
  const selected = { developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regression' };
  const bots = Object.values(selected).map(larkAppId => ({ larkAppId, cliId: 'codex', workingDir: repo })) as BotConfig[];
  const previous = legacy ? JSON.parse(readFileSync(new URL('./fixtures/development-review/v18.json', import.meta.url), 'utf8')) : undefined;
  const legacyDraft = previous && JSON.parse(JSON.stringify(previous), (_key, value) => typeof value === 'string'
    ? Object.entries(selected).reduce((text, [role, bot]) => text === previous.roles[role].defaultBot ? bot : text, value) : value);
  const saved = legacy
    ? await createSavedWorkflow(root, { owner: context.actor, scope: { kind: 'chat', chatId: context.chatId }, displayName: 'Historical source', revision: legacyDraft })
    : await createPresetSavedWorkflow({ dataDir: root, context, presetId: 'development-review', bots, roleSelections: selected });
  const prepareGoal = legacyDraft?.dagTemplate.nodes.find((node: { id: string }) => node.id === 'prepare')?.goal;
  const encoded = typeof prepareGoal === 'string' ? /Buffer\.from\('([A-Za-z0-9+/=]+)', 'base64'\)/.exec(prepareGoal)?.[1] : undefined;
  if (legacy && !encoded) throw new Error('historical fixed resource missing');
  const sourceTool = encoded ? JSON.parse(brotliDecompressSync(Buffer.from(encoded, 'base64')).toString('utf8'))[0] as { content: string; sha256: string }
    : DEVELOPMENT_REVIEW_RESOURCES[0]!;
  const run = await instantiatePublishedSavedWorkflow({ dataDir: root, baseDir, context, ref: saved.metadata.workflowId, bots, runId: 'source',
    rawParams: { mode: { kind: 'string', value: 'new' }, repo_path: { kind: 'string', value: repo }, requirement: { kind: 'string', value: 'Fixture task' },
      target_branch: { kind: 'string', value: 'main' }, validation_commands: { kind: 'json', value: [{ id: 'behavior', argv: [process.execPath, '-e', 'process.exit(0)'] }] } } });
  const journal = join(run.runDir, 'journal.ndjson'); appendEvent(journal, { type: 'runStarted', runId: run.runId });
  const out = (node: string) => { const path = join(run.runDir, node, 'attempts', '001', 'work'); mkdirSync(path, { recursive: true }); return path; };
  const prepared = out('prepare#001'), script = join(prepared, 'tools.mjs'); writeFileSync(script, sourceTool.content);
  const execute = (mode: string, args: string[], output: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawnTsScript(script, [mode, '--expected-tools-sha', sourceTool.sha256, ...args], {
      env: { ...env, BOTMUX_GOAL_ATTEMPT_DIR: dirname(output), BOTMUX_GOAL_OUTPUT_DIR: output, BOTMUX_GOAL_MANIFEST_PATH: join(dirname(output), 'manifest.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume(); let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  const publish = async (node: string, output: string, entries: Array<[string, string, string]>) => {
    expect(await execute('publish', entries.flatMap(entry => ['--entry', ...entry]), output)).toMatchObject({ code: 0, stderr: '' });
    const instanceId = node.includes('#') ? node : undefined, nodeId = node.replace(/#\d+$/, ''), attemptId = node + '/attempts/001';
    appendEvent(journal, { type: 'nodeDispatched', nodeId, ...(instanceId ? { instanceId } : {}), attemptId });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId, ...(instanceId ? { instanceId } : {}), attemptId, manifestPath: join(dirname(output), 'manifest.json') });
  };
  const preflight = join(prepared, 'preflight.json');
  write(preflight, { schemaVersion: 1, state: 'READY', runId: run.runId, repoPath: repo, targetBranch: 'main', repositoryAccess: true,
    identity: 'fixture', worktreeAllowed: true, worktreePath: join(root, 'task'), branch: 'workflow/source' });
  expect(await execute('prepare', ['--preflight', preflight, '--params', join(run.runDir, 'params.resolved.json'), '--roles', join(run.runDir, 'roles.resolved.json')], prepared)).toMatchObject({ code: 0, stderr: '' });
  await publish('prepare#001', prepared, [['context', 'json', 'context.json'], ['resources', 'json', 'resources.json'], ['tools', 'text', 'tools.mjs']]);
  const contextPath = join(prepared, 'context.json'), ctx = json(contextPath);
  writeFileSync(join(ctx.worktree, 'value'), 'candidate\n'); git(ctx.worktree, 'commit', '-qam', 'candidate');
  appendEvent(journal, { type: 'loopStarted', loopId: 'development-review-loop' });
  appendEvent(journal, { type: 'loopIterationStarted', loopId: 'development-review-loop', iteration: 1 });
  const implemented = out('development-review-loop.i001.implement');
  expect(await execute('candidate', ['--context', contextPath, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  const candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json'), summary = join(implemented, 'change-summary.md');
  expect(await execute('record', ['--context', contextPath, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  writeFileSync(summary, 'Fixture change; unverified canary platform.\n');
  await publish('development-review-loop.i001.implement', implemented, [['candidate', 'json', 'candidate.json'], ['validation', 'json', 'validation.json'], ['change-summary', 'markdown', 'change-summary.md']]);
  const reviews = Object.fromEntries(['correctness', 'regression'].map(role => {
    const path = join(out('development-review-loop.i001.review-' + role), 'review.json');
    write(path, { ...json(candidate), role, reviewerId: selected[role as keyof typeof selected], decision: 'approve', findings: [],
      coverage: [role + '-coverage'], evidence: ['fixture'], candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(contextPath) });
    return [role, path];
  }));
  for (const role of ['correctness', 'regression']) await publish('development-review-loop.i001.review-' + role, dirname(reviews[role]!), [['review', 'json', 'review.json']]);
  const gated = out('development-review-loop.i001.verify-review-gate'), release = join(gated, 'release-candidate.json');
  expect(await execute('gate', ['--context', contextPath, '--resources', join(prepared, 'resources.json'), '--expected-resources-sha', sha(join(prepared, 'resources.json')),
    '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews.correctness!, '--regression', reviews.regression!, '--round', '1', '--out', join(gated, 'result.json')], gated)).toMatchObject({ code: 0 });
  expect(json(release).passed).toBe(true);
  await publish('development-review-loop.i001.verify-review-gate', gated, [['gate-result', 'json', 'result.json'], ['release-candidate', 'json', 'release-candidate.json']]);
  appendEvent(journal, { type: 'loopIterationDecision', loopId: 'development-review-loop', iteration: 1, decision: 'exit' });
  const drafted = out('prepare-mr#001'), draft = join(drafted, 'mr-draft.json');
  write(draft, { repository: 'fixture/repo', pushRemote: 'origin', summary: 'Fixture reviewed change' });
  writeFileSync(join(drafted, 'mr-title.txt'), 'Fixture change'); writeFileSync(join(drafted, 'mr-body.md'), 'Fixture checked change');
  expect(await execute('delivery', ['--context', contextPath, '--release', release, '--draft', draft, '--title', join(drafted, 'mr-title.txt'), '--body', join(drafted, 'mr-body.md')], drafted)).toMatchObject({ code: 0 });
  await publish('prepare-mr#001', drafted, [['delivery-plan', 'json', 'result.json']]);
  const planPath = join(drafted, 'result.json'), plan = json(planPath), routed = out('check-delivery#001');
  const common = ['--context', contextPath, '--release', release, '--plan', planPath];
  expect(await execute('route', [...common, '--out', join(routed, 'result.json')], routed)).toMatchObject({ code: 0 });
  await publish('check-delivery#001', routed, [['route', 'json', 'result.json']]);
  appendEvent(journal, { type: 'gateDispatched', nodeId: 'create-mr', instanceId: 'create-mr#001', waitId: 'create-mr#001-gate' });
  appendEvent(journal, { type: 'gateResolved', nodeId: 'create-mr', instanceId: 'create-mr#001', waitId: 'create-mr#001-gate', resolution: 'approved', by: 'ou_owner', selected: 'approve' });
  const published = out('create-mr#001');
  expect(await execute('push', common, published)).toMatchObject({ code: 0 });
  const publication = { schemaVersion: 1, action: plan.action, url: 'https://example.invalid/fixture/repo/pull/23',
    headSha: plan.headSha, sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch };
  write(join(published, 'mr-result.json'), publication);
  await publish('create-mr#001', published, [['mr-result', 'json', 'mr-result.json'], ['push', 'json', 'push.json']]);
  appendEvent(journal, { type: 'nodeDispatched', nodeId: 'verify-publication', instanceId: 'verify-publication#001', attemptId: 'verify-publication#001/attempts/001' });
  appendEvent(journal, { type: 'nodeFailed', nodeId: 'verify-publication', instanceId: 'verify-publication#001', attemptId: 'verify-publication#001/attempts/001', errorClass: 'workerError' });
  appendEvent(journal, { type: 'runFailed', failedNodeId: 'verify-publication' });
  return { root, repo, remote, run, ctx, plan, publication, journal, git, env, release, sourceTool,
    input: { dataDir: root, baseDir, sourceRunId: run.runId, context, bots } };
}

const validateManifest: ValidateManifest = async (path, output) => {
  try { return { ok: true, manifest: await readAndValidateManifest(path, output) }; }
  catch (error) { return { ok: false, problems: [String(error)] }; }
};
async function runRecovery(f: Awaited<ReturnType<typeof fixture>>, recovered: Awaited<ReturnType<typeof recoverDevelopmentReviewPublicationRun>>, observation: unknown, plantedTool?: 'symlink' | 'hardlink') {
  const loaded = loadAuthorizedV3Run(recovered.runDir), botSnapshots = new Map(Object.entries(loaded.botSnapshots as Record<string, BotSnapshot>));
  const calls: string[] = [];
  const runNode: RunNode = async request => {
    calls.push(request.node.id);
    if (request.node.id === 'verify-publication') {
      write(join(request.outputDir, 'observed-pr.json'), observation);
      if (plantedTool) {
        const source = recovered.resolvedParams.publication_recovery as { files: Record<string, { path: string }> };
        const evidence = source.files['evidence:change-summary']!.path;
        (plantedTool === 'symlink' ? symlinkSync : linkSync)(evidence, join(request.outputDir, 'tools.mjs'));
      }
    }
    const command = typeof request.node.goal === 'string' ? /```sh\n([\s\S]*?)\n```/.exec(request.node.goal)?.[1] : undefined;
    if (!command) throw new Error('authored recovery command missing');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const options: SpawnOptions = { env: { ...f.env, ...request.env }, stdio: ['ignore', 'pipe', 'pipe'] };
      const child = spawn('bash', ['-c', command], options); child.stdout?.resume();
      let stderr = ''; child.stderr?.on('data', data => { stderr += data; }); child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
    });
    if (result.code !== 0) throw new Error(result.stderr);
    return { status: 'ok', manifestPath: request.env.BOTMUX_GOAL_MANIFEST_PATH! };
  };
  const outcome = await runWorkflow(loaded.dag, { runNode, validateManifest, resolveBotSnapshot: bot => botSnapshots.get(bot!)! },
    { baseDir: f.input.baseDir, authorizedArtifacts: true, frozenBotSnapshots: botSnapshots,
      executionContext: { params: recovered.resolvedParams, context: {} } });
  return { calls, outcome, events: readJournal(join(recovered.runDir, 'journal.ndjson')) };
}

describe('read-only publication completion recovery', () => {
  it.each([[false, false], [true, false], [true, true]] as const)('runs only verification and completion, preserving source bytes (merged: %s, legacy: %s)', async (merged, legacy) => {
    const f = await fixture(legacy);
    let observation = { ...f.publication, state: 'OPEN' } as Record<string, unknown>;
    if (merged) {
      f.git(f.repo, 'merge', '--no-ff', f.plan.headSha, '-m', 'fixture merge');
      const mergeCommitSha = f.git(f.repo, 'rev-parse', 'HEAD');
      f.git(f.repo, 'push', '-q', 'origin', 'main'); f.git(f.repo, 'push', '-q', 'origin', '--delete', f.plan.sourceBranch);
      observation = { ...observation, state: 'MERGED', mergeCommitSha };
    }
    const pushTripwire = join(f.root, 'unexpected-push');
    writeFileSync(join(f.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf attempted > ' + JSON.stringify(pushTripwire) + '\nexit 1\n', { mode: 0o700 });
    const before = snapshot(f.run.runDir), recovered = await recoverDevelopmentReviewPublicationRun(f.input);
    expect(json(f.release).toolsSha256).toBe(f.sourceTool.sha256);
    if (legacy) expect(f.sourceTool.sha256).not.toBe(DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256);
    const result = await runRecovery(f, recovered, observation);
    expect(result.outcome).toMatchObject({ runStatus: 'succeeded' });
    expect(result.calls).toEqual(['verify-publication', 'complete']);
    expect(existsSync(pushTripwire)).toBe(false);
    expect(snapshot(f.run.runDir)).toEqual(before);
    expect(materialize(readJournal(f.journal)).runStatus).toBe('failed');
    const completed = result.events.find(event => event.type === 'nodeSucceeded' && event.nodeId === 'complete');
    expect(completed?.type).toBe('nodeSucceeded');
    if (completed?.type !== 'nodeSucceeded') throw new Error('missing completion');
    const out = join(dirname(completed.manifestPath), 'work');
    expect(json(join(out, 'completion.json'))).toMatchObject({ runId: recovered.runId, sourceRunId: f.run.runId,
      sourceBundleSha256: recovered.sourceBundleSha256, verificationToolsSha256: DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256, pushed: true, publication: { state: merged ? 'MERGED' : 'OPEN' } });
    expect(readFileSync(join(out, 'task-report.md'), 'utf8')).toContain('unverified canary platform');
  });

  it.each(['symlink', 'hardlink'] as const)('atomically replaces a planted tool %s without overwriting source evidence', async plantedTool => {
    const f = await fixture(), before = snapshot(f.run.runDir), recovered = await recoverDevelopmentReviewPublicationRun(f.input);
    const result = await runRecovery(f, recovered, { ...f.publication, state: 'OPEN' }, plantedTool);
    expect(snapshot(f.run.runDir)).toEqual(before);
    expect(result.outcome).toMatchObject({ runStatus: 'succeeded' });
    expect(result.calls).toEqual(['verify-publication', 'complete']);
    const verified = result.events.find(event => event.type === 'nodeSucceeded' && event.nodeId === 'verify-publication');
    if (verified?.type !== 'nodeSucceeded') throw new Error('missing verification');
    const tool = join(dirname(verified.manifestPath), 'work', 'tools.mjs');
    expect(lstatSync(tool).isSymbolicLink()).toBe(false);
    expect(sha(tool)).toBe(DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256);
    const complete = result.events.find(event => event.type === 'nodeSucceeded' && event.nodeId === 'complete');
    if (complete?.type !== 'nodeSucceeded') throw new Error('missing completion');
    expect(readFileSync(join(dirname(complete.manifestPath), 'work', 'task-report.md'), 'utf8')).toContain('unverified canary platform');
  });

  it('coalesces concurrent recovery requests and repairs the materialize-before-marker crash window', async () => {
    const f = await fixture(), before = snapshot(f.run.runDir);
    const [a, b] = await Promise.all([recoverDevelopmentReviewPublicationRun(f.input), recoverDevelopmentReviewPublicationRun(f.input)]);
    expect(a.runId).toBe(b.runId);
    const journal = join(a.runDir, 'journal.ndjson'); expect(readJournal(journal)).toHaveLength(1);
    writeFileSync(journal, '');
    expect((await recoverDevelopmentReviewPublicationRun(f.input)).runId).toBe(a.runId);
    expect(readJournal(journal)).toHaveLength(1);
    expect(snapshot(f.run.runDir)).toEqual(before);
    await expect(recoverDevelopmentReviewPublicationRun({ ...f.input, runId: f.run.runId })).rejects.toThrow('invalid publication recovery runId');
  });

  it.each(['foreign-owner', 'foreign-app', 'foreign-chat', 'missing-approval', 'wrong-approval-instance', 'publisher-failed', 'worker-open', 'changed-release'] as const)(
    'refuses an ineligible source before creating a successor: %s', async mode => {
      const f = await fixture();
      if (mode === 'foreign-owner') f.input.context.actor.openId = 'ou_other';
      if (mode === 'foreign-app') f.input.context.actor.larkAppId = 'cli_other';
      if (mode === 'foreign-chat') f.input.context.chatId = 'oc_other';
      if (mode === 'missing-approval' || mode === 'wrong-approval-instance' || mode === 'publisher-failed') {
        const events = readJournal(f.journal).filter(event => mode !== 'missing-approval' || event.type !== 'gateResolved').map(event => {
          if (mode === 'wrong-approval-instance' && event.type === 'gateResolved') return { ...event, instanceId: 'create-mr#999' };
          if (mode === 'publisher-failed' && event.type === 'nodeSucceeded' && event.nodeId === 'create-mr') return { ...event, type: 'nodeFailed', errorClass: 'workerError' };
          return event;
        });
        writeFileSync(f.journal, events.map(event => JSON.stringify(event)).join('\n') + '\n');
      }
      if (mode === 'worker-open') appendEvent(f.journal, { type: 'nodeDispatched', nodeId: 'late', attemptId: 'late/attempts/001' });
      if (mode === 'changed-release') write(join(f.run.runDir, 'development-review-loop.i001.verify-review-gate/attempts/001/work/release-candidate.json'), {});
      await expect(recoverDevelopmentReviewPublicationRun(f.input)).rejects.toThrow();
      expect(readdirSync(f.input.baseDir).filter(name => name.startsWith('publication-'))).toEqual([]);
    });

  it.each(['missing-host-marker', 'changed-source', 'closed-pr'] as const)('cannot complete with untrusted or invalid evidence: %s', async mode => {
    const f = await fixture(), recovered = await recoverDevelopmentReviewPublicationRun(f.input);
    if (mode === 'missing-host-marker') writeFileSync(join(recovered.runDir, 'journal.ndjson'), '');
    if (mode === 'changed-source') appendEvent(f.journal, { type: 'runFailed', detail: 'changed after recovery' });
    const result = await runRecovery(f, recovered, { ...f.publication, state: mode === 'closed-pr' ? 'CLOSED' : 'OPEN' });
    expect(result.outcome).toMatchObject({ runStatus: 'failed' });
    expect(result.calls).toEqual(['verify-publication']);
    expect(result.events.some(event => event.type === 'nodeSucceeded' && event.nodeId === 'complete')).toBe(false);
  });
});
