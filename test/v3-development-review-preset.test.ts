import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review.js';
import { upgradeDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review-upgrade.js';
import { DEVELOPMENT_REVIEW_RESOURCES, DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 } from '../src/workflows/v3/presets/development-review-resources.js';
import { collectSavedWorkflowReusableTextWarnings } from '../src/workflows/v3/library-materialize.js';
import { validateSavedWorkflowRevisionPayload } from '../src/workflows/v3/library-schema.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { validateResult } from '../src/workflows/v3/shared-node-runtime.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const BOTS = { developer: 'cli_developer', correctness: 'cli_correctness', regression: 'cli_regression' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function fixture(objectFormat = 'sha1', selected = BOTS) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-review-preset-'))); roots.push(root);
  const repo = join(root, 'repo'), runId = 'fixture-run', run = join(root, runId);
  mkdirSync(repo); mkdirSync(run);
  writeFileSync(join(root, 'gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  git(repo, 'init', '-q', '-b', 'main', '--object-format=' + objectFormat);
  writeFileSync(join(repo, 'value.txt'), 'before\n'); git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'fixture base');
  write(join(run, 'run.json'), { runId }); // Local script fixture; no success journal or real Workflow is created.
  const out = (node: string) => {
    const output = join(run, node, 'attempts', '001', 'work'); mkdirSync(output, { recursive: true }); return output;
  };
  const prepared = out('prepare'), script = join(prepared, 'tools.mjs'), worktree = join(root, 'task-worktree');
  writeFileSync(script, DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
  const params = join(root, 'params.json'), preflight = join(root, 'preflight.json'), roles = join(root, 'roles.json');
  write(params, { params: { mode: 'new', repo_path: repo, requirement: 'Implement the requested behavior', target_branch: 'main',
    validation_commands: [{ id: 'behavior', argv: [process.execPath, '-e', 'process.stdout.write("verified")'], timeoutSec: 10 }] } });
  write(preflight, { schemaVersion: 1, state: 'READY', repositoryAccess: true, identity: 'fixture-user', runId,
    repoPath: repo, targetBranch: 'main', worktreePath: worktree, worktreeAllowed: true, branch: 'workflow/' + runId });
  write(roles, Object.fromEntries(Object.entries(selected).map(([role, bot]) => [role, { bot, label: role, cliId: 'codex' }])));
  const tool = (mode: string, args: string[], output: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnTsScript(script, [mode, '--expected-tools-sha', DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256, ...args], {
      env: { ...env, BOTMUX_GOAL_OUTPUT_DIR: output, BOTMUX_GOAL_ATTEMPT_DIR: dirname(output), BOTMUX_GOAL_MANIFEST_PATH: join(dirname(output), 'manifest.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; }); child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { root, repo, runId, run, env, git, out, prepared, script, worktree, params, preflight, roles, tool,
    prepare: () => tool('prepare', ['--preflight', preflight, '--params', params, '--roles', roles], prepared) };
}

async function evidenceFixture(objectFormat = 'sha1', round = 1, selected = BOTS, f = fixture(objectFormat, selected)) {
  expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
  const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json'), ctx = json(context);
  writeFileSync(join(f.worktree, 'value.txt'), 'after\n'); f.git(f.worktree, 'add', 'value.txt'); f.git(f.worktree, 'commit', '-qm', 'fixture candidate');
  const implemented = f.out('development-review-loop.i' + String(round).padStart(3, '0') + '.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
  expect(await f.tool('candidate', ['--context', context, '--round', String(round)], implemented)).toMatchObject({ code: 0, stderr: '' });
  expect(await f.tool('record', ['--context', context, '--candidate', candidate, '--round', String(round)], implemented)).toMatchObject({ code: 0, stderr: '' });
  const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'Changed value.txt; behavior check passed.\n');
  const correctness = join(f.root, 'correctness.json'), regression = join(f.root, 'regression.json');
  for (const [role, filename] of [['correctness', correctness], ['regression', regression]]) {
    write(filename!, { ...json(candidate), role, reviewerId: selected[role as keyof typeof BOTS], decision: 'approve', findings: [],
      coverage: ['private-review-evidence-canary'], evidence: ['Examined the actual candidate'],
      candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
  }
  const gated = f.out('development-review-loop.i' + String(round).padStart(3, '0') + '.verify-review-gate'), result = join(gated, 'result.json');
  const gateArgs = ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
    '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', correctness, '--regression', regression, '--round', String(round), '--out', result];
  return { ...f, context, resources, ctx, candidate, validation, summary, correctness, regression, gated, result, gateArgs,
    gate: () => f.tool('gate', gateArgs, gated) };
}

describe('authored development-review preset', () => {
  function pinnedNodeProject(f: ReturnType<typeof fixture>, pinFile = '.nvmrc', workspace = true) {
    // Executable runtime doubles expose which interpreter reaches lifecycle scripts
    // and validation subprocesses; they never use a real version-manager home.
    const node = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim();
    const home = join(f.root, 'runtime-home'), fnm = join(home, 'fnm');
    const bin = join(fnm, 'node-versions', 'v99.1.0', 'installation', 'bin');
    mkdirSync(bin, { recursive: true });
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = "-p" ]; then\n  printf "%s\\n" ' +
      quote(JSON.stringify({ version: 'v99.1.0', execPath: join(bin, 'node') })) + '\nelse\n  export FIXTURE_NODE_VERSION=99.1.0\n  exec ' + quote(node) + ' "$@"\nfi\n', { mode: 0o755 });
    const manager = join(f.root, 'manager'); mkdirSync(manager);
    writeFileSync(join(manager, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('8.15.9'); process.exit(0); }
if (process.env.FIXTURE_NODE_VERSION !== '99.1.0') { console.error('wrong Node reached dependency lifecycle'); process.exit(31); }
fs.appendFileSync(${JSON.stringify(join(f.root, 'installs.log'))}, process.env.FIXTURE_NODE_VERSION + '\\n');
fs.mkdirSync('node_modules/fixture', { recursive: true });
fs.writeFileSync('node_modules/fixture/package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
// Frozen installation may reuse existing lifecycle output, as pnpm does for tarballs.
if (process.argv.includes('--force') || !fs.existsSync('node_modules/fixture/compiled-for.txt'))
  fs.writeFileSync('node_modules/fixture/compiled-for.txt', process.env.FIXTURE_NODE_VERSION);
`, { mode: 0o755 });
    Object.assign(f.env, { HOME: home, FNM_DIR: fnm, NVM_DIR: join(home, 'nvm'),
      PATH: manager + delimiter + f.env.PATH });
    write(join(f.repo, 'package.json'), { name: 'pinned', packageManager: 'pnpm@8.15.9', dependencies: { fixture: '1.0.0' } });
    writeFileSync(join(f.repo, pinFile), 'v99\n');
    writeFileSync(join(f.repo, 'pnpm-lock.yaml'), 'fixture-lock');
    if (workspace) writeFileSync(join(f.repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'pinned runtime');
    const params = json(f.params);
    params.params.validation_commands = [{ id: 'runtime', argv: ['node', '-e',
      'if (process.env.FIXTURE_NODE_VERSION !== "99.1.0") process.exit(32); console.log(process.env.FIXTURE_NODE_VERSION)'], timeoutSec: 10 }];
    write(f.params, params);
    return { bin };
  }

  it.each(['.nvmrc', '.node-version'])('uses the project Node from %s for install, record and the independent gate', async pinFile => {
    const base = fixture(); pinnedNodeProject(base, pinFile);
    const f = await evidenceFixture('sha1', 1, BOTS, base);
    expect(readFileSync(join(f.root, 'installs.log'), 'utf8')).toBe('99.1.0\n');
    expect(json(f.context).dependencies.runtime.version).toBe('v99.1.0');
    expect(json(f.validation).checks[0].exitCode).toBe(0);
    expect(await f.gate()).toMatchObject({ code: 0, stderr: '' });
    expect(json(f.result).passed).toBe(true);
    expect(readFileSync(join(f.gated, 'independent-runtime.log'), 'utf8')).toContain('99.1.0');
  });

  it('keeps Node pins in isolated dependency snapshots and reuses only a matching runtime cache', async () => {
    const f = fixture(), { bin } = pinnedNodeProject(f, '.nvmrc', false);
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const first = json(join(f.prepared, 'context.json')).dependencies;
    expect(readFileSync(join(first.source, '.nvmrc'), 'utf8')).toBe('v99\n');
    expect(await f.prepare()).toMatchObject({ code: 0 });
    expect(readFileSync(join(f.root, 'installs.log'), 'utf8')).toBe('99.1.0\n');
    const updatedBin = bin.replace('v99.1.0', 'v99.2.0');
    mkdirSync(updatedBin, { recursive: true });
    // The probe reports a newer installed patch while the lifecycle marker stays
    // fixed so both successful installs remain observable with the same fixture.
    const updated = readFileSync(join(bin, 'node'), 'utf8').replaceAll(bin, updatedBin).replace('"version":"v99.1.0"', '"version":"v99.2.0"');
    writeFileSync(join(updatedBin, 'node'), updated, { mode: 0o755 });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const second = json(join(f.prepared, 'context.json')).dependencies;
    expect(second.runtime.version).toBe('v99.2.0');
    expect(second.source).not.toBe(first.source);
    expect(realpathSync(join(f.worktree, 'node_modules'))).toBe(second.modules);
    expect(existsSync(first.modules)).toBe(true);
    expect(readFileSync(join(f.root, 'installs.log'), 'utf8')).toBe('99.1.0\n99.1.0\n');
  });

  it('uses a matching PATH Node without requiring an optional version-manager store', async () => {
    const f = fixture(), { bin } = pinnedNodeProject(f);
    Object.assign(f.env, { PATH: bin + delimiter + f.env.PATH, FNM_DIR: join(f.root, 'broken-store') });
    writeFileSync(join(f.root, 'broken-store'), 'not a directory');
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(f.prepared, 'context.json')).dependencies.runtime.version).toBe('v99.1.0');
  });

  it('resolves an installed nvm Node and rejects a changed package manager before validation', async () => {
    const f = fixture(), { bin } = pinnedNodeProject(f);
    const nvmBin = join(f.root, 'runtime-home', 'nvm', 'versions', 'node', 'v99.1.0', 'bin');
    mkdirSync(nvmBin, { recursive: true });
    writeFileSync(join(nvmBin, 'node'), readFileSync(join(bin, 'node'), 'utf8').replaceAll(bin, nvmBin), { mode: 0o755 });
    rmSync(bin, { recursive: true });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json'), output = f.out('development-review-loop.i001.implement');
    expect(json(context).dependencies.runtime.execPath).toBe(join(nvmBin, 'node'));
    const manager = join(f.root, 'manager', 'pnpm');
    writeFileSync(manager, readFileSync(manager, 'utf8').replace("console.log('8.15.9')", "console.log('9.0.0')"));
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], output)).toMatchObject({ code: 0 });
    const result = await f.tool('record', ['--context', context, '--candidate', join(output, 'candidate.json'), '--round', '1'], output);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Package manager mismatch');
    expect(existsSync(join(output, 'validation.json'))).toBe(false);
  });

  it('rejects an absolute Node validation command that bypasses the prepared project runtime', async () => {
    const f = fixture(); pinnedNodeProject(f);
    const params = json(f.params);
    params.params.validation_commands[0].argv = [execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(), '-e', 'process.exit(0)'];
    write(f.params, params);
    expect(await f.prepare()).toMatchObject({ code: 0 });
    const context = join(f.prepared, 'context.json'), output = f.out('development-review-loop.i001.implement');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], output)).toMatchObject({ code: 0 });
    const result = await f.tool('record', ['--context', context, '--candidate', join(output, 'candidate.json'), '--round', '1'], output);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Explicit Node validation command does not match');
    expect(existsSync(join(output, 'validation.json'))).toBe(false);
  });

  it.each(['changed', 'legacy'] as const)('rebuilds workspace lifecycle output when its Node runtime is %s', async mode => {
    const f = fixture(), { bin } = pinnedNodeProject(f);
    if (mode === 'changed') {
      writeFileSync(join(f.repo, '.nvmrc'), '99.1\n');
      f.git(f.repo, 'commit', '-qam', 'pin initial runtime');
    }
    const params = json(f.params);
    params.params.validation_commands[0].argv = ['node', '-e',
      'const built=require("node:fs").readFileSync("node_modules/fixture/compiled-for.txt","utf8"); if(built!==process.env.FIXTURE_NODE_VERSION) process.exit(19)'];
    write(f.params, params);
    if (mode === 'legacy') {
      f.git(f.repo, 'worktree', 'add', '-b', 'workflow/' + f.runId, f.worktree, 'main');
      mkdirSync(join(f.worktree, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(f.worktree, 'node_modules', 'fixture', 'compiled-for.txt'), 'old-node');
    }
    expect(await f.prepare()).toMatchObject({ code: 0 });
    if (mode === 'changed') {
      const updated = bin.replace('v99.1.0', 'v99.2.0'); mkdirSync(updated, { recursive: true });
      writeFileSync(join(updated, 'node'), readFileSync(join(bin, 'node'), 'utf8').replaceAll('99.1.0', '99.2.0'), { mode: 0o755 });
      const manager = join(f.root, 'manager', 'pnpm');
      writeFileSync(manager, readFileSync(manager, 'utf8').replace("!== '99.1.0'", "!== '99.2.0'"));
      writeFileSync(join(f.worktree, '.nvmrc'), '99.2\n');
      f.git(f.worktree, 'commit', '-qam', 'change runtime');
    }
    const context = join(f.prepared, 'context.json'), output = f.out('development-review-loop.i001.implement');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], output)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', join(output, 'candidate.json'), '--round', '1'], output)).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(output, 'validation.json')).checks[0].exitCode).toBe(0);
    if (mode === 'changed') {
      // A -> B -> A must follow the current installation, not initial context or
      // the existence of an obsolete stamp for A's manifest.
      writeFileSync(join(f.worktree, '.nvmrc'), '99.1\n');
      f.git(f.worktree, 'commit', '-qam', 'restore runtime');
      const manager = join(f.root, 'manager', 'pnpm');
      writeFileSync(manager, readFileSync(manager, 'utf8').replace("!== '99.2.0'", "!== '99.1.0'"));
      expect(await f.tool('candidate', ['--context', context, '--round', '1'], output)).toMatchObject({ code: 0 });
      expect(await f.tool('record', ['--context', context, '--candidate', join(output, 'candidate.json'), '--round', '1'], output)).toMatchObject({ code: 0, stderr: '' });
      expect(json(join(output, 'validation.json')).checks[0].exitCode).toBe(0);
      expect(readFileSync(join(f.worktree, 'node_modules', 'fixture', 'compiled-for.txt'), 'utf8')).toBe('99.1.0');
    }
  });

  it.each(['missing', 'conflicting', 'changed-after-prepare'])('rejects an unusable project Node before installation or validation: %s', async mode => {
    const f = fixture(), { bin } = pinnedNodeProject(f);
    if (mode === 'missing') rmSync(bin, { recursive: true });
    if (mode === 'conflicting') {
      writeFileSync(join(f.repo, '.node-version'), '98\n');
      f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'conflicting pin');
    }
    if (mode === 'changed-after-prepare') {
      expect(await f.prepare()).toMatchObject({ code: 0 });
      writeFileSync(join(f.worktree, '.nvmrc'), '98\n');
      f.git(f.worktree, 'commit', '-qam', 'change runtime');
      const output = f.out('development-review-loop.i001.implement'), context = join(f.prepared, 'context.json');
      expect(await f.tool('candidate', ['--context', context, '--round', '1'], output)).toMatchObject({ code: 0 });
      expect((await f.tool('record', ['--context', context, '--candidate', join(output, 'candidate.json'), '--round', '1'], output)).code).toBe(2);
      expect(existsSync(join(output, 'validation.json'))).toBe(false);
      expect(readFileSync(join(f.root, 'installs.log'), 'utf8')).toBe('99.1.0\n');
    } else {
      const result = await f.prepare();
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/Node.*(?:99|98)/);
      expect(existsSync(join(f.root, 'installs.log'))).toBe(false);
      expect(json(join(dirname(f.prepared), 'manifest.json')).error.code).toBe('DEPENDENCY_ENVIRONMENT_NOT_READY');
    }
  });
  it.each(['intact', 'dangling'] as const)('switches development to a matching external dependency environment without mutating the original shared target: %s', async mode => {
    const f = fixture();
    write(join(f.repo, 'package.json'), { dependencies: { fixture: '1.0.0' } });
    writeFileSync(join(f.repo, 'bun.lock'), 'lock-1'); writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'dependency inputs');
    mkdirSync(join(f.repo, 'node_modules', 'fixture'), { recursive: true });
    write(join(f.repo, 'node_modules', 'fixture', 'package.json'), { name: 'fixture', version: '1.0.0' });
    write(f.preflight, { ...json(f.preflight), dependencyReuseAllowed: true });
    expect(await f.prepare()).toMatchObject({ code: 0 });
    const context = join(f.prepared, 'context.json'), implemented = f.out('development-review-loop.i001.implement');
    write(join(f.worktree, 'package.json'), { dependencies: { fixture: '2.0.0' } });
    writeFileSync(join(f.worktree, 'bun.lock'), 'lock-2');
    f.git(f.worktree, 'add', '.'); f.git(f.worktree, 'commit', '-qm', 'update dependency');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    const args = ['--context', context, '--candidate', join(implemented, 'candidate.json'), '--round', '1'];
    expect((await f.tool('record', args, implemented)).code).toBe(2);
    const source = join(f.root, 'external-install'); mkdirSync(join(source, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(source, 'package.json'), readFileSync(join(f.worktree, 'package.json')));
    writeFileSync(join(source, 'bun.lock'), 'lock-2');
    write(join(source, 'node_modules', 'fixture', 'package.json'), { name: 'fixture', version: '2.0.0' });
    if (mode === 'dangling') rmSync(join(f.repo, 'node_modules'), { recursive: true });
    expect(await f.tool('record', [...args, '--dependency-source', source], implemented)).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(implemented, 'validation.json')).checks[0].exitCode).toBe(0);
    expect(realpathSync(join(f.worktree, 'node_modules'))).toBe(join(source, 'node_modules'));
    if (mode === 'intact') expect(json(join(f.repo, 'node_modules', 'fixture', 'package.json')).version).toBe('1.0.0');
    else expect(existsSync(join(f.repo, 'node_modules'))).toBe(false);
    expect(readFileSync(join(f.repo, 'bun.lock'), 'utf8')).toBe('lock-1');
  });

  it.each(['matching', 'large-snapshot', 'stale-code', 'foreign-link', 'missing-link', 'missing-child', 'shadowed-child'] as const)('verifies an independent workspace installation against the full task snapshot: %s', async mode => {
    const f = fixture(), source = join(f.root, 'external-workspace');
    write(join(f.repo, 'package.json'), { workspaces: ['packages/*'] });
    writeFileSync(join(f.repo, 'bun.lock'), 'workspace-lock'); writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    mkdirSync(join(f.repo, 'packages', 'a'), { recursive: true });
    write(join(f.repo, 'packages', 'a', 'package.json'), { name: 'workspace-a', version: '1.0.0',
      ...(mode === 'missing-child' ? { dependencies: { missing: '1.0.0' } } : mode === 'shadowed-child' ? { dependencies: { 'workspace-a': '1.0.0' } } : {}) });
    writeFileSync(join(f.repo, 'packages', 'a', 'index.js'), 'export const value = 1;');
    if (mode === 'large-snapshot') {
      // More than 1 MiB of tracked paths, like a large monorepo.
      const deep = join(f.repo, 'assets', ...Array.from({ length: 16 }, (_, i) => String(i).padEnd(200, 'd')));
      mkdirSync(deep, { recursive: true });
      for (let i = 0; i < 340; i++) writeFileSync(join(deep, String(i).padEnd(100, 'f')), '');
    }
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'workspace snapshot');
    for (const file of f.git(f.repo, 'ls-files').split('\n')) {
      mkdirSync(dirname(join(source, file)), { recursive: true }); writeFileSync(join(source, file), readFileSync(join(f.repo, file)));
    }
    mkdirSync(join(source, 'node_modules'));
    if (mode !== 'missing-link') symlinkSync(mode === 'foreign-link' ? join(f.repo, 'packages', 'a') : join(source, 'packages', 'a'), join(source, 'node_modules', 'workspace-a'), 'dir');
    if (mode === 'shadowed-child') {
      const foreign = join(f.root, 'foreign-package'); mkdirSync(foreign);
      write(join(foreign, 'package.json'), { name: 'workspace-a', version: '1.0.0' });
      mkdirSync(join(source, 'packages', 'a', 'node_modules'));
      symlinkSync(foreign, join(source, 'packages', 'a', 'node_modules', 'workspace-a'), 'dir');
    }
    if (mode === 'stale-code') writeFileSync(join(source, 'packages', 'a', 'index.js'), 'export const value = 2;');
    write(f.preflight, { ...json(f.preflight), dependencyReuseAllowed: true, dependencySourcePath: source, dependencyWorktreeInstallAllowed: false });
    // pnpm links most workspace packages only into their dependents, never at the root.
    const ready = mode === 'matching' || mode === 'large-snapshot' || mode === 'missing-link';
    expect((await f.prepare()).code).toBe(ready ? 0 : 2);
    if (!ready) expect(json(join(dirname(f.prepared), 'manifest.json')).error.code).toBe('DEPENDENCY_ENVIRONMENT_NOT_READY');
  });
  it.each(['matching', 'missing', 'changed', 'broken'] as const)('prepares usable dependencies before review: %s', async mode => {
    const f = fixture();
    write(join(f.repo, 'package.json'), { dependencies: { fixture: '1.0.0' } });
    writeFileSync(join(f.repo, 'bun.lock'), 'frozen-lock');
    writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'dependency inputs');
    if (mode !== 'missing') {
      mkdirSync(join(f.repo, 'node_modules', 'fixture'), { recursive: true });
      write(join(f.repo, 'node_modules', 'fixture', 'package.json'), { name: 'fixture', version: '1.0.0' });
    }
    if (mode === 'changed') writeFileSync(join(f.repo, 'bun.lock'), 'uninstalled-lock');
    if (mode === 'broken') rmSync(join(f.repo, 'node_modules', 'fixture'), { recursive: true });
    write(f.preflight, { ...json(f.preflight), dependencyReuseAllowed: true });
    const result = await f.prepare();
    if (mode === 'matching') {
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(realpathSync(join(f.worktree, 'node_modules'))).toBe(realpathSync(join(f.repo, 'node_modules')));
      expect(json(join(f.prepared, 'context.json')).dependencies).toMatchObject({ state: 'ready', source: f.repo });
      expect(await f.prepare()).toMatchObject({ code: 0 });
    } else {
      expect(result.code).toBe(2);
      expect(json(join(dirname(f.prepared), 'manifest.json'))).toMatchObject({ status: 'fail', error: { code: 'DEPENDENCY_ENVIRONMENT_NOT_READY', retryable: true } });
      expect(existsSync(join(f.prepared, 'context.json'))).toBe(false);
    }
  });
  // Real frozen install (no network: the only dependency is a tracked file: package).
  const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  function lockedProject(f: ReturnType<typeof fixture>) {
    mkdirSync(join(f.repo, 'vendor', 'fixture'), { recursive: true });
    write(join(f.repo, 'vendor', 'fixture', 'package.json'), { name: 'fixture', version: '1.0.0' });
    // A root lifecycle hook that would fail without the project sources.
    write(join(f.repo, 'package.json'), { name: 'app', private: true, scripts: { postinstall: 'exit 7', build: 'tsc' },
      dependencies: { fixture: 'file:./vendor/fixture' } });
    writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    execFileSync('bun', ['install', '--ignore-scripts'], { cwd: f.repo, stdio: 'ignore' });
    rmSync(join(f.repo, 'node_modules'), { recursive: true, force: true });
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'locked dependency inputs');
  }
  it.skipIf(!hasBun).each(['not-approved', 'approved-mismatch', 'hand-made-source'] as const)('installs an isolated run environment from the exact task manifests when reuse is not possible: %s', async mode => {
    const f = fixture(); lockedProject(f);
    const handMade = join(f.root, 'hand-made');
    if (mode === 'hand-made-source') {
      // The blocked run: a hand-built env with scripts stripped and child manifests missing.
      mkdirSync(join(handMade, 'node_modules', 'fixture'), { recursive: true });
      const pkg = json(join(f.repo, 'package.json')); delete pkg.scripts; write(join(handMade, 'package.json'), pkg);
      writeFileSync(join(handMade, 'bun.lock'), readFileSync(join(f.repo, 'bun.lock')));
      write(join(handMade, 'node_modules', 'fixture', 'package.json'), { name: 'fixture', version: '1.0.0' });
    }
    write(f.preflight, { ...json(f.preflight), ...(mode === 'not-approved' ? { dependencyReuseAllowed: false }
      : mode === 'approved-mismatch' ? { dependencyReuseAllowed: true } : { dependencyReuseAllowed: false, dependencySourcePath: handMade }) });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const dependencies = json(join(f.prepared, 'context.json')).dependencies;
    expect(dependencies).toMatchObject({ state: 'ready', names: ['fixture'] });
    expect(dependencies.source.startsWith(join(f.run, 'dependencies') + '/')).toBe(true);
    if (mode === 'approved-mismatch') expect(dependencies.reuseRejected).toMatch(/node_modules|no such file/);
    expect(realpathSync(join(f.worktree, 'node_modules'))).toBe(dependencies.modules);
    expect(json(join(f.worktree, 'node_modules', 'fixture', 'package.json')).version).toBe('1.0.0');
    // Manifests are byte-identical (scripts restored) and nothing leaked into the repository or worktree.
    expect(readFileSync(join(dependencies.source, 'package.json'))).toEqual(readFileSync(join(f.repo, 'package.json')));
    expect(readFileSync(join(dependencies.source, 'bun.lock'))).toEqual(readFileSync(join(f.repo, 'bun.lock')));
    expect(existsSync(join(f.repo, 'node_modules'))).toBe(false);
    expect(f.git(f.worktree, 'status', '--porcelain')).toBe('');
    // A retry reuses the completed environment instead of reinstalling.
    const log = dependencies.source + '.install.log', before = statSync(log).mtimeMs;
    rmSync(join(f.prepared, 'context.json'));
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(statSync(log).mtimeMs).toBe(before);
    expect(readdirSync(join(f.run, 'dependencies')).filter(name => !name.includes('.'))).toHaveLength(1);
  });
  it.skipIf(!hasBun)('fails closed instead of installing when repository rules forbid it or the frozen install fails', async () => {
    const f = fixture(); lockedProject(f);
    write(f.preflight, { ...json(f.preflight), dependencyReuseAllowed: false, dependencyInstallAllowed: false });
    expect((await f.prepare()).code).toBe(2);
    expect(json(join(dirname(f.prepared), 'manifest.json')).error).toMatchObject({ code: 'DEPENDENCY_ENVIRONMENT_NOT_READY', retryable: true });
    expect(existsSync(join(f.run, 'dependencies'))).toBe(false);
    // Out-of-date lockfile: frozen install must refuse rather than rewrite it.
    const g = fixture(); lockedProject(g);
    write(join(g.repo, 'package.json'), { ...json(join(g.repo, 'package.json')), dependencies: { fixture: 'file:./vendor/fixture', other: 'file:./vendor/fixture' } });
    g.git(g.repo, 'commit', '-qam', 'stale lockfile');
    write(g.preflight, { ...json(g.preflight), dependencyReuseAllowed: false });
    expect((await g.prepare()).code).toBe(2);
    expect(json(join(dirname(g.prepared), 'manifest.json')).error).toMatchObject({ code: 'DEPENDENCY_ENVIRONMENT_NOT_READY', message: expect.stringContaining('dependency install failed') });
    expect(existsSync(join(g.prepared, 'context.json'))).toBe(false);
  });
  const hasPnpm = spawnSync('pnpm', ['--version'], { cwd: tmpdir(), stdio: 'ignore' }).status === 0;
  function pnpmWorkspace(f: ReturnType<typeof fixture>) {
    // A root lifecycle hook that would fail the install if it ran.
    write(join(f.repo, 'package.json'), { name: 'mono', private: true, scripts: { postinstall: 'exit 7' } });
    writeFileSync(join(f.repo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(join(f.repo, 'packages', 'a'), { recursive: true }); mkdirSync(join(f.repo, 'packages', 'b'));
    write(join(f.repo, 'packages', 'a', 'package.json'), { name: 'workspace-a', version: '1.0.0', main: 'index.js' });
    writeFileSync(join(f.repo, 'packages', 'a', 'index.js'), 'module.exports = 1;\n');
    write(join(f.repo, 'packages', 'b', 'package.json'), { name: 'workspace-b', version: '1.0.0', dependencies: { 'workspace-a': 'workspace:*' } });
    writeFileSync(join(f.repo, '.gitignore'), 'node_modules\n');
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: f.repo, stdio: 'ignore' });
    f.git(f.repo, 'add', '.'); f.git(f.repo, 'commit', '-qm', 'pnpm workspace');
  }
  it.skipIf(!hasPnpm)('installs a workspace repository inside the task worktree from its frozen lockfile and follows workspace changes', async () => {
    const f = fixture(); pnpmWorkspace(f);
    const manifest = readFileSync(join(f.repo, 'package.json'));
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json');
    expect(json(context).dependencies).toMatchObject({ state: 'ready', mode: 'worktree', source: f.worktree, modules: join(f.worktree, 'node_modules') });
    expect(realpathSync(join(f.worktree, 'packages', 'b', 'node_modules', 'workspace-a'))).toBe(join(f.worktree, 'packages', 'a'));
    expect(readFileSync(join(f.worktree, 'package.json'))).toEqual(manifest);
    expect(f.git(f.worktree, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(f.repo, 'node_modules'))).toBe(false);
    // Workspace code changes keep the environment; a new workspace package is linked by record.
    writeFileSync(join(f.worktree, 'packages', 'a', 'index.js'), 'module.exports = 2;\n');
    mkdirSync(join(f.worktree, 'packages', 'c'));
    write(join(f.worktree, 'packages', 'c', 'package.json'), { name: 'workspace-c', version: '1.0.0', dependencies: { 'workspace-a': 'workspace:*' } });
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: f.worktree, stdio: 'ignore' });
    f.git(f.worktree, 'add', '.'); f.git(f.worktree, 'commit', '-qm', 'workspace change');
    const implemented = f.out('development-review-loop.i001.implement');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', join(implemented, 'candidate.json'), '--round', '1'], implemented)).toMatchObject({ code: 0, stderr: '' });
    expect(realpathSync(join(f.worktree, 'packages', 'c', 'node_modules', 'workspace-a'))).toBe(join(f.worktree, 'packages', 'a'));
    expect(json(join(implemented, 'validation.json')).checks[0].exitCode).toBe(0);
    expect(f.git(f.worktree, 'status', '--porcelain')).toBe('');
  });
  it.each(['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14', 'v15', 'v16', 'v17'])('upgrades the complete previous %s preset while preserving configured role defaults', version => {
    const previous = JSON.parse(readFileSync(new URL(`./fixtures/development-review/${version}.json`, import.meta.url), 'utf8'));
    const selected = { developer: 'cli_custom_dev', correctness: 'cli_custom_check', regression: 'cli_custom_regression' };
    const bound = JSON.parse(JSON.stringify(previous), (_key, value) =>
      typeof value === 'string' ? Object.entries(BOTS).reduce((v, [role, bot]) => v === bot ? selected[role as keyof typeof selected] : v, value) : value);
    expect(upgradeDevelopmentReviewPreset(bound)).toEqual(createDevelopmentReviewPreset(selected));
    bound.specTemplate.requirement += ' customized behavior';
    expect(upgradeDevelopmentReviewPreset(bound)).toBeUndefined();
    expect(upgradeDevelopmentReviewPreset(createDevelopmentReviewPreset(selected))).toBeUndefined();
  });
  it('upgrades only an exact previous built-in when the two review roles share a bot', () => {
    const previous = JSON.parse(readFileSync(new URL('./fixtures/development-review/v11.json', import.meta.url), 'utf8'));
    const selected = { developer: 'cli_custom_dev', correctness: 'cli_shared', regression: 'cli_shared' };
    const bound = JSON.parse(JSON.stringify(previous), (_key, value) =>
      typeof value === 'string' ? Object.entries(BOTS).reduce((v, [role, bot]) => v === bot ? selected[role as keyof typeof selected] : v, value) : value);
    expect(upgradeDevelopmentReviewPreset(bound)).toEqual(createDevelopmentReviewPreset(selected));
    bound.dagTemplate.nodes.find((node: { id: string }) => node.id === 'complete').goal += ' custom';
    expect(upgradeDevelopmentReviewPreset(bound)).toBeUndefined();
    expect(upgradeDevelopmentReviewPreset(createDevelopmentReviewPreset(selected))).toBeUndefined();
  });
  it('blocks a preflight whose fields prepare consumes have the wrong type, at preflight itself', () => {
    const preflight = createDevelopmentReviewPreset(BOTS).dagTemplate.nodes.find(node => node.id === 'preflight')!;
    const dir = mkdtempSync(join(tmpdir(), 'dev-rev-preflight-schema-')), path = join(dir, 'result.json');
    try {
      const check = (extra: Record<string, unknown>) => {
        writeFileSync(path, JSON.stringify({ state: 'READY', repositoryAccess: true, ...extra }));
        return validateResult(path, preflight.resultSchema!);
      };
      expect(check({}).ok).toBe(true);
      expect(check({ resolvedRequirement: 'spec text', validationCommands: [] }).ok).toBe(true);
      expect(check({ resolvedRequirement: { text: 'spec text' } }).problems).toEqual(['field "resolvedRequirement" must be of type string']);
      expect(check({ validationCommands: { id: 'test' } }).problems).toEqual(['field "validationCommands" must be of type array']);
      expect(check({ dependencyReuseAllowed: false, dependencyInstallAllowed: true, dependencyWorktreeInstallAllowed: false, dependencySourcePath: '/deps' }).ok).toBe(true);
      expect(check({ dependencyReuseAllowed: 'false' }).problems).toEqual(['field "dependencyReuseAllowed" must be of type boolean']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('embeds ASCII-only tools so Bun and Node build identical bytes and digests', () => {
    expect(/^[\x00-\x7f]*$/.test(DEVELOPMENT_REVIEW_RESOURCES[0]!.content)).toBe(true);
  });
  it('is a source-free, lint-clean and schema-valid executable definition with explicit dependencies', () => {
    const draft = createDevelopmentReviewPreset(BOTS), warnings: string[] = [];
    collectSavedWorkflowReusableTextWarnings(draft, 'draft', warnings);
    expect(warnings).toEqual([]);
    expect(draft.sourceRunId).toBeUndefined();
    expect(Object.keys(draft.inputs).sort()).toEqual(['mode', 'recovery_source', 'repo_path', 'requirement', 'target_branch', 'validation_commands'].sort());
    for (const [name, input] of Object.entries(draft.inputs)) {
      if (name === 'recovery_source') expect(input.default).toEqual({});
      else { expect(input.required).toBe(true); expect(input.default).toBeUndefined(); }
    }
    expect(validateSavedWorkflowRevisionPayload({ ...draft, workflowId: 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', humanVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', createdBy: { openId: 'fixture-owner', larkAppId: 'cli_developer' } }).roles).toEqual(draft.roles);
    const loop = draft.dagTemplate.nodes.find(node => node.type === 'loop')!;
    expect(loop).toMatchObject({ maxIterations: 5, sessionPolicy: 'fresh', depends: [{ from: 'prepare' }],
      exit: { node: 'verify-review-gate', when: { path: 'result.passed', equals: true } }, feedback: ['verify-review-gate.result'] });
    for (const id of ['review-correctness', 'review-regression']) {
      const reviewer = loop.body!.nodes.find(node => node.id === id)!;
      expect(reviewer.timeoutSec).toBe(loop.body!.nodes.find(node => node.id === 'implement')!.timeoutSec);
      expect(reviewer.depends).toEqual([{ from: 'implement' }]);
      expect(reviewer.inputs.every(input => input.from === 'implement')).toBe(true);
    }
    expect(draft.dagTemplate.nodes.find(node => node.id === 'create-mr')!.humanGate).toMatchObject({ approveOptions: ['approve'] });
    expect(draft.dagTemplate.nodes.find(node => node.id === 'publish-direct')!.humanGate).toBeNull();
    // The developer never runs its own gate or verifies its own publication.
    expect(loop.body!.nodes.find(node => node.id === 'verify-review-gate')!.bot).toBe(BOTS.regression);
    expect(draft.dagTemplate.nodes.find(node => node.id === 'verify-publication')!.bot).toBe(BOTS.regression);
    expect(draft.roles!.developer!.nodes).not.toContain('development-review-loop/verify-review-gate');
    // Routing to the ungated publisher comes from the independent check, never the developer's plan.
    expect(draft.dagTemplate.nodes.find(node => node.id === 'check-delivery')!.bot).toBe(BOTS.regression);
    expect(draft.dagTemplate.nodes.find(node => node.id === 'create-mr')!.humanGate!.contextFrom).toEqual({ nodeId: 'check-delivery', field: 'approvalSummary' });
    for (const id of ['create-mr', 'publish-direct']) {
      expect(draft.dagTemplate.nodes.find(node => node.id === id)!.depends.filter(dep => dep.when).map(dep => dep.from)).toEqual(['check-delivery']);
    }
  });

  it('refuses unresolved or non-independent default identities', () => {
    expect(() => createDevelopmentReviewPreset({ ...BOTS, developer: 'A display name' })).toThrow(/resolved bot app/);
    expect(() => createDevelopmentReviewPreset({ ...BOTS, correctness: BOTS.developer })).toThrow(/distinct/);
    expect(() => createDevelopmentReviewPreset({ ...BOTS, regression: BOTS.developer })).toThrow(/distinct/);
  });
});

describe('fixed development-review executable resources', () => {
  it('accepts two role-specific reports from one reviewer but rejects reusing one report for both roles', async () => {
    const f = await evidenceFixture('sha1', 1, { ...BOTS, regression: BOTS.correctness });
    expect(await f.gate()).toMatchObject({ code: 0 });
    expect(json(f.result).passed).toBe(true);
    write(f.regression, json(f.correctness));
    await f.gate();
    expect(json(f.result).passed).toBe(false);
  });

  it.each(['correctness', 'regression'] as const)('rejects an approve carrying a %s nit and returns actionable feedback', async role => {
    const f = await evidenceFixture();
    const finding = { blocking: false, location: 'value.txt:1', impact: 'An unnecessary duplicate remains', evidence: 'The same value is assigned twice' };
    write(f[role], { ...json(f[role]), findings: [finding] });
    expect(await f.gate()).toMatchObject({ code: 0, stderr: '' });
    expect(json(f.result).passed).toBe(false);
    expect(json(f.result).unresolvedFindings).toEqual([{ role, ...finding }]);
    expect(json(join(f.gated, 'release-candidate.json')).passed).toBe(false);
    expect(readFileSync(join(f.gated, 'feedback.md'), 'utf8')).toContain(finding.evidence);
    expect(readFileSync(f.result, 'utf8')).not.toContain('private-review-evidence-canary');
  });

  it('returns both reviewers findings for assessment, then requires clean reviews of the next candidate', async () => {
    const f = await evidenceFixture();
    const finding = { blocking: false, location: 'value.txt:1', impact: 'A redundant line remains', evidence: 'Duplicate line in the candidate' };
    for (const role of ['correctness', 'regression'] as const) write(f[role], { ...json(f[role]), decision: 'changes_requested', findings: [finding] });
    expect(await f.gate()).toMatchObject({ code: 0 });
    expect(json(f.result)).toMatchObject({ passed: false, unresolvedFindings: [
      { role: 'correctness', ...finding }, { role: 'regression', ...finding },
    ] });

    writeFileSync(join(f.worktree, 'value.txt'), 'resolved\n'); f.git(f.worktree, 'add', 'value.txt'); f.git(f.worktree, 'commit', '-qm', 'resolve finding');
    const implemented = f.out('development-review-loop.i002.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
    expect(await f.tool('candidate', ['--context', f.context, '--round', '2'], implemented)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', f.context, '--candidate', candidate, '--round', '2'], implemented)).toMatchObject({ code: 0 });
    const output = f.out('development-review-loop.i002.verify-review-gate'), result = join(output, 'result.json');
    const args = f.gateArgs.map(value => value === f.candidate ? candidate : value === f.validation ? validation : value === f.result ? result : value === '1' ? '2' : value);
    expect(await f.tool('gate', args, output)).toMatchObject({ code: 0 });
    expect(json(result).passed).toBe(false); // Old approvals/findings cannot authorize the new head.
    for (const role of ['correctness', 'regression'] as const) write(f[role], { ...json(f[role]), ...json(candidate), decision: 'approve', findings: [],
      candidateSha256: sha(candidate), validationSha256: sha(validation) });
    expect(await f.tool('gate', args, output)).toMatchObject({ code: 0 });
    expect(json(result)).toMatchObject({ passed: true, unresolvedFindings: [], round: 2, headSha: json(candidate).headSha });
  });

  it('never forwards a forged reviewers findings as authenticated developer feedback', async () => {
    const f = await evidenceFixture();
    const finding = { blocking: false, location: 'value.txt:1', impact: 'Needs assessment', evidence: 'Authenticated finding evidence' };
    write(f.correctness, { ...json(f.correctness), reviewerId: BOTS.developer, findings: [{ ...finding, evidence: 'forged-finding-canary' }] });
    write(f.regression, { ...json(f.regression), decision: 'changes_requested', findings: [finding] });
    expect(await f.gate()).toMatchObject({ code: 0 });
    expect(json(f.result)).toMatchObject({ passed: false, unresolvedFindings: [{ role: 'regression', ...finding }] });
    expect(readFileSync(f.result, 'utf8')).not.toContain('forged-finding-canary');
  });

  it('prepares an existing PR at its fetched head against the merge base, even when the PR lags its target', async () => {
    const f = fixture();
    const mergeBase = f.git(f.repo, 'rev-parse', 'HEAD');
    f.git(f.repo, 'checkout', '-qb', 'feature/review');
    writeFileSync(join(f.repo, 'value.txt'), 'existing PR\n'); f.git(f.repo, 'add', 'value.txt'); f.git(f.repo, 'commit', '-qm', 'existing PR');
    const headSha = f.git(f.repo, 'rev-parse', 'HEAD');
    f.git(f.repo, 'checkout', '-q', 'main');
    writeFileSync(join(f.repo, 'other.txt'), 'target moved\n'); f.git(f.repo, 'add', 'other.txt'); f.git(f.repo, 'commit', '-qm', 'target moved');
    f.git(f.repo, 'remote', 'add', 'origin', f.repo);
    f.git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    const reviewTarget = { url: 'https://example.invalid/pull/23', author: 'alice', remote: 'origin',
      sourceBranch: 'feature/review', targetBranch: 'main', headSha };
    write(f.params, { params: { ...json(f.params).params, mode: 'review', target_branch: 'ignored-default' } });
    write(f.preflight, { ...json(f.preflight), reviewTarget });
    expect(await f.prepare()).toMatchObject({ code: 2, stderr: 'review mode requires the verified CLI login\n' });
    write(f.preflight, { ...json(f.preflight), login: 'me' });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(f.git(f.worktree, 'rev-parse', 'HEAD')).toBe(headSha);
    expect(json(join(f.prepared, 'context.json'))).toMatchObject({ mode: 'review', baseSha: mergeBase, startSha: headSha, targetBranch: 'main', login: 'me' });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });

    const unfetched = fixture();
    write(unfetched.params, { params: { ...json(unfetched.params).params, mode: 'continue' } });
    write(unfetched.preflight, { ...json(unfetched.preflight), reviewTarget: { ...reviewTarget, headSha: unfetched.git(unfetched.repo, 'rev-parse', 'HEAD') } });
    unfetched.git(unfetched.repo, 'remote', 'add', 'origin', unfetched.repo);
    expect((await unfetched.prepare()).code).toBe(2); // The target was never fetched into refs/remotes.
    expect(existsSync(unfetched.worktree)).toBe(false);
    const stray = fixture();
    write(stray.preflight, { ...json(stray.preflight), reviewTarget });
    expect(await stray.prepare()).toMatchObject({ code: 2, stderr: 'new development must not carry a PR target\n' });
  });

  it('reviews another author PR: no repair commits, failing checks become findings, every finding reaches the comment', async () => {
    const f = fixture();
    f.git(f.repo, 'checkout', '-qb', 'feature/review');
    writeFileSync(join(f.repo, 'value.txt'), 'existing PR\n'); f.git(f.repo, 'add', 'value.txt'); f.git(f.repo, 'commit', '-qm', 'existing PR');
    const headSha = f.git(f.repo, 'rev-parse', 'HEAD');
    f.git(f.repo, 'checkout', '-q', 'main');
    f.git(f.repo, 'remote', 'add', 'origin', f.repo); f.git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    const reviewTarget = { url: 'https://example.invalid/pull/23', author: 'Alice', remote: 'origin', sourceBranch: 'feature/review', targetBranch: 'main', headSha };
    write(f.params, { params: { ...json(f.params).params, mode: 'review',
      validation_commands: [{ id: 'failing', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutSec: 10 }] } });
    write(f.preflight, { ...json(f.preflight), reviewTarget, login: 'me' });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json');
    const implemented = f.out('development-review-loop.i001.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
    writeFileSync(join(f.worktree, 'value.txt'), 'reviewer edit\n'); f.git(f.worktree, 'commit', '-qam', 'unwanted repair');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 2, stderr: 'review mode must not change the PR head\n' });
    f.git(f.worktree, 'reset', '-q', '--hard', headSha);
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0, stderr: '' });
    expect(await f.tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0, stderr: '' });
    const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'PR changes value.txt; check failing exits 3.\n');
    const finding = { blocking: true, location: 'value.txt:1', impact: 'Check fails', evidence: 'failing.log exit 3' };
    const reviews = Object.fromEntries((['correctness', 'regression'] as const).map(role => {
      const filename = join(f.root, role + '.json');
      write(filename, { ...json(candidate), role, reviewerId: BOTS[role], decision: role === 'correctness' ? 'changes_requested' : 'approve',
        findings: role === 'correctness' ? [finding] : [], coverage: ['diff'], evidence: ['read the PR'],
        candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
      return [role, filename];
    }));
    const gated = f.out('development-review-loop.i001.verify-review-gate'), result = join(gated, 'result.json');
    const gateArgs = ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
      '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews.correctness!,
      '--regression', reviews.regression!, '--round', '1', '--out', result];
    expect(await f.tool('gate', gateArgs, gated)).toMatchObject({ code: 0, stderr: '' });
    expect(json(result)).toMatchObject({ passed: true, mode: 'review', validationFailures: ['failing'], unresolvedFindings: [{ role: 'correctness', ...finding }] });
    write(reviews.regression!, { ...json(reviews.regression!), decision: 'approve', findings: [finding] });
    expect(await f.tool('gate', gateArgs, gated)).toMatchObject({ code: 0 });
    expect(json(result).passed).toBe(false); // approve with findings is inconsistent
    write(reviews.regression!, { ...json(reviews.regression!), decision: 'blocked', findings: [] });
    expect(await f.tool('gate', gateArgs, gated)).toMatchObject({ code: 0 });
    expect(json(result).passed).toBe(false);
    write(reviews.regression!, { ...json(reviews.regression!), decision: 'approve', findings: [] });
    expect(await f.tool('gate', gateArgs, gated)).toMatchObject({ code: 0 });
    expect(json(join(gated, 'release-candidate.json')).artifacts['change-summary']).toMatchObject({ sha256: sha(summary) });

    const output = f.out('prepare-mr'), draft = join(output, 'mr-draft.json'), comment = join(output, 'review-comment.md');
    const plan = () => f.tool('delivery', ['--context', context, '--release', join(gated, 'release-candidate.json'), '--draft', draft, '--comment', comment], output);
    write(draft, { repository: 'example/project', summary: 'Reviewed; one finding', existingPr: { url: reviewTarget.url, state: 'OPEN', sourceBranch: 'feature/review', targetBranch: 'main' } });
    // A preface that hides the problems cannot drop them: the findings section is generated from the gate.
    writeFileSync(comment, 'Review passed.\n');
    expect(await plan()).toMatchObject({ code: 0, stderr: '' });
    const planned = json(join(output, 'result.json'));
    expect(planned).toMatchObject({ action: 'comment', publicationRequired: true, approvalRequired: true, directPublish: false, pushRemote: null });
    expect(planned.commentBody).toBe('结论：需要修改（1 条意见，1 项检查失败）\n1. [阻塞] value.txt:1\n   影响：Check fails\n' +
      '   证据：failing.log exit 3\n检查失败：failing\n\n---\n评审说明：\nReview passed.');
    expect(planned.approvalSummary).toContain(planned.commentBody);
    expect(planned.commentSha256).toBe('sha256:' + createHash('sha256').update(planned.commentBody).digest('hex'));
    const routed = f.out('check-delivery'), routeOut = join(routed, 'result.json');
    const route = () => f.tool('route', ['--context', context, '--release', join(gated, 'release-candidate.json'), '--plan', join(output, 'result.json'), '--out', routeOut], routed);
    expect(await route()).toMatchObject({ code: 0, stderr: '' });
    expect(json(routeOut)).toMatchObject({ action: 'comment', publicationRequired: true, approvalRequired: true, directPublish: false });
    write(join(output, 'result.json'), { ...planned, approvalRequired: false, directPublish: true }); // The developer forges a direct publication.
    expect(await route()).toMatchObject({ code: 2, stderr: 'delivery plan skipped a required approval\n' });
    write(join(output, 'result.json'), { ...planned, commentBody: 'Review passed.', commentSha256: 'sha256:' + createHash('sha256').update('Review passed.').digest('hex') });
    expect(await route()).toMatchObject({ code: 2, stderr: 'planned comment does not carry every finding\n' });
    // An unclosed HTML comment in the note is escaped, and a plan smuggling raw HTML in is refused.
    writeFileSync(comment, 'Review passed. <!-- hide the rest\n');
    expect(await plan()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(output, 'result.json')).commentBody.endsWith('评审说明：\nReview passed. &lt;!-- hide the rest')).toBe(true);
    const hidden = planned.commentBody + ' <!--';
    write(join(output, 'result.json'), { ...planned, commentBody: hidden, commentSha256: 'sha256:' + createHash('sha256').update(hidden).digest('hex') });
    expect(await route()).toMatchObject({ code: 2, stderr: 'planned comment does not carry every finding\n' });
    write(join(output, 'result.json'), { ...planned, approvalSummary: 'Harmless' });
    expect(await route()).toMatchObject({ code: 0, stderr: '' });
    expect(json(routeOut).approvalSummary).toBe(planned.approvalSummary); // Material is rebuilt, not copied.
    write(context, { ...json(context), login: 'alice' }); // A case-insensitive match: the initiator's own PR.
    write(join(gated, 'release-candidate.json'), { ...json(join(gated, 'release-candidate.json')),
      artifacts: { ...json(join(gated, 'release-candidate.json')).artifacts, context: { path: context, sha256: sha(context) } } });
    expect(await plan()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(output, 'result.json'))).toMatchObject({ approvalRequired: false, directPublish: true });
    // The login/author came from the developer's preflight: without an independent confirmation it needs approval.
    expect(await route()).toMatchObject({ code: 0, stderr: '' });
    expect(json(routeOut)).toMatchObject({ approvalRequired: true, directPublish: false, identityConfirmed: false });
    const identity = join(routed, 'observed-identity.json');
    const routeWithIdentity = () => f.tool('route', ['--context', context, '--release', join(gated, 'release-candidate.json'), '--plan', join(output, 'result.json'),
      '--observed-identity', identity, '--out', routeOut], routed);
    write(identity, { login: 'carol', author: 'Alice' }); // The real poster is someone else.
    expect(await routeWithIdentity()).toMatchObject({ code: 0, stderr: '' });
    expect(json(routeOut)).toMatchObject({ approvalRequired: true, directPublish: false });
    expect(json(routeOut).approvalSummary).toContain('在他人 PR 上发布评审评论');
    write(identity, { login: 'ALICE', author: 'alice' });
    expect(await routeWithIdentity()).toMatchObject({ code: 0, stderr: '' });
    expect(json(routeOut)).toMatchObject({ approvalRequired: false, directPublish: true, identityConfirmed: true });

    const verified = f.out('verify-publication'), observedPr = join(verified, 'observed-pr.json'), observedComment = join(verified, 'observed-comment.md');
    write(observedPr, { url: reviewTarget.url, state: 'OPEN', sourceBranch: 'feature/review', targetBranch: 'main', headSha });
    const verify = () => f.tool('verify-publication', ['--context', context, '--release', join(gated, 'release-candidate.json'),
      '--plan', join(output, 'result.json'), '--route', routeOut, '--observed', observedPr, '--observed-comment', observedComment, '--out', join(verified, 'verification.json')], verified);
    writeFileSync(observedComment, 'Changes requested.\n- edited after approval\n');
    expect(await verify()).toMatchObject({ code: 2, stderr: 'posted comment differs from the planned text\n' });
    writeFileSync(observedComment, json(join(output, 'result.json')).commentBody.replace(/\n/g, '\r\n') + '\n');
    expect(await verify()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(verified, 'verification.json'))).toMatchObject({ approvalRequired: false, directPublish: true, identityConfirmed: true });
    // The plan still claims a direct publication, but the independent check fell back to approval: record the approval.
    write(identity, { login: 'carol', author: 'Alice' });
    expect(await routeWithIdentity()).toMatchObject({ code: 0, stderr: '' });
    expect(await verify()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(verified, 'verification.json'))).toMatchObject({ approvalRequired: true, directPublish: false, identityConfirmed: false });
    const fallback = json(routeOut);
    for (const forged of [{ ...fallback, approvalRequired: false, directPublish: true }, { ...fallback, planSha256: 'sha256:' + '0'.repeat(64) }]) {
      write(routeOut, forged);
      expect(await verify()).toMatchObject({ code: 2, stderr: 'routing result is not bound to this plan\n' });
    }
    write(identity, { login: 'ALICE', author: 'alice' });
    expect(await routeWithIdentity()).toMatchObject({ code: 0, stderr: '' });
    const planned2 = json(join(output, 'result.json'));
    for (const [forgery, message] of [
      [{ action: 'create' }, 'delivery action does not fit the mode'],
      [{ commentBody: 'Looks fine.', commentSha256: 'sha256:' + createHash('sha256').update('Looks fine.').digest('hex') }, 'planned comment does not carry every finding'],
    ] as const) {
      write(join(output, 'result.json'), { ...planned2, ...forgery });
      expect(await verify()).toMatchObject({ code: 2, stderr: message + '\n' });
    }
    write(join(output, 'result.json'), planned2);
    write(context, { ...json(context), login: 'me' }); // Another author's PR now: a direct plan skipped approval.
    write(join(gated, 'release-candidate.json'), { ...json(join(gated, 'release-candidate.json')),
      artifacts: { ...json(join(gated, 'release-candidate.json')).artifacts, context: { path: context, sha256: sha(context) } } });
    write(join(output, 'result.json'), { ...planned2, contextSha256: sha(context), releaseSha256: sha(join(gated, 'release-candidate.json')) });
    expect(await verify()).toMatchObject({ code: 2, stderr: 'delivery plan skipped a required approval\n' });
    expect(json(join(verified, 'verification.json'))).toMatchObject({ verified: true, action: 'comment', url: reviewTarget.url });
  });

  it.each([['continue', 'record'], ['review', 'record'], ['continue', 'record, SIGTERM trapped'], ['continue', 'independent re-run']] as const)('reports a check stopped by its validation budget as VALIDATION_TIMEOUT, never as a failure to fix or a pass (%s, %s)', async (mode, stoppedIn) => {
    const f = fixture();
    f.git(f.repo, 'checkout', '-qb', 'feature/slow');
    writeFileSync(join(f.repo, 'value.txt'), 'existing PR\n'); f.git(f.repo, 'commit', '-qam', 'existing PR');
    const headSha = f.git(f.repo, 'rev-parse', 'HEAD');
    f.git(f.repo, 'checkout', '-q', 'main');
    f.git(f.repo, 'remote', 'add', 'origin', f.repo); f.git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    // A real child that outlives its 1s budget (only once the marker exists): spawnSync stops it with ETIMEDOUT.
    const slow = join(f.root, 'slow-marker');
    const atRecord = stoppedIn !== 'independent re-run', trapped = stoppedIn === 'record, SIGTERM trapped';
    if (atRecord) writeFileSync(slow, '');
    write(f.params, { params: { ...json(f.params).params, mode,
      validation_commands: [{ id: 'slow-gate', argv: [process.execPath, '-e', (trapped ? 'process.on("SIGTERM", () => process.exit(0)); ' : '') + 'if (require("fs").existsSync(process.argv[1])) setTimeout(() => {}, 30000)', slow], timeoutSec: 1 }] } });
    write(f.preflight, { ...json(f.preflight), login: 'me',
      reviewTarget: { url: 'https://example.invalid/pull/9', author: mode === 'review' ? 'Alice' : 'me', remote: 'origin', sourceBranch: 'feature/slow', targetBranch: 'main', headSha } });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json');
    const implemented = f.out('development-review-loop.i001.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0, stderr: '' });
    const started = Date.now();
    const recorded = await f.tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented);
    expect(Date.now() - started).toBeLessThan(20_000);
    if (atRecord) {
      // The producer itself stops the attempt with a stable code; no agent translation needed.
      expect(recorded.code).toBe(2);
      expect(recorded.stderr).toContain('VALIDATION_TIMEOUT: slow-gate stopped after its 1s budget');
      const manifest = await readAndValidateManifest(join(dirname(implemented), 'manifest.json'), implemented);
      expect(manifest).toMatchObject({ status: 'fail', error: { code: 'VALIDATION_TIMEOUT', retryable: false } });
      expect(manifest.files.map(file => file.name)).toEqual(expect.arrayContaining(['candidate', 'validation', 'log-slow-gate']));
      // An agent cannot re-deliver the stopped attempt as ok.
      const republish = await f.tool('publish', ['--entry', 'candidate', 'json', 'candidate.json', '--entry', 'validation', 'json', 'validation.json'], implemented);
      expect(republish.code).toBe(2);
      expect(republish.stderr).toContain('only a VALIDATION_TIMEOUT failure can be delivered');
      expect(json(join(dirname(implemented), 'manifest.json')).status).toBe('fail');
    } else {
      expect(recorded).toMatchObject({ code: 0, stderr: '' });
    }
    const check = json(validation).checks[0];
    if (atRecord) {
      // The real outcome is kept, and the budget stop is recorded even when the command
      // caught SIGTERM and exited 0: the timeout, not the exit status, decides.
      expect(check).toMatchObject({ id: 'slow-gate', timedOut: true, timeoutSec: 1, ...(trapped ? { exitCode: 0, signal: null } : { exitCode: null, signal: 'SIGTERM' }) });
      expect(readFileSync(join(implemented, check.log.path), 'utf8')).toContain('stopped after its 1s validation budget');
    } else {
      expect(check).toMatchObject({ exitCode: 0, signal: null });
      expect(check).not.toHaveProperty('timedOut');
      writeFileSync(slow, '');
    }
    const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'No change; the check ran out of budget.\n');
    const reviews = (['correctness', 'regression'] as const).map(role => {
      const filename = join(f.root, role + '.json');
      write(filename, { ...json(candidate), role, reviewerId: BOTS[role], decision: mode === 'review' ? 'changes_requested' : 'approve',
        findings: mode === 'review' ? [{ blocking: false, location: 'value.txt:1', impact: 'x', evidence: 'y' }] : [], coverage: ['diff'], evidence: ['ok'],
        candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
      return filename;
    });
    const gated = f.out('development-review-loop.i001.verify-review-gate');
    const gate = await f.tool('gate', ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
      '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews[0]!, '--regression', reviews[1]!,
      '--round', '1', '--out', join(gated, 'result.json')], gated);
    expect(gate.code).toBe(2);
    expect(gate.stderr).toContain(atRecord ? 'VALIDATION_TIMEOUT: slow-gate stopped after its 1s budget' : 'VALIDATION_TIMEOUT: independent re-run of slow-gate stopped after its 1s budget');
    // The evidence stays: not passed, the budget stop named, nothing for the PR author to fix.
    const result = json(join(gated, 'result.json'));
    expect(result).toMatchObject({ passed: false, validationFailures: [] });
    expect(result.reasons).toEqual([expect.stringContaining('VALIDATION_TIMEOUT: ' + (atRecord ? '' : 'independent re-run of ') + 'slow-gate')]);
    expect(json(join(gated, 'release-candidate.json')).passed).toBe(false);
  });

  it('bases a fork PR on its target repository, not on the fork\'s stale copy of the target branch', async () => {
    // A fork PR: the head lives on the fork, the target branch on the base repository.
    // The fork's own main is stale, so its merge base would widen the reviewed range.
    const setup = () => {
      const f = fixture(), origin = join(f.root, 'origin.git'), fork = join(f.root, 'fork.git');
      f.git(f.root, 'init', '-q', '--bare', origin); f.git(f.root, 'init', '-q', '--bare', fork);
      f.git(f.repo, 'remote', 'add', 'origin', origin); f.git(f.repo, 'remote', 'add', 'fork', fork);
      const staleBase = f.git(f.repo, 'rev-parse', 'HEAD');
      f.git(f.repo, 'push', '-q', 'fork', 'main');
      writeFileSync(join(f.repo, 'value.txt'), 'target moved on\n'); f.git(f.repo, 'commit', '-qam', 'target branch progress');
      const prBase = f.git(f.repo, 'rev-parse', 'HEAD');
      f.git(f.repo, 'push', '-q', 'origin', 'main');
      f.git(f.repo, 'checkout', '-qb', 'feature/fork');
      writeFileSync(join(f.repo, 'value.txt'), 'fork PR\n'); f.git(f.repo, 'commit', '-qam', 'fork PR');
      const headSha = f.git(f.repo, 'rev-parse', 'HEAD');
      f.git(f.repo, 'push', '-q', 'fork', 'feature/fork'); f.git(f.repo, 'checkout', '-q', 'main');
      f.git(f.repo, 'fetch', '-q', 'origin'); f.git(f.repo, 'fetch', '-q', 'fork');
      // Only the URLs identify the repositories; refs are already local and prepare does not fetch.
      f.git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/project.git');
      f.git(f.repo, 'remote', 'set-url', 'fork', 'git@github.com:someone/project.git');
      expect(f.git(f.repo, 'merge-base', 'refs/remotes/fork/main', headSha)).toBe(staleBase);
      write(f.params, { params: { ...json(f.params).params, mode: 'continue' } });
      const reviewTarget = { url: 'https://github.com/acme/project/pull/7', author: 'someone', remote: 'fork', sourceBranch: 'feature/fork', targetBranch: 'main', headSha };
      return { f, staleBase, prBase, headSha, reviewTarget };
    };

    const named = setup();
    write(named.f.preflight, { ...json(named.f.preflight), reviewTarget: { ...named.reviewTarget, baseRemote: 'origin' }, login: 'someone' });
    expect(await named.f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(named.f.prepared, 'context.json'))).toMatchObject({ baseSha: named.prBase, startSha: named.headSha });

    // Without baseRemote the fork would be the baseline: refuse instead of widening the range.
    const unnamed = setup();
    write(unnamed.f.preflight, { ...json(unnamed.f.preflight), reviewTarget: unnamed.reviewTarget, login: 'someone' });
    const refused = await unnamed.f.prepare();
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('PR_BASE_REMOTE_MISMATCH');
    expect(existsSync(join(unnamed.f.prepared, 'context.json'))).toBe(false);
    expect(existsSync(unnamed.f.worktree)).toBe(false);

    // A baseRemote that is itself a fork is refused the same way.
    const wrongBase = setup();
    write(wrongBase.f.preflight, { ...json(wrongBase.f.preflight), reviewTarget: { ...wrongBase.reviewTarget, baseRemote: 'fork' }, login: 'someone' });
    expect((await wrongBase.f.prepare()).stderr).toContain('PR_BASE_REMOTE_MISMATCH');

    // A same-repository PR keeps the old single-remote contract.
    const sameRepo = setup();
    write(sameRepo.f.preflight, { ...json(sameRepo.f.preflight), reviewTarget: { ...sameRepo.reviewTarget, remote: 'origin' }, login: 'someone' });
    expect(await sameRepo.f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(sameRepo.f.prepared, 'context.json')).baseSha).toBe(sameRepo.prBase);

    // A remote on another host (a mirror) is not second-guessed.
    const mirror = setup();
    mirror.f.git(mirror.f.repo, 'remote', 'set-url', 'origin', 'https://mirror.example.invalid/acme/project.git');
    write(mirror.f.preflight, { ...json(mirror.f.preflight), reviewTarget: { ...mirror.reviewTarget, baseRemote: 'origin' }, login: 'someone' });
    expect(await mirror.f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(mirror.f.prepared, 'context.json')).baseSha).toBe(mirror.prBase);
  });

  it('continues an existing PR: plans an update, pushes only the approved commit without force, and verifies the remote', async () => {
    const f = fixture(), remote = join(f.root, 'remote.git');
    f.git(f.root, 'init', '-q', '--bare', remote);
    f.git(f.repo, 'remote', 'add', 'origin', remote);
    f.git(f.repo, 'checkout', '-qb', 'feature/mine');
    writeFileSync(join(f.repo, 'value.txt'), 'my PR\n'); f.git(f.repo, 'commit', '-qam', 'my PR');
    const prHead = f.git(f.repo, 'rev-parse', 'HEAD');
    f.git(f.repo, 'push', '-q', 'origin', 'main', 'feature/mine'); f.git(f.repo, 'checkout', '-q', 'main');
    f.git(f.repo, 'fetch', '-q', 'origin');
    const reviewTarget = { url: 'https://example.invalid/pull/7', author: 'me', remote: 'origin', sourceBranch: 'feature/mine', targetBranch: 'main', headSha: prHead };
    write(f.params, { params: { ...json(f.params).params, mode: 'continue' } });
    write(f.preflight, { ...json(f.preflight), reviewTarget, login: 'me' });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json');
    writeFileSync(join(f.worktree, 'value.txt'), 'my PR, fixed\n'); f.git(f.worktree, 'commit', '-qam', 'address review');
    const implemented = f.out('development-review-loop.i001.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'Fixed value.txt\n');
    const reviews = (['correctness', 'regression'] as const).map(role => {
      const filename = join(f.root, role + '.json');
      write(filename, { ...json(candidate), role, reviewerId: BOTS[role], decision: 'approve', findings: [], coverage: ['diff'], evidence: ['ok'],
        candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
      return filename;
    });
    const gated = f.out('development-review-loop.i001.verify-review-gate'), release = join(gated, 'release-candidate.json');
    expect(await f.tool('gate', ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
      '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews[0]!, '--regression', reviews[1]!,
      '--round', '1', '--out', join(gated, 'result.json')], gated)).toMatchObject({ code: 0 });
    expect(json(release).passed).toBe(true);
    const headSha = json(candidate).headSha;

    const output = f.out('prepare-mr'), draft = join(output, 'mr-draft.json'), title = join(output, 'mr-title.txt'), body = join(output, 'mr-body.md');
    writeFileSync(title, 'Address review'); writeFileSync(body, 'Fixed value.txt; checks passed');
    write(draft, { repository: 'example/project', pushRemote: 'origin', summary: 'Fixed and checked',
      existingPr: { url: reviewTarget.url, state: 'OPEN', sourceBranch: 'feature/mine', targetBranch: 'main' } });
    const planArgs = ['--context', context, '--release', release, '--draft', draft, '--title', title, '--body', body];
    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 0, stderr: '' });
    const planPath = join(output, 'result.json');
    expect(json(planPath)).toMatchObject({ action: 'update', publicationRequired: true, approvalRequired: true, directPublish: false,
      sourceBranch: 'feature/mine', prHead, headSha, title: 'Address review' });

    const routed = f.out('check-delivery'), routeArgs = ['--context', context, '--release', release, '--plan', planPath, '--out', join(routed, 'result.json')];
    expect(await f.tool('route', routeArgs, routed)).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(routed, 'result.json'))).toMatchObject({ action: 'update', approvalRequired: true, directPublish: false });
    expect(json(join(routed, 'result.json')).approvalSummary).toContain('标题：Address review');
    const claimed = join(output, 'claimed-reuse.json');
    write(claimed, { ...json(planPath), action: 'reuse', publicationRequired: false, approvalRequired: false });
    expect(await f.tool('route', [...routeArgs.slice(0, 5), claimed, ...routeArgs.slice(6)], routed))
      .toMatchObject({ code: 2, stderr: 'delivery action does not match the live repository\n' });
    const published = f.out('create-mr'), verified = f.out('verify-publication');
    const pushArgs = ['--context', context, '--release', release, '--plan', planPath];
    const observed = join(verified, 'observed-pr.json');
    const verify = () => f.tool('verify-publication', [...pushArgs, '--route', join(routed, 'result.json'), '--observed', observed, '--out', join(verified, 'verification.json')], verified);
    write(observed, { url: reviewTarget.url, state: 'OPEN', sourceBranch: 'feature/mine', targetBranch: 'main', headSha });
    expect(await verify()).toMatchObject({ code: 2, stderr: 'remote branch does not hold the reviewed commit\n' });

    const skipped = join(output, 'skipped-approval.json'); write(skipped, { ...json(planPath), approvalRequired: false, directPublish: true });
    expect(await f.tool('push', ['--context', context, '--release', release, '--plan', skipped], published))
      .toMatchObject({ code: 2, stderr: 'delivery plan skipped a required approval\n' });
    const elsewhere = join(output, 'elsewhere.json'); write(elsewhere, { ...json(planPath), sourceBranch: 'someone-else' });
    expect(await f.tool('push', ['--context', context, '--release', release, '--plan', elsewhere], published))
      .toMatchObject({ code: 2, stderr: 'delivery plan targets another PR or branch\n' });
    const forged = join(output, 'forged.json'); write(forged, { ...json(planPath), headSha: prHead });
    expect(await f.tool('push', ['--context', context, '--release', release, '--plan', forged], published))
      .toMatchObject({ code: 2, stderr: 'delivery plan publishes a commit the reviewers did not approve\n' });
    expect(await f.tool('push', pushArgs, published)).toMatchObject({ code: 0, stderr: '' });
    expect(f.git(remote, 'rev-parse', 'refs/heads/feature/mine')).toBe(headSha);
    expect(json(join(published, 'push.json'))).toMatchObject({ remoteBefore: prHead, remoteAfter: headSha });
    expect(await f.tool('push', pushArgs, published)).toMatchObject({ code: 0, stderr: '' }); // Idempotent retry.
    write(observed, { ...json(observed), headSha: prHead });
    expect(await verify()).toMatchObject({ code: 2, stderr: 'PR does not point at the reviewed commit and branches\n' });
    write(observed, { ...json(observed), headSha });
    expect(await verify()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(verified, 'verification.json'))).toMatchObject({ verified: true, action: 'update', headSha, approvalRequired: true, directPublish: false });

    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 0, stderr: '' });
    expect(json(planPath)).toMatchObject({ action: 'reuse', publicationRequired: false });
    f.git(f.repo, 'push', '-q', '--force', 'origin', prHead + ':refs/heads/feature/mine'); // Someone else rewrote the PR.
    const other = f.git(f.repo, 'commit-tree', '-p', prHead, '-m', 'concurrent', f.git(f.repo, 'rev-parse', prHead + '^{tree}'));
    f.git(f.repo, 'push', '-q', 'origin', other + ':refs/heads/feature/mine');
    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 2, stderr: 'remote PR head changed since it was fetched\n' });
  });

  it('creates a new PR branch from local development and refuses to attach another PR', async () => {
    const f = await evidenceFixture(), remote = join(f.root, 'remote.git');
    f.git(f.root, 'init', '-q', '--bare', remote); f.git(f.repo, 'remote', 'add', 'origin', remote);
    expect(await f.gate()).toMatchObject({ code: 0 });
    const release = join(f.gated, 'release-candidate.json'), headSha = json(f.candidate).headSha;
    const output = f.out('prepare-mr'), draft = join(output, 'mr-draft.json'), title = join(output, 'mr-title.txt'), body = join(output, 'mr-body.md');
    writeFileSync(title, 'Fixture change'); writeFileSync(body, 'Behavior and actual checks');
    const planArgs = ['--context', f.context, '--release', release, '--draft', draft, '--title', title, '--body', body];
    write(draft, { repository: 'example/project', pushRemote: 'origin', summary: 'New development',
      existingPr: { url: 'https://example.invalid/pull/9', state: 'OPEN', sourceBranch: 'other', targetBranch: 'main' } });
    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 2, stderr: 'new development must not attach another PR\n' });
    write(draft, { repository: 'example/project', pushRemote: 'origin', summary: 'New development' });
    writeFileSync(join(f.repo, 'later.txt'), 'local main moved\n'); f.git(f.repo, 'add', 'later.txt'); f.git(f.repo, 'commit', '-qm', 'local main moved');
    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 0, stderr: '' });
    const planPath = join(output, 'result.json');
    expect(json(planPath)).toMatchObject({ action: 'create', approvalRequired: true, sourceBranch: f.ctx.branch, targetBranch: 'main', prHead: null });
    expect(json(planPath).approvalSummary).toContain('注意：本地 main 已从基线');
    const published = f.out('create-mr');
    expect(await f.tool('push', ['--context', f.context, '--release', release, '--plan', planPath], published)).toMatchObject({ code: 0, stderr: '' });
    expect(f.git(remote, 'rev-parse', 'refs/heads/' + f.ctx.branch)).toBe(headSha);
    expect(await f.tool('delivery', planArgs, output)).toMatchObject({ code: 2, stderr: 'remote task branch already exists\n' });
    writeFileSync(join(f.worktree, 'value.txt'), 'unreviewed edit');
    expect((await f.tool('push', ['--context', f.context, '--release', release, '--plan', planPath], published)).code).toBe(2);
  });
  it('re-runs every check in the independent gate and rejects a forged passing validation record', async () => {
    const f = fixture();
    write(f.params, { params: { ...json(f.params).params, validation_commands: [{ id: 'failing', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutSec: 10 }] } });
    expect(await f.prepare()).toMatchObject({ code: 0 });
    const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json');
    writeFileSync(join(f.worktree, 'value.txt'), 'after\n'); f.git(f.worktree, 'commit', '-qam', 'candidate');
    const implemented = f.out('development-review-loop.i001.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    write(validation, { ...json(validation), checks: json(validation).checks.map((check: any) => ({ ...check, exitCode: 0 })) });
    const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'All checks passed.\n');
    const reviews = (['correctness', 'regression'] as const).map(role => {
      const filename = join(f.root, role + '.json');
      write(filename, { ...json(candidate), role, reviewerId: BOTS[role], decision: 'approve', findings: [], coverage: ['diff'], evidence: ['validation.json reports success'],
        candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
      return filename;
    });
    const gated = f.out('development-review-loop.i001.verify-review-gate'), result = join(gated, 'result.json');
    expect(await f.tool('gate', ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
      '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews[0]!, '--regression', reviews[1]!,
      '--round', '1', '--out', result], gated)).toMatchObject({ code: 0 });
    expect(json(result)).toMatchObject({ passed: false, reasons: ['validation record contradicts the independent re-run: failing'] });
    expect(json(join(gated, 'independent-validation.json')).checks[0]).toMatchObject({ id: 'failing', exitCode: 3 });
  });
  it('discovers required checks from preflight only when the launch plan is empty', async () => {
    const f = fixture(), input = json(f.params), checked = json(f.preflight);
    const expected = input.params.validation_commands;
    input.params.validation_commands = []; checked.validationCommands = expected;
    write(f.params, input); write(f.preflight, checked);
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(f.prepared, 'context.json')).validationCommands).toEqual(expected);

    const explicit = fixture(), supplied = json(explicit.params).params.validation_commands;
    write(explicit.preflight, { ...json(explicit.preflight), validationCommands: [{ id: 'different', argv: ['ignored'] }] });
    expect(await explicit.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(explicit.prepared, 'context.json')).validationCommands).toEqual(supplied);
  });
  it('refuses missing automatic checks before creating the task worktree', async () => {
    const f = fixture(), input = json(f.params); input.params.validation_commands = []; write(f.params, input);
    expect((await f.prepare()).code).not.toBe(0); expect(existsSync(f.worktree)).toBe(false);
  });
  it('requires document content and a matching read source before preparing a URL-only requirement', async () => {
    const f = fixture(), input = json(f.params), url = 'https://example.invalid/docx/requirement';
    input.params.requirement = url; write(f.params, input);
    expect((await f.prepare()).code).not.toBe(0); expect(existsSync(f.worktree)).toBe(false);
    const checked = { ...json(f.preflight), resolvedRequirement: 'Actual document requirements',
      requirementSources: [{ url: 'https://example.invalid/docx/other', read: true }] };
    write(f.preflight, checked); expect((await f.prepare()).code).not.toBe(0);
    checked.requirementSources = [{ url, read: true }]; write(f.preflight, checked);
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    expect(json(join(f.prepared, 'context.json')).requirement).toBe('Actual document requirements');
  });
  it('checkpoints real review progress without declaring completion or approval', async () => {
    const f = fixture(), out = f.out('review-regression');
    const inputHash = 'sha256:' + 'a'.repeat(64);
    write(join(dirname(out), 'checkpoint-context.json'), { schemaVersion: 1, inputHash });
    const progress = join(out, 'review-progress.md');
    writeFileSync(progress, 'Verified API behavior; browser probe still pending.');
    const args = ['--summary', 'API checked; browser pending', '--entry', 'progress', 'markdown', 'review-progress.md'];
    expect(await f.tool('checkpoint', args, out)).toMatchObject({ code: 0, stderr: '' });
    const manifest = await readAndValidateManifest(join(out, 'checkpoint.json'), out);
    expect(manifest).toMatchObject({ status: 'fail', error: { code: 'CHECKPOINT_INCOMPLETE', retryable: true } });
    expect(json(join(out, 'checkpoint.json')).inputHash).toBe(inputHash);
    expect(existsSync(join(dirname(out), 'manifest.json'))).toBe(false);
    writeFileSync(progress, 'API and browser checked; remaining backup probe.');
    expect(await f.tool('checkpoint', args, out)).toMatchObject({ code: 0 });
    expect((await readAndValidateManifest(join(out, 'checkpoint.json'), out)).files[0]!.sha256)
      .toBe(sha(progress).slice('sha256:'.length));
    write(join(dirname(out), 'checkpoint-context.json'), { schemaVersion: 1 });
    expect(await f.tool('checkpoint', args, out)).toMatchObject({ code: 2 });
  });

  it('prepares a real task worktree, records real argv execution, gates evidence, and publishes a valid manifest', async () => {
    const f = await evidenceFixture();
    expect(sha(f.resources)).toBe(DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256);
    expect(json(f.validation).checks[0]).toMatchObject({ exitCode: 0, headBefore: json(f.candidate).headSha, headAfter: json(f.candidate).headSha });
    expect(await f.gate()).toMatchObject({ code: 0, stderr: '' });
    expect(json(f.result).passed).toBe(true);
    expect(json(join(f.gated, 'release-candidate.json'))).toMatchObject({ passed: true, artifacts: { candidate: { sha256: sha(f.candidate) } } });
    expect(readFileSync(join(f.gated, 'feedback.md'), 'utf8')).not.toContain('private-review-evidence-canary');
    expect(await f.tool('publish', ['--entry', 'gate-result', 'json', 'result.json', '--entry', 'release-candidate', 'json', 'release-candidate.json',
      '--entry', 'feedback', 'markdown', 'feedback.md'], f.gated)).toMatchObject({ code: 0, stderr: '' });
    const manifest = await readAndValidateManifest(join(dirname(f.gated), 'manifest.json'), f.gated);
    expect(manifest.files).toHaveLength(3);
    expect(manifest.status).toBe('ok');
  });

  it('does not create a task worktree before authentication and command-plan validation', async () => {
    const f = fixture(); write(f.preflight, { ...json(f.preflight), state: 'WAITING_AUTH', repositoryAccess: false });
    expect(await f.prepare()).toMatchObject({ code: 2 }); expect(existsSync(f.worktree)).toBe(false);
    write(f.preflight, { ...json(f.preflight), state: 'READY', repositoryAccess: true });
    write(f.params, { params: { ...json(f.params).params, validation_commands: ['node --version'] } });
    expect(await f.prepare()).toMatchObject({ code: 2 }); expect(existsSync(f.worktree)).toBe(false);
  });

  it('rejects stale identities, SHA/round, missing checks, failed commands, tampered logs and false approvals', async () => {
    const f = await evidenceFixture();
    const originals = new Map([f.candidate, f.validation, f.correctness, f.regression].map(filename => [filename, readFileSync(filename, 'utf8')]));
    const cases: Array<[string, string, (value: any) => void]> = [
      ['candidate repo', f.candidate, value => { value.repo = 'another repository'; }],
      ['candidate round', f.candidate, value => { value.round = 2; }],
      ['candidate schema', f.candidate, value => { value.schemaVersion = 2; }],
      ['validation head', f.validation, value => { value.headSha = value.baseSha; }],
      ['missing command', f.validation, value => { value.checks = []; }],
      ['validation schema', f.validation, value => { delete value.schemaVersion; }],
      ['command provenance', f.validation, value => { value.checks[0].argv = ['a different command']; }],
      ['failed command', f.validation, value => { value.checks[0].exitCode = 1; }],
      ['wrong log hash', f.validation, value => { value.checks[0].log.sha256 = 'sha256:' + '0'.repeat(64); }],
      ['duplicate reviewer', f.correctness, value => { value.reviewerId = BOTS.regression; }],
      ['stale review SHA', f.regression, value => { value.headSha = value.baseSha; }],
      ['review schema', f.regression, value => { value.schemaVersion = 2; }],
      ['reviewed different bytes', f.regression, value => { value.candidateSha256 = 'sha256:' + '0'.repeat(64); }],
      ['changes requested', f.regression, value => { value.decision = 'changes_requested'; }],
      ['blocking finding', f.correctness, value => { value.findings = [{ blocking: true }]; }],
      ['empty coverage', f.correctness, value => { value.coverage = ['']; }],
      ['non-string evidence', f.correctness, value => { value.evidence = [{ invented: true }]; }],
    ];
    for (const [name, filename, mutate] of cases) {
      for (const [originalPath, content] of originals) writeFileSync(originalPath, content);
      const value = json(filename); mutate(value); write(filename, value);
      // Keep the reviewers' byte receipt current so each malformed validation
      // fails its own invariant, rather than merely a stale enclosing digest.
      if (filename === f.validation) {
        for (const review of [f.correctness, f.regression]) write(review, { ...json(review), validationSha256: sha(f.validation) });
      }
      expect(await f.gate(), name).toMatchObject({ code: 0 });
      expect(json(f.result).passed, name).toBe(false);
    }
    for (const [filename, content] of originals) writeFileSync(filename, content);
    writeFileSync(join(f.worktree, 'value.txt'), 'dirty\n');
    expect(await f.gate()).toMatchObject({ code: 0 }); expect(json(f.result).reasons.join(' ')).toMatch(/dirty worktree/);
    f.git(f.worktree, 'add', 'value.txt'); f.git(f.worktree, 'commit', '-qm', 'fixture later head');
    expect(await f.gate()).toMatchObject({ code: 0 }); expect(json(f.result).reasons.join(' ')).toMatch(/live HEAD changed/);
  });

  it('supports SHA-256 repositories and refuses a swapped repository before recording new validation', async () => {
    const f = await evidenceFixture('sha256');
    expect(json(f.candidate).headSha).toHaveLength(64);
    expect(await f.gate()).toMatchObject({ code: 0 }); expect(json(f.result).passed).toBe(true);
    const unrelated = fixture();
    const previousValidation = sha(f.validation), previousCandidate = sha(f.candidate);
    write(f.context, { ...json(f.context), worktree: unrelated.repo });
    expect(await f.tool('candidate', ['--context', f.context, '--round', '1'], dirname(f.candidate)))
      .toMatchObject({ code: 2, stderr: 'repository/worktree common-dir mismatch\n' });
    expect(sha(f.candidate)).toBe(previousCandidate);
    expect(await f.tool('record', ['--context', f.context, '--candidate', f.candidate, '--round', '1'], dirname(f.candidate)))
      .toMatchObject({ code: 2, stderr: 'repository/worktree common-dir mismatch\n' });
    expect(sha(f.validation)).toBe(previousValidation);
    expect(await f.gate()).toMatchObject({ code: 0 }); expect(json(f.result).reasons.join(' ')).toMatch(/common-dir mismatch/);
  });

  it('accepts canonical Git path aliases when resuming pristine preparation and recording evidence', async () => {
    const f = fixture(); expect(await f.prepare()).toMatchObject({ code: 0 });
    const aliasRepo = join(f.root, 'repo-alias'), aliasWorktree = join(f.root, 'worktree-alias');
    symlinkSync(f.repo, aliasRepo, 'dir'); symlinkSync(f.worktree, aliasWorktree, 'dir');
    write(f.params, { params: { ...json(f.params).params, repo_path: aliasRepo } });
    write(f.preflight, { ...json(f.preflight), worktreePath: aliasWorktree });
    expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
    const context = join(f.prepared, 'context.json'); write(context, { ...json(context), repo: aliasRepo });
    const out = f.out('development-review-loop.i001.implement');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], out)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', join(out, 'candidate.json'), '--round', '1'], out))
      .toMatchObject({ code: 0, stderr: '' });
  });

  it('binds candidate, record and gate to the actual loop round, including granted later rounds', async () => {
    const f = await evidenceFixture();
    const implemented = f.out('development-review-loop.i002.implement');
    expect(await f.tool('candidate', ['--context', f.context, '--round', '1'], implemented))
      .toMatchObject({ code: 2, stderr: 'invalid current round\n' });
    expect(existsSync(join(implemented, 'candidate.json'))).toBe(false);
    expect(await f.tool('record', ['--context', f.context, '--candidate', f.candidate, '--round', '1'], implemented))
      .toMatchObject({ code: 2, stderr: 'wrong current round\n' });
    expect(existsSync(join(implemented, 'validation.json'))).toBe(false);
    const gated = f.out('development-review-loop.i002.verify-review-gate'), result = join(gated, 'result.json');
    const args = f.gateArgs.slice(); args[args.indexOf('--out') + 1] = result;
    expect(await f.tool('gate', args, gated)).toMatchObject({ code: 0 });
    expect(json(result)).toMatchObject({ passed: false, reasons: ['wrong current round'] });
    const granted = await evidenceFixture('sha1', 4);
    expect(json(granted.candidate).round).toBe(4);
    expect(await granted.gate()).toMatchObject({ code: 0 }); expect(json(granted.result).passed).toBe(true);
  });

  it('keeps command arguments literal instead of evaluating shell punctuation', async () => {
    const f = fixture();
    const marker = join(f.root, 'shell-was-evaluated');
    const literal = 'literal; touch ' + marker;
    write(f.params, { params: { ...json(f.params).params, validation_commands: [{ id: 'literal',
      argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal], timeoutSec: 10 }] } });
    expect(await f.prepare()).toMatchObject({ code: 0 });
    const context = join(f.prepared, 'context.json'), out = f.out('development-review-loop.i001.implement');
    expect(await f.tool('candidate', ['--context', context, '--round', '1'], out)).toMatchObject({ code: 0 });
    expect(await f.tool('record', ['--context', context, '--candidate', join(out, 'candidate.json'), '--round', '1'], out)).toMatchObject({ code: 0 });
    expect(json(join(out, 'validation.json')).checks[0].exitCode).toBe(0);
    expect(readFileSync(join(out, 'literal.log'), 'utf8')).toBe(literal);
    expect(existsSync(marker)).toBe(false);
  });

  it('records failed execution honestly and rejects altered tools, duplicate/escaped products and symlinks', async () => {
    const f = await evidenceFixture();
    write(f.context, { ...json(f.context), validationCommands: [{ id: 'failure', argv: [process.execPath, '-e', 'process.exit(7)'], timeoutSec: 10 }] });
    write(f.candidate, { ...json(f.candidate), contextSha256: sha(f.context) });
    const implemented = dirname(f.candidate);
    expect(await f.tool('record', ['--context', f.context, '--candidate', f.candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
    expect(json(f.validation).checks[0].exitCode).toBe(7);
    const out = f.out('publisher'); write(join(out, 'actual.json'), { actual: true });
    for (const args of [
      ['--entry', 'duplicate', 'json', 'actual.json', '--entry', 'duplicate', 'json', 'actual.json'],
      ['--entry', 'escaped', 'json', '../actual.json'],
    ]) expect(await f.tool('publish', args, out)).toMatchObject({ code: 2 });
    symlinkSync(join(out, 'actual.json'), join(out, 'link.json'));
    expect(await f.tool('publish', ['--entry', 'linked', 'json', 'link.json'], out)).toMatchObject({ code: 2 });
    writeFileSync(f.script, readFileSync(f.script, 'utf8') + '\n// changed bytes\n');
    expect(await f.tool('publish', ['--entry', 'actual', 'json', 'actual.json'], out)).toMatchObject({ code: 2, stderr: 'fixed tools hash mismatch\n' });
  });
});
