import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnTsScript, spawnSyncTsEval } from './helpers/ts-runner.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { DEVELOPMENT_REVIEW_RESOURCES, DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 } from '../src/workflows/v3/presets/development-review-resources.js';
import { createDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = (file: string) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
type Input = { from: string; name: string; path: string; kind?: string };

async function fixture(mode: 'new' | 'review' | 'continue' = 'new', changed = true, failedCheck = false, ownPr = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-rev-mechanical-'))); roots.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), run = join(root, 'fixture-run');
  mkdirSync(repo); mkdirSync(run);
  writeFileSync(join(root, 'gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'value.txt'), 'before\n');
  git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'fixture base');
  git(root, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main');
  if (mode !== 'new') {
    git(repo, 'checkout', '-qb', 'feature'); writeFileSync(join(repo, 'value.txt'), 'after\n');
    git(repo, 'commit', '-qam', 'fixture PR'); git(repo, 'push', '-q', 'origin', 'feature');
  }
  const out = (node: string) => { const p = join(run, node, 'attempts', '001', 'work'); mkdirSync(p, { recursive: true }); return p; };
  write(join(run, 'run.json'), { runId: 'fixture-run' });
  const prepared = out('prepare#001'), script = join(prepared, 'tools.mjs');
  writeFileSync(script, DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
  const params = join(root, 'params.json'), preflight = join(root, 'preflight.json'), roles = join(root, 'roles.json');
  const target = { url: 'https://example.invalid/pull/23', author: 'fixture-author', remote: 'origin', sourceBranch: 'feature', targetBranch: 'main', headSha: git(repo, 'rev-parse', 'HEAD') };
  write(params, { params: { mode, repo_path: repo, requirement: 'Fixture task', target_branch: 'main',
    validation_commands: [{ id: 'behavior', argv: [process.execPath, '-e', `process.exit(${failedCheck ? 3 : 0})`], timeoutSec: 10 }] } });
  write(preflight, { schemaVersion: 1, state: 'READY', runId: 'fixture-run', repoPath: repo, targetBranch: 'main',
    repositoryAccess: true, identity: 'fixture', login: ownPr ? target.author : 'fixture-reviewer',
    worktreeAllowed: true, worktreePath: join(root, 'task'), branch: 'workflow/fixture-run', ...(mode !== 'new' ? { reviewTarget: target } : {}) });
  write(roles, Object.fromEntries(['developer', 'correctness', 'regression'].map(role => [role, { bot: 'cli_' + role, label: role, cliId: 'codex' }])));
  const tool = (operation: string, args: string[], output: string, inputs?: Input[]) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const inputsFile = join(dirname(output), 'inputs.json');
    if (inputs) write(inputsFile, { inputs });
    const options = {
      env: { ...env, BOTMUX_GOAL_OUTPUT_DIR: output, BOTMUX_GOAL_ATTEMPT_DIR: dirname(output),
        BOTMUX_GOAL_MANIFEST_PATH: join(dirname(output), 'manifest.json'), BOTMUX_GOAL_INPUTS_PATH: inputsFile },
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const id = basename(dirname(dirname(dirname(output)))).replace(/#[0-9]+$/, '');
    const goal = operation === 'authored-stage' ? createDevelopmentReviewPreset({ developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regression' }).dagTemplate.nodes.find(node => node.id === id)?.goal : undefined;
    const command = typeof goal === 'string' ? /```sh\n([\s\S]*?)\n```/.exec(goal)?.[1] : undefined;
    const child = operation === 'authored-stage'
      ? spawn('bash', ['-c', command || 'exit 99'], options)
      : spawnTsScript(script, [operation, '--expected-tools-sha', DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256, ...args], options);
    child.stdout?.resume();
    let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  expect(await tool('prepare', ['--preflight', preflight, '--params', params, '--roles', roles], prepared)).toMatchObject({ code: 0, stderr: '' });
  const context = join(prepared, 'context.json'), resources = join(prepared, 'resources.json');
  const ctx = json(context);
  if (mode !== 'review' && changed) { writeFileSync(join(ctx.worktree, 'value.txt'), 'task change\n'); git(ctx.worktree, 'commit', '-qam', 'fixture change'); }
  const implemented = out('development-review-loop.i001.implement');
  expect(await tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  const candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
  expect(await tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'Fixture change; unverified-fixture-platform.\n');
  const reviews = Object.fromEntries(['correctness', 'regression'].map(role => {
    const path = join(root, role + '.json');
    write(path, { ...json(candidate), role, reviewerId: 'cli_' + role, decision: failedCheck ? 'changes_requested' : 'approve',
      findings: failedCheck ? [{ blocking: false, location: 'value.txt:1', impact: role + '-finding-canary', evidence: 'behavior exits 3' }] : [],
      coverage: [role + '-coverage-canary'], evidence: ['unverified-fixture-platform'],
      candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
    return [role, path];
  }));
  const preparedInputs: Input[] = [{ from: 'prepare', name: 'context', path: context }, { from: 'prepare', name: 'resources', path: resources }, { from: 'prepare', name: 'tools', path: script }];
  const gated = out('development-review-loop.i001.verify-review-gate'), release = join(gated, 'release-candidate.json');
  const gateInputs = [...preparedInputs, ...[['candidate', candidate], ['validation', validation], ['change-summary', summary]].map(([name, path]) => ({ from: 'development-review-loop.i001.implement', name: name!, path: path! })),
    ...Object.entries(reviews).map(([role, path]) => ({ from: 'development-review-loop.i001.review-' + role, name: 'review', path }))];
  const legacyGate = () => tool('gate', ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
    '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews.correctness!, '--regression', reviews.regression!, '--round', '1', '--out', join(gated, 'result.json')], gated);
  const releaseInput = { from: 'development-review-loop', name: 'release-candidate', path: release };
  const complete = out('complete#001');
  async function delivery() {
    expect(await legacyGate()).toMatchObject({ code: 0 }); expect(json(join(gated, 'result.json')).passed).toBe(true);
    const output = out('prepare-mr#001'), draft = join(output, 'mr-draft.json');
    write(draft, { repository: 'fixture/project', summary: 'Fixture validation; unverified-fixture-platform.', pushRemote: 'origin', ...(mode !== 'new' ? { existingPr: { ...target, state: 'OPEN' } } : {}) });
    writeFileSync(join(output, 'review-comment.md'), 'Fixture review notes.\n');
    writeFileSync(join(output, 'mr-title.txt'), 'Fixture change\n'); writeFileSync(join(output, 'mr-body.md'), 'Fixture validation.\n');
    expect(await tool('delivery', ['--context', context, '--release', release, '--draft', draft,
      ...(mode === 'review' ? ['--comment', join(output, 'review-comment.md')] : ['--title', join(output, 'mr-title.txt'), '--body', join(output, 'mr-body.md')])], output)).toMatchObject({ code: 0 });
    return { output, plan: join(output, 'result.json') };
  }
  return { root, repo, run, out, tool, git, prepared, preflight, params, roles, context, resources, ctx, candidate, validation, reviews,
    gated, release, preparedInputs, gateInputs, releaseInput, complete, legacyGate, delivery };
}

describe('fixed development-review mechanical stages', () => {
  it('materializes the exact frozen tools from the compact authored bootstrap', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-rev-bootstrap-')); roots.push(root);
    const preset = createDevelopmentReviewPreset({ developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regression' });
    const prepare = preset.dagTemplate.nodes.find(node => node.id === 'prepare')!;
    const source = /```js\n([\s\S]*?)\n```/.exec(prepare.goal as string)![1]!;
    const result = spawnSyncTsEval(source, { env: { ...process.env, BOTMUX_GOAL_OUTPUT_DIR: root }, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(readFileSync(join(root, 'tools.mjs'), 'utf8')).toBe(DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
    expect(sha(join(root, 'tools.mjs'))).toBe(DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256);
    // This is the prompt payload cost, rather than an implementation constant.
    expect(Buffer.byteLength(source)).toBeLessThan(Buffer.byteLength(DEVELOPMENT_REVIEW_RESOURCES[0]!.content) / 2);
  });

  it('resolves frozen gate inputs and publishes its real products in one invocation', async () => {
    const f = await fixture();
    expect(await f.tool('stage', ['--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256], f.gated, f.gateInputs)).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(f.gated, 'result.json'))).toMatchObject({ passed: true, headSha: json(f.candidate).headSha });
    const manifest = await readAndValidateManifest(join(dirname(f.gated), 'manifest.json'), f.gated);
    expect(manifest.files.map(file => file.name)).toEqual(expect.arrayContaining(['gate-result', 'release-candidate', 'feedback', 'independent-validation']));
  });

  it('does not guess between duplicate or incomplete frozen inputs', async () => {
    const f = await fixture();
    expect((await f.tool('stage', [], f.gated, [...f.gateInputs, f.gateInputs[0]!])).code).toBe(2);
    expect(existsSync(join(dirname(f.gated), 'manifest.json'))).toBe(false);
    expect((await f.tool('stage', [], f.gated, f.gateInputs.filter(input => input.name !== 'candidate'))).code).toBe(2);
    expect(existsSync(join(dirname(f.gated), 'manifest.json'))).toBe(false);
  });

  it('retains all failed checks, review findings and limitations in an idempotent final report', async () => {
    const f = await fixture('review', true, true, true), d = await f.delivery();
    const routed = f.out('check-delivery#001'), verified = f.out('verify-publication#001');
    const inputs = [...f.preparedInputs, f.releaseInput, { from: 'prepare-mr', name: 'delivery-plan', path: d.plan }];
    expect(await f.tool('stage', [], routed, inputs)).toMatchObject({ code: 0 });
    expect(json(join(routed, 'result.json'))).toMatchObject({ approvalRequired: true, directPublish: false });
    const planned = json(d.plan);
    write(join(verified, 'observed-pr.json'), { url: planned.existingPr.url, state: 'OPEN', sourceBranch: planned.sourceBranch, targetBranch: planned.targetBranch, headSha: planned.headSha });
    writeFileSync(join(verified, 'observed-comment.md'), planned.commentBody);
    expect(await f.tool('stage', [], verified, [...inputs, { from: 'check-delivery', name: 'route', path: join(routed, 'result.json') }])).toMatchObject({ code: 0 });
    const completeInputs = [...inputs, { from: 'verify-publication', name: 'verification', path: join(verified, 'verification.json') }];
    expect(await f.tool('stage', [], f.complete, completeInputs)).toMatchObject({ code: 0 });
    const result = json(join(f.complete, 'completion.json'));
    expect(result).toMatchObject({ action: 'comment', publicationRequired: true, approvalRequired: true, pushed: false, commented: true, validationFailures: ['behavior'] });
    const report = readFileSync(join(f.complete, 'task-report.md'), 'utf8');
    for (const canary of ['correctness-finding-canary', 'regression-finding-canary', 'unverified-fixture-platform', planned.headSha, planned.baseSha]) expect(report).toContain(canary);
    const bytes = readFileSync(join(f.complete, 'task-report.md'));
    expect(await f.tool('stage', [], f.complete, completeInputs)).toMatchObject({ code: 0 });
    expect(readFileSync(join(f.complete, 'task-report.md'))).toEqual(bytes);
    const manifest = await readAndValidateManifest(join(dirname(f.complete), 'manifest.json'), f.complete);
    expect(manifest.files.map(file => file.name)).toContain('task-report');
  });

  it('finishes a no-change candidate without claiming a publication or looking for a PR', async () => {
    const f = await fixture('new', false), d = await f.delivery();
    expect(await f.tool('stage', [], f.complete, [...f.preparedInputs, f.releaseInput, { from: 'prepare-mr', name: 'delivery-plan', path: d.plan }])).toMatchObject({ code: 0 });
    expect(json(join(f.complete, 'completion.json'))).toMatchObject({ action: 'none', publicationRequired: false, pushed: false, commented: false, url: null });
  });

  it.each(['new', 'continue'] as const)('runs the authored command and retains push approval for %s', async mode => {
    const f = await fixture(mode), d = await f.delivery();
    const inputs = [...f.preparedInputs, f.releaseInput, { from: 'prepare-mr', name: 'delivery-plan', path: d.plan }];
    expect(await f.tool('authored-stage', [], d.output, inputs)).toMatchObject({ code: 0, stderr: '' });
    const plan = json(d.plan), routed = f.out('check-delivery#001');
    expect(plan).toMatchObject({ action: mode === 'new' ? 'create' : 'update', approvalRequired: true });
    expect(await f.tool('authored-stage', [], routed, inputs)).toMatchObject({ code: 0 });
    expect(json(join(routed, 'result.json')).approvalRequired).toBe(true);
    // The only push is into this test's own local bare repository.
    expect(await f.tool('push', ['--context', f.context, '--release', f.release, '--plan', d.plan], f.out('create-mr#001'))).toMatchObject({ code: 0 });
    const verified = f.out('verify-publication#001');
    write(join(verified, 'observed-pr.json'), { url: mode === 'new' ? 'https://example.invalid/pull/24' : plan.existingPr.url,
      state: 'OPEN', headSha: plan.headSha, sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch });
    expect(await f.tool('authored-stage', [], verified, [...inputs, { from: 'check-delivery', name: 'route', path: join(routed, 'result.json') }])).toMatchObject({ code: 0 });
    expect(await f.tool('authored-stage', [], f.complete, [...inputs, { from: 'verify-publication', name: 'verification', path: join(verified, 'verification.json') }])).toMatchObject({ code: 0 });
    expect(json(join(f.complete, 'completion.json'))).toMatchObject({ action: plan.action, approvalRequired: true, pushed: true, commented: false });
  });

  it('requires a fresh matching observation before reporting reuse and rejects a changed PR', async () => {
    const f = await fixture('continue', false), d = await f.delivery();
    const inputs = [...f.preparedInputs, f.releaseInput, { from: 'prepare-mr', name: 'delivery-plan', path: d.plan }];
    expect(json(d.plan).action).toBe('reuse');
    expect((await f.tool('stage', [], f.complete, inputs)).code).toBe(2);
    expect(existsSync(join(dirname(f.complete), 'manifest.json'))).toBe(false);
    const plan = json(d.plan), observation = { url: plan.existingPr.url, state: 'OPEN', headSha: plan.headSha, sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch };
    write(join(f.complete, 'observed-pr.json'), { ...observation, headSha: plan.baseSha });
    expect((await f.tool('stage', [], f.complete, inputs)).code).toBe(2);
    write(join(f.complete, 'observed-pr.json'), observation);
    expect(await f.tool('stage', [], f.complete, inputs)).toMatchObject({ code: 0 });
    expect(json(join(f.complete, 'completion.json'))).toMatchObject({ action: 'reuse', publicationRequired: false, pushed: false, commented: false, url: plan.existingPr.url });
  });

  it('rejects stale verification and changed gate artifacts before publishing a report', async () => {
    const f = await fixture('review'), d = await f.delivery();
    const verified = f.out('verify-publication#001'), verification = join(verified, 'verification.json');
    const plan = json(d.plan);
    write(verification, { schemaVersion: 1, verified: true, runId: f.ctx.runId, mode: 'review', action: 'comment', url: plan.existingPr.url,
      sourceBranch: plan.sourceBranch, targetBranch: plan.targetBranch, headSha: plan.headSha, approvalRequired: true, directPublish: false,
      planSha256: 'sha256:' + '0'.repeat(64), routeSha256: 'sha256:' + '1'.repeat(64) });
    const inputs = [...f.preparedInputs, f.releaseInput, { from: 'prepare-mr', name: 'delivery-plan', path: d.plan }, { from: 'verify-publication', name: 'verification', path: verification }];
    expect((await f.tool('stage', [], f.complete, inputs)).code).toBe(2);
    expect(existsSync(join(dirname(f.complete), 'manifest.json'))).toBe(false);
    write(verification, { ...json(verification), planSha256: sha(d.plan) });
    write(f.validation, { ...json(f.validation), checks: [] });
    expect((await f.tool('stage', [], f.complete, inputs)).code).toBe(2);
    expect(existsSync(join(dirname(f.complete), 'manifest.json'))).toBe(false);
  });

  it('carries a verified executable path while keeping it optional and rejecting unusable paths', async () => {
    const f = await fixture('new', false);
    expect(json(f.context).repositoryCliPath).toBeUndefined();
    write(f.preflight, { ...json(f.preflight), repositoryCliPath: process.execPath });
    expect(await f.tool('prepare', ['--preflight', f.preflight, '--params', f.params, '--roles', f.roles], f.prepared)).toMatchObject({ code: 0 });
    expect(json(f.context).repositoryCliPath).toBe(realpathSync(process.execPath));
    const previous = readFileSync(f.context);
    write(f.preflight, { ...json(f.preflight), repositoryCliPath: 'relative/gh' });
    expect((await f.tool('prepare', ['--preflight', f.preflight, '--params', f.params, '--roles', f.roles], f.prepared)).code).toBe(2);
    expect(readFileSync(f.context)).toEqual(previous);
  });
});
