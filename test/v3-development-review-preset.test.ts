import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review.js';
import { DEVELOPMENT_REVIEW_RESOURCES, DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 } from '../src/workflows/v3/presets/development-review-resources.js';
import { collectSavedWorkflowReusableTextWarnings } from '../src/workflows/v3/library-materialize.js';
import { validateSavedWorkflowRevisionPayload } from '../src/workflows/v3/library-schema.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const BOTS = { developer: 'cli_developer', correctness: 'cli_correctness', regression: 'cli_regression' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function fixture(objectFormat = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-review-preset-'))); roots.push(root);
  const repo = join(root, 'repo'), runId = 'fixture-run', run = join(root, runId);
  mkdirSync(repo); mkdirSync(run);
  writeFileSync(join(root, 'gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main', '--object-format=' + objectFormat);
  writeFileSync(join(repo, 'value.txt'), 'before\n'); git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'fixture base');
  write(join(run, 'run.json'), { runId }); // Local script fixture; no success journal or real Workflow is created.
  const out = (node: string) => {
    const output = join(run, node, 'attempts', '001', 'work'); mkdirSync(output, { recursive: true }); return output;
  };
  const prepared = out('prepare'), script = join(prepared, 'tools.mjs'), worktree = join(root, 'task-worktree');
  writeFileSync(script, DEVELOPMENT_REVIEW_RESOURCES[0]!.content);
  const params = join(root, 'params.json'), preflight = join(root, 'preflight.json'), roles = join(root, 'roles.json');
  write(params, { params: { repo_path: repo, requirement: 'Implement the requested behavior', target_branch: 'main',
    validation_commands: [{ id: 'behavior', argv: [process.execPath, '-e', 'process.stdout.write("verified")'], timeoutSec: 10 }] } });
  write(preflight, { schemaVersion: 1, state: 'READY', repositoryAccess: true, identity: 'fixture-user', runId,
    repoPath: repo, targetBranch: 'main', worktreePath: worktree, worktreeAllowed: true, branch: 'workflow/' + runId });
  write(roles, Object.fromEntries(Object.entries(BOTS).map(([role, bot]) => [role, { bot, label: role, cliId: 'codex' }])));
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

async function evidenceFixture(objectFormat = 'sha1', round = 1) {
  const f = fixture(objectFormat);
  expect(await f.prepare()).toMatchObject({ code: 0, stderr: '' });
  const context = join(f.prepared, 'context.json'), resources = join(f.prepared, 'resources.json'), ctx = json(context);
  writeFileSync(join(f.worktree, 'value.txt'), 'after\n'); f.git(f.worktree, 'add', 'value.txt'); f.git(f.worktree, 'commit', '-qm', 'fixture candidate');
  const implemented = f.out('development-review-loop.i' + String(round).padStart(3, '0') + '.implement'), candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
  expect(await f.tool('candidate', ['--context', context, '--round', String(round)], implemented)).toMatchObject({ code: 0, stderr: '' });
  expect(await f.tool('record', ['--context', context, '--candidate', candidate, '--round', String(round)], implemented)).toMatchObject({ code: 0, stderr: '' });
  const correctness = join(f.root, 'correctness.json'), regression = join(f.root, 'regression.json');
  for (const [role, filename] of [['correctness', correctness], ['regression', regression]]) {
    write(filename!, { ...json(candidate), role, reviewerId: BOTS[role as keyof typeof BOTS], decision: 'approve', findings: [],
      coverage: ['private-review-evidence-canary'], evidence: ['Examined the actual candidate'],
      candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
  }
  const gated = f.out('development-review-loop.i' + String(round).padStart(3, '0') + '.verify-review-gate'), result = join(gated, 'result.json');
  const gateArgs = ['--context', context, '--resources', resources, '--expected-resources-sha', DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256,
    '--candidate', candidate, '--validation', validation, '--correctness', correctness, '--regression', regression, '--round', String(round), '--out', result];
  return { ...f, context, resources, ctx, candidate, validation, correctness, regression, gated, result, gateArgs,
    gate: () => f.tool('gate', gateArgs, gated) };
}

describe('authored development-review preset', () => {
  it('is a source-free, lint-clean and schema-valid executable definition with explicit dependencies', () => {
    const draft = createDevelopmentReviewPreset(BOTS), warnings: string[] = [];
    collectSavedWorkflowReusableTextWarnings(draft, 'draft', warnings);
    expect(warnings).toEqual([]);
    expect(draft.sourceRunId).toBeUndefined();
    expect(Object.keys(draft.inputs).sort()).toEqual(['repo_path', 'requirement', 'target_branch', 'validation_commands'].sort());
    for (const input of Object.values(draft.inputs)) { expect(input.required).toBe(true); expect(input.default).toBeUndefined(); }
    expect(validateSavedWorkflowRevisionPayload({ ...draft, workflowId: 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', humanVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', createdBy: { openId: 'fixture-owner', larkAppId: 'cli_developer' } }).roles).toEqual(draft.roles);
    const loop = draft.dagTemplate.nodes.find(node => node.type === 'loop')!;
    expect(loop).toMatchObject({ maxIterations: 3, sessionPolicy: 'fresh', depends: [{ from: 'prepare' }],
      exit: { node: 'verify-review-gate', when: { path: 'result.passed', equals: true } }, feedback: ['verify-review-gate.result'] });
    for (const id of ['review-correctness', 'review-regression']) {
      const reviewer = loop.body!.nodes.find(node => node.id === id)!;
      expect(reviewer.depends).toEqual([{ from: 'implement' }]);
      expect(reviewer.inputs.every(input => input.from === 'implement')).toBe(true);
    }
    expect(draft.dagTemplate.nodes.find(node => node.id === 'create-mr')!.humanGate).toMatchObject({ approveOptions: ['approve'] });
  });

  it('refuses unresolved or non-independent default identities', () => {
    expect(() => createDevelopmentReviewPreset({ ...BOTS, developer: 'A display name' })).toThrow(/resolved bot app/);
    expect(() => createDevelopmentReviewPreset({ ...BOTS, regression: BOTS.correctness })).toThrow(/distinct/);
  });
});

describe('fixed development-review executable resources', () => {
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
