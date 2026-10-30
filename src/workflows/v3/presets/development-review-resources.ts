import { createHash } from 'node:crypto';

/** Embedded bytes are the executable resource: no checkout-relative file reads. */
export const DEVELOPMENT_REVIEW_TOOLS_SOURCE = String.raw`import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const sha = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const digest = filename => sha(fs.readFileSync(filename));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const version = (value, label) => requireThat(object(value) && value.schemaVersion === 1, label + ' schemaVersion must be 1');
function atomic(filename, value) {
  const temporary = filename + '.tmp-' + process.pid;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
}
function regular(root, relative) {
  requireThat(typeof relative === 'string' && relative.length && !path.isAbsolute(relative), 'relative file required');
  const parts = relative.split(/[\\/]/);
  requireThat(parts.every(part => part && part !== '.' && part !== '..'), 'unsafe relative file');
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    requireThat(!fs.lstatSync(current).isSymbolicLink(), 'symlink evidence rejected');
  }
  requireThat(fs.statSync(current).isFile(), 'regular file required');
  return current;
}
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv });
  requireThat(!result.error && result.status === 0, 'git command failed: ' + args[0]);
  return result.stdout.trim();
}
const MODES = ['new', 'review', 'continue'];
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The live remote branch head, or null when the branch does not exist.
function remoteHead(repo, remote, branch) {
  requireThat(typeof remote === 'string' && REMOTE.test(remote), 'configured remote name required');
  git(repo, ['remote', 'get-url', remote]);
  const result = spawnSync('git', ['-C', repo, 'ls-remote', '--exit-code', remote, 'refs/heads/' + branch], { encoding: 'utf8', env: gitEnv });
  if (!result.error && result.status === 2) return null;
  requireThat(!result.error && result.status === 0, 'git command failed: ls-remote');
  const head = result.stdout.trim().split(/\s+/)[0];
  requireThat(COMMIT.test(head), 'unexpected remote branch head');
  return head;
}
function cleanHead(context, expected, label) {
  requireThat(git(context.worktree, ['rev-parse', 'HEAD']) === expected && !git(context.worktree, ['status', '--porcelain']) &&
    git(context.worktree, ['branch', '--show-current']) === context.branch, label + ' is no longer the clean task HEAD');
}
function ownOutput(out, name) {
  requireThat(process.env.BOTMUX_GOAL_OUTPUT_DIR && path.resolve(out) === path.join(path.resolve(process.env.BOTMUX_GOAL_OUTPUT_DIR), name), name + ' must use this goal output');
}
// A delivery plan is valid only for the passed gate, context and fixed tools it was derived from.
function boundPlan(args) {
  const deliveryPlan = read(args.plan), context = read(args.context), release = read(args.release);
  version(deliveryPlan, 'delivery plan'); version(context, 'context'); version(release, 'release');
  requireThat(context.runId === runtimeRunId() && deliveryPlan.runId === context.runId, 'delivery plan wrong run');
  commonRepository(context);
  requireThat(release.passed === true && release.gate.passed === true && release.toolsSha256 === digest(self) &&
    deliveryPlan.releaseSha256 === digest(args.release) && deliveryPlan.contextSha256 === digest(args.context), 'delivery plan is not bound to the passed gate');
  requireThat(deliveryPlan.headSha === release.gate.headSha && deliveryPlan.baseSha === context.baseSha && deliveryPlan.mode === context.mode,
    'delivery plan publishes a commit the reviewers did not approve');
  requireThat(deliveryPlan.publicationRequired === true, 'delivery plan has no publication');
  return { deliveryPlan, context, release };
}
function runtimeRunId() {
  const attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
  requireThat(attempt, 'goal attempt directory unavailable');
  const envelope = read(path.join(path.dirname(path.dirname(path.dirname(attempt))), 'run.json'));
  requireThat(typeof envelope.runId === 'string' && envelope.runId, 'run identity unavailable');
  return envelope.runId;
}
function runtimeRound() {
  const attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
  requireThat(attempt, 'goal attempt directory unavailable');
  const node = path.basename(path.dirname(path.dirname(attempt)));
  const match = /^development-review-loop\.i([0-9]+)\.[A-Za-z0-9_-]+$/.exec(node);
  const round = match && Number(match[1]);
  requireThat(Number.isSafeInteger(round) && round > 0, 'current loop round unavailable');
  return round;
}
function plan(commands) {
  requireThat(Array.isArray(commands) && commands.length > 0 && commands.length <= 32, 'validation_commands must be a nonempty array');
  const seen = new Set();
  return commands.map(item => {
    requireThat(object(item) && typeof item.id === 'string' && /^[A-Za-z0-9._-]+$/.test(item.id) && !seen.has(item.id), 'invalid/duplicate validation id');
    seen.add(item.id);
    requireThat(Array.isArray(item.argv) && item.argv.length > 0 && item.argv.every(arg => typeof arg === 'string' && arg.length && !arg.includes('\0')), 'validation argv required; shell strings rejected');
    const timeoutSec = item.timeoutSec === undefined ? 1800 : item.timeoutSec;
    requireThat(Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= 14400, 'invalid validation timeout');
    return { id: item.id, argv: item.argv, timeoutSec };
  });
}
function roles(value) {
  const names = ['developer', 'correctness', 'regression'];
  requireThat(object(value) && Object.keys(value).sort().join(',') === names.slice().sort().join(','), 'three role bindings required');
  const selected = names.map(name => {
    const role = value[name];
    requireThat(object(role) && /^cli_[A-Za-z0-9_-]+$/.test(role.bot) && typeof role.cliId === 'string' && role.cliId && typeof role.label === 'string' && role.label, 'invalid role identity: ' + name);
    return role.bot;
  });
  requireThat(new Set(selected).size === selected.length, 'development and independent reviewers require distinct bot identities');
}
function same(subject, expected, fields, label) {
  for (const field of fields) requireThat(subject[field] === expected[field], label + ' mismatch: ' + field);
}
function commonRepository(context) {
  const repository = fs.realpathSync(context.repo), worktree = fs.realpathSync(context.worktree);
  requireThat(fs.realpathSync(git(repository, ['rev-parse', '--show-toplevel'])) === repository, 'context repository root changed');
  requireThat(fs.realpathSync(git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ===
    fs.realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])), 'repository/worktree common-dir mismatch');
}
function resource(context, filename, expected) {
  requireThat(digest(filename) === expected && expected === context.resourcesSha256, 'resource manifest hash mismatch');
  const manifest = read(filename);
  requireThat(manifest.preset === 'development-review' && manifest.version === 1 && manifest.files.length === 1, 'unsupported resources');
  const item = manifest.files[0];
  requireThat(item.path === 'tools.mjs' && digest(regular(path.dirname(filename), item.path)) === item.sha256, 'resource bytes changed');
  requireThat(item.sha256 === digest(self), 'wrong fixed tools resource');
}
function prepare(args) {
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  requireThat(output && fs.realpathSync(path.dirname(self)) === fs.realpathSync(output), 'prepare tools must be in its goal output');
  const checked = read(args.preflight), params = read(args.params).params, selected = read(args.roles);
  version(checked, 'preflight');
  requireThat(checked.state === 'READY' && checked.repositoryAccess === true && typeof checked.identity === 'string' && checked.identity, 'authentication/access preflight is not READY');
  requireThat(checked.runId === runtimeRunId(), 'preflight wrong run');
  requireThat(object(params) && typeof params.requirement === 'string' && params.requirement.trim(), 'requirement required');
  const mode = params.mode;
  requireThat(MODES.includes(mode), 'mode must be new, review or continue');
  const repository = fs.realpathSync(params.repo_path);
  requireThat(fs.realpathSync(git(repository, ['rev-parse', '--show-toplevel'])) === repository, 'repo_path must be the repository root');
  requireThat(checked.repoPath === repository, 'preflight target mismatch');
  const reviewTarget = checked.reviewTarget;
  let targetBranch, baseSha, startSha;
  if (mode === 'new') {
    requireThat(reviewTarget === undefined, 'new development must not carry a PR target');
    requireThat(typeof params.target_branch === 'string' && !params.target_branch.startsWith('-') && checked.targetBranch === params.target_branch, 'preflight target mismatch');
    git(repository, ['check-ref-format', '--branch', params.target_branch]);
    targetBranch = params.target_branch;
    // New development starts from the local branch as it is now; no implicit fetch.
    baseSha = git(repository, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/' + targetBranch + '^{commit}']);
    startSha = baseSha;
  } else {
    requireThat(object(reviewTarget) && typeof reviewTarget.url === 'string' && /^https:\/\//.test(reviewTarget.url) &&
      typeof reviewTarget.author === 'string' && reviewTarget.author.trim() && typeof reviewTarget.remote === 'string' && REMOTE.test(reviewTarget.remote) &&
      typeof reviewTarget.sourceBranch === 'string' && typeof reviewTarget.targetBranch === 'string' && COMMIT.test(reviewTarget.headSha),
      'review target must identify the fetched PR, its author, remote, branches and head');
    git(repository, ['check-ref-format', '--branch', reviewTarget.sourceBranch]);
    git(repository, ['check-ref-format', '--branch', reviewTarget.targetBranch]);
    requireThat(checked.targetBranch === reviewTarget.targetBranch, 'preflight target mismatch');
    git(repository, ['remote', 'get-url', reviewTarget.remote]);
    targetBranch = reviewTarget.targetBranch;
    // Preflight fetched both refs; from here on the local objects are the baseline.
    const targetTip = git(repository, ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/' + reviewTarget.remote + '/' + targetBranch + '^{commit}']);
    startSha = git(repository, ['rev-parse', '--verify', '--end-of-options', reviewTarget.headSha + '^{commit}']);
    requireThat(startSha === reviewTarget.headSha, 'review target head is not a full commit id');
    // A PR may lag its target branch: review and develop against the merge base.
    baseSha = git(repository, ['merge-base', targetTip, startSha]);
  }
  const login = typeof checked.login === 'string' && checked.login.trim() ? checked.login.trim() : null;
  requireThat(mode !== 'review' || login, 'review mode requires the verified CLI login');
  roles(selected);
  // An empty launch-form plan delegates discovery to the authenticated preflight.
  // Explicit caller-supplied checks remain authoritative and cannot be replaced.
  const commands = plan(Array.isArray(params.validation_commands) && params.validation_commands.length === 0
    ? checked.validationCommands : params.validation_commands);
  const requirement = checked.resolvedRequirement === undefined ? params.requirement : checked.resolvedRequirement;
  requireThat(typeof requirement === 'string' && requirement.trim(), 'resolved requirement required');
  if (/^https?:\/\/\S+$/i.test(params.requirement.trim()) && mode === 'new') {
    requireThat(typeof checked.resolvedRequirement === 'string' && checked.resolvedRequirement.trim() &&
      Array.isArray(checked.requirementSources) && checked.requirementSources.length > 0 &&
      checked.requirementSources.every(source => object(source) && source.url === params.requirement.trim() && source.read === true),
      'document requirement must be read before preparation');
  }
  requireThat(typeof checked.worktreePath === 'string' && path.isAbsolute(checked.worktreePath) && checked.worktreeAllowed === true, 'preflight must approve a task-owned worktree location');
  const branch = checked.branch;
  requireThat(typeof branch === 'string' && branch.includes(checked.runId), 'task branch must identify this run');
  git(repository, ['check-ref-format', '--branch', branch]);
  const worktree = path.resolve(checked.worktreePath);
  requireThat(worktree !== repository && !worktree.startsWith(path.join(repository, '.git') + path.sep), 'unsafe worktree location');
  if (!fs.existsSync(worktree)) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(repository, ['worktree', 'add', '-b', branch, worktree, startSha]);
  } else {
    requireThat(fs.realpathSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === fs.realpathSync(git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])), 'existing worktree belongs to another repository');
    requireThat(git(worktree, ['branch', '--show-current']) === branch && git(worktree, ['rev-parse', 'HEAD']) === startSha && !git(worktree, ['status', '--porcelain']), 'existing worktree is not this pristine preparation');
  }
  const manifest = { preset: 'development-review', version: 1, files: [{ path: 'tools.mjs', sha256: digest(self) }] };
  atomic(path.join(output, 'resources.json'), manifest);
  const context = { schemaVersion: 1, runId: checked.runId, mode, repo: repository, worktree, branch, targetBranch,
    baseSha, startSha, ...(reviewTarget ? { reviewTarget } : {}), login, requirement, requirementSha256: sha(Buffer.from(requirement)), roles: selected,
    validationCommands: commands, preflightSha256: digest(args.preflight), resourcesSha256: digest(path.join(output, 'resources.json')) };
  atomic(path.join(output, 'context.json'), context);
  atomic(path.join(output, 'result.json'), { ready: true, runId: checked.runId, mode, baseSha, startSha });
}
function candidate(args) {
  const context = read(args.context), output = process.env.BOTMUX_GOAL_OUTPUT_DIR, round = Number(args.round);
  version(context, 'context');
  requireThat(context.runId === runtimeRunId() && output, 'candidate run/output unavailable');
  commonRepository(context);
  requireThat(Number.isSafeInteger(round) && round === runtimeRound(), 'invalid current round');
  requireThat(!git(context.worktree, ['status', '--porcelain']) && git(context.worktree, ['branch', '--show-current']) === context.branch, 'candidate must use the clean task branch');
  const headSha = git(context.worktree, ['rev-parse', 'HEAD']);
  git(context.worktree, ['merge-base', '--is-ancestor', context.baseSha, headSha]);
  requireThat(context.mode !== 'review' || headSha === context.startSha, 'review mode must not change the PR head');
  atomic(path.join(output, 'candidate.json'), { schemaVersion: 1, runId: context.runId, repo: context.repo, baseSha: context.baseSha,
    headSha, round, contextSha256: digest(args.context), resourcesSha256: context.resourcesSha256 });
}
function record(args) {
  const context = read(args.context), candidate = read(args.candidate), output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  version(context, 'context'); version(candidate, 'candidate'); commonRepository(context);
  requireThat(context.runId === runtimeRunId(), 'context wrong run');
  same(candidate, context, ['runId', 'repo', 'baseSha'], 'candidate');
  requireThat(Number.isSafeInteger(candidate.round) && Number(args.round) === candidate.round && candidate.round === runtimeRound(), 'wrong current round');
  requireThat(candidate.contextSha256 === digest(args.context) && candidate.resourcesSha256 === context.resourcesSha256, 'candidate context/resource mismatch');
  requireThat(git(context.worktree, ['rev-parse', 'HEAD']) === candidate.headSha && !git(context.worktree, ['status', '--porcelain']), 'candidate must be the clean live HEAD');
  const validation = { schemaVersion: 1, runId: candidate.runId, repo: candidate.repo, baseSha: candidate.baseSha, headSha: candidate.headSha,
    round: candidate.round, candidateSha256: digest(args.candidate), contextSha256: digest(args.context), checks: [] };
  for (const command of plan(context.validationCommands)) {
    const startedAtMs = Date.now(), before = git(context.worktree, ['rev-parse', 'HEAD']);
    const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: context.worktree, encoding: 'utf8', timeout: command.timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024, shell: false });
    const logfile = command.id + '.log';
    fs.writeFileSync(path.join(output, logfile), (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : ''), { mode: 0o600 });
    validation.checks.push({ id: command.id, argv: command.argv, cwd: context.worktree, startedAtMs, completedAtMs: Date.now(), exitCode: result.status,
      signal: result.signal, headBefore: before, headAfter: git(context.worktree, ['rev-parse', 'HEAD']),
      log: { path: logfile, sha256: digest(path.join(output, logfile)) } });
  }
  validation.completedAtMs = Date.now();
  atomic(path.join(output, 'validation.json'), validation);
}
function gate(args) {
  ownOutput(args.out, 'result.json');
  const problems = [], unresolvedFindings = [], validationFailures = [];
  let candidate = {}, mode;
  try {
    const context = read(args.context); candidate = read(args.candidate);
    version(context, 'context'); version(candidate, 'candidate'); commonRepository(context);
    requireThat(context.runId === runtimeRunId(), 'context wrong run');
    requireThat(MODES.includes(context.mode), 'context mode missing');
    mode = context.mode;
    roles(context.roles);
    resource(context, args.resources, args['expected-resources-sha']);
    requireThat(typeof args['change-summary'] === 'string' && fs.statSync(args['change-summary']).isFile(), 'change summary required');
    same(candidate, context, ['runId', 'repo', 'baseSha'], 'candidate');
    requireThat(candidate.contextSha256 === digest(args.context) && candidate.resourcesSha256 === context.resourcesSha256, 'candidate context/resource mismatch');
    requireThat(Number.isSafeInteger(candidate.round) && candidate.round === Number(args.round) && candidate.round === runtimeRound(), 'wrong current round');
    requireThat(COMMIT.test(candidate.headSha), 'invalid candidate SHA');
    requireThat(git(context.worktree, ['rev-parse', 'HEAD']) === candidate.headSha, 'live HEAD changed');
    requireThat(!git(context.worktree, ['status', '--porcelain']), 'dirty worktree');
    requireThat(git(context.worktree, ['branch', '--show-current']) === context.branch, 'wrong task branch');
    git(context.worktree, ['merge-base', '--is-ancestor', context.baseSha, candidate.headSha]);
    requireThat(mode !== 'review' || candidate.headSha === context.startSha, 'review mode must not change the PR head');
    const validation = read(args.validation);
    version(validation, 'validation');
    same(validation, candidate, ['runId', 'repo', 'baseSha', 'headSha', 'round'], 'validation');
    requireThat(validation.candidateSha256 === digest(args.candidate) && validation.contextSha256 === digest(args.context), 'validation input provenance mismatch');
    const commands = plan(context.validationCommands);
    requireThat(Array.isArray(validation.checks) && validation.checks.length === commands.length, 'missing/extra validation commands');
    for (let index = 0; index < commands.length; index++) {
      const expected = commands[index], actual = validation.checks[index];
      requireThat(actual.id === expected.id && JSON.stringify(actual.argv) === JSON.stringify(expected.argv) && actual.cwd === context.worktree, 'validation command provenance mismatch');
      requireThat(actual.headBefore === candidate.headSha && actual.headAfter === candidate.headSha, 'validation failed or changed HEAD');
      requireThat(Number.isFinite(actual.startedAtMs) && Number.isFinite(actual.completedAtMs) && actual.completedAtMs >= actual.startedAtMs, 'invalid validation timing');
      requireThat(digest(regular(path.dirname(args.validation), actual.log.path)) === actual.log.sha256, 'validation log hash mismatch');
      // Reviewing someone else's PR reports failed checks; it cannot repair them.
      if (actual.exitCode !== 0 || actual.signal) {
        requireThat(mode === 'review', 'validation failed or changed HEAD');
        validationFailures.push(expected.id);
      }
    }
    const reviews = [read(args.correctness), read(args.regression)];
    for (let index = 0; index < reviews.length; index++) {
      const review = reviews[index], role = index === 0 ? 'correctness' : 'regression';
      try {
        version(review, role + ' review');
        same(review, candidate, ['runId', 'repo', 'baseSha', 'headSha', 'round'], role + ' review');
        requireThat(review.role === role && review.reviewerId === context.roles[role].bot, 'wrong/duplicate reviewer identity');
        requireThat(review.candidateSha256 === digest(args.candidate) && review.validationSha256 === digest(args.validation) && review.contextSha256 === digest(args.context), 'review input provenance mismatch');
        requireThat([review.coverage, review.evidence].every(items => Array.isArray(items) && items.length && items.every(item => typeof item === 'string' && item.trim())), 'review lacks nonempty string evidence/coverage');
        requireThat(Array.isArray(review.findings) && review.findings.every(finding => object(finding) && typeof finding.blocking === 'boolean' &&
          ['location', 'impact', 'evidence'].every(key => typeof finding[key] === 'string' && finding[key].trim())), 'unclassified/incomplete finding');
        // Only forward authenticated, candidate-bound findings, never the full
        // independent report. Developers need both reviewers' actionable issues.
        for (const finding of review.findings) unresolvedFindings.push({ role, blocking: finding.blocking,
          location: finding.location, impact: finding.impact, evidence: finding.evidence });
        if (mode === 'review') {
          // The PR author resolves these: a complete, consistent verdict passes and becomes the comment.
          const consistent = review.findings.length ? review.decision === 'changes_requested' : review.decision === 'approve';
          if (!consistent) problems.push(role + ': review decision is blocked or inconsistent with its findings');
        } else {
          if (review.findings.length) problems.push(role + ': unresolved findings (including nits)');
          if (review.decision !== 'approve') problems.push(role + ': review not approved');
        }
      } catch (error) { problems.push(role + ': ' + error.message); }
    }
  } catch (error) { problems.push(error.message); }
  const result = { passed: problems.length === 0, mode, reasons: problems, runId: candidate.runId, repo: candidate.repo,
    baseSha: candidate.baseSha, headSha: candidate.headSha, round: candidate.round, unresolvedFindings, validationFailures };
  atomic(args.out, result);
  const artifacts = {};
  for (const key of ['context', 'resources', 'candidate', 'validation', 'change-summary', 'correctness', 'regression']) {
    if (typeof args[key] === 'string' && fs.existsSync(args[key])) artifacts[key] = { path: path.resolve(args[key]), sha256: digest(args[key]) };
  }
  atomic(path.join(path.dirname(args.out), 'release-candidate.json'), { schemaVersion: 1, passed: result.passed, gate: result,
    toolsSha256: digest(self), artifacts });
  const findingsText = JSON.stringify(unresolvedFindings, null, 2) + '\n';
  fs.writeFileSync(path.join(path.dirname(args.out), 'feedback.md'), !result.passed
    ? 'Gate did not pass:\n' + problems.map(problem => '- ' + problem).join('\n') + '\nFindings to assess and resolve (including nits):\n' + findingsText
    : mode === 'review' ? 'Review gate passed; these findings go to the PR comment:\n' + findingsText : 'Gate passed for this candidate.\n', { mode: 0o600 });
}
function delivery(args) {
  const release = read(args.release), context = read(args.context), draft = read(args.draft);
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  version(release, 'release'); version(context, 'context');
  requireThat(output && context.runId === runtimeRunId() && release.passed === true && release.gate.passed === true, 'delivery requires the current passed gate');
  commonRepository(context);
  requireThat(release.toolsSha256 === digest(self) && release.artifacts.context.sha256 === digest(args.context), 'delivery context/tools mismatch');
  for (const artifact of Object.values(release.artifacts)) requireThat(digest(artifact.path) === artifact.sha256, 'release evidence changed');
  same(release.gate, context, ['runId', 'repo', 'baseSha', 'mode'], 'delivery gate');
  const headSha = git(context.worktree, ['rev-parse', 'HEAD']);
  requireThat(headSha === release.gate.headSha, 'delivery candidate is no longer the clean task HEAD');
  cleanHead(context, headSha, 'delivery candidate');
  requireThat(typeof draft.repository === 'string' && draft.repository.trim() && typeof draft.summary === 'string' && draft.summary.trim(), 'delivery repository and summary required');
  const mode = context.mode, target = context.reviewTarget, existing = draft.existingPr;
  let action, sourceBranch = context.branch, prHead = null, commentBody = null;
  const notes = [];
  if (mode === 'new') {
    requireThat(existing === undefined || existing === null, 'new development must not attach another PR');
    action = headSha === context.baseSha ? 'none' : 'create';
    const localTarget = git(context.repo, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/' + context.targetBranch + '^{commit}']);
    if (localTarget !== context.baseSha) notes.push('注意：本地 ' + context.targetBranch + ' 已从基线 ' + context.baseSha + ' 前进到 ' + localTarget + '，PR 合并前请确认无冲突。');
  } else {
    requireThat(object(existing) && existing.state === 'OPEN', 'open existing PR required');
    same(existing, target, ['url', 'sourceBranch', 'targetBranch'], 'existing review PR');
    sourceBranch = existing.sourceBranch;
    if (mode === 'review') {
      requireThat(headSha === context.startSha, 'review mode must not change the PR head');
      commentBody = fs.readFileSync(args.comment, 'utf8').trim();
      requireThat(commentBody, 'review comment required');
      for (const finding of release.gate.unresolvedFindings) requireThat(commentBody.includes(finding.location), 'review comment omits finding at ' + finding.location);
      action = 'comment';
    } else {
      prHead = remoteHead(context.repo, draft.pushRemote, sourceBranch);
      requireThat(prHead === target.headSha || prHead === headSha, 'remote PR head changed since it was fetched');
      action = headSha === prHead ? 'reuse' : 'update';
      if (action === 'update') git(context.worktree, ['merge-base', '--is-ancestor', prHead, headSha]);
    }
  }
  if (action === 'create') {
    requireThat(remoteHead(context.repo, draft.pushRemote, sourceBranch) === null, 'remote task branch already exists');
  }
  const pushes = action === 'create' || action === 'update';
  const title = args.title ? fs.readFileSync(args.title, 'utf8').trim() : '', body = args.body ? fs.readFileSync(args.body, 'utf8').trim() : '';
  requireThat(!pushes || (title && body), 'delivery title/body required');
  const publicationRequired = pushes || action === 'comment';
  // Commenting on one's own PR needs no approval; pushing and others' PRs always do.
  const ownPr = action === 'comment' && target.author.trim().toLowerCase() === String(context.login).toLowerCase();
  const approvalRequired = publicationRequired && !ownPr;
  const actionText = { none: '无新增改动，仅交付结果', reuse: '已有 PR 无需更新，仅交付评审结论', update: '推送修复到原 PR 源分支',
    create: '推送任务分支并新建 PR/MR', comment: ownPr ? '在本人 PR 上发布评审评论（无需审批）' : '在他人 PR 上发布评审评论' }[action];
  const approvalSummary = [
    '仓库：' + draft.repository, '动作：' + actionText,
    'PR/MR：' + (existing ? existing.url : '新建'),
    '分支：' + sourceBranch + ' → ' + context.targetBranch,
    '推送远端：' + (pushes ? draft.pushRemote : '无需推送'),
    '提交：' + headSha, '基线：' + context.baseSha,
    ...notes,
    '变更与验证：' + draft.summary,
    ...(pushes ? ['标题：' + title, '正文：\n' + body] : []),
    ...(commentBody ? ['评论正文：\n' + commentBody] : []),
    '批准范围：仅上述' + (action === 'comment' ? '评论发布' : '候选的推送及 PR/MR 交付') + '；不含合并、部署。',
  ].join('\n');
  requireThat(!approvalRequired || approvalSummary.length <= 6000, 'approval material too long; shorten the title/body/summary/comment before approval');
  atomic(path.join(output, 'result.json'), { schemaVersion: 1, runId: context.runId, mode, action, publicationRequired,
    approvalRequired, directPublish: publicationRequired && !approvalRequired,
    repository: draft.repository, existingPr: existing || null, pushRemote: pushes ? draft.pushRemote : null,
    sourceBranch, targetBranch: context.targetBranch, headSha, baseSha: context.baseSha, prHead, approvalSummary,
    title: title || null, body: body || null,
    commentBody, commentSha256: commentBody ? sha(Buffer.from(commentBody)) : null,
    releaseSha256: digest(args.release), contextSha256: digest(args.context), draftSha256: digest(args.draft),
    titleSha256: args.title ? digest(args.title) : null, bodySha256: args.body ? digest(args.body) : null });
}
function push(args) {
  const { deliveryPlan, context } = boundPlan(args), output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  requireThat(output, 'goal output unavailable');
  requireThat(deliveryPlan.action === 'create' || deliveryPlan.action === 'update', 'delivery plan has no push action');
  cleanHead(context, deliveryPlan.headSha, 'approved candidate');
  const before = remoteHead(context.repo, deliveryPlan.pushRemote, deliveryPlan.sourceBranch);
  if (before !== deliveryPlan.headSha) {
    requireThat(before === deliveryPlan.prHead, 'remote branch moved after approval');
    // Explicit commit and no "+" or --force: the remote accepts only a fast-forward.
    git(context.worktree, ['push', '--porcelain', deliveryPlan.pushRemote, deliveryPlan.headSha + ':refs/heads/' + deliveryPlan.sourceBranch]);
  }
  const after = remoteHead(context.repo, deliveryPlan.pushRemote, deliveryPlan.sourceBranch);
  requireThat(after === deliveryPlan.headSha, 'remote branch does not hold the approved commit');
  atomic(path.join(output, 'push.json'), { schemaVersion: 1, runId: context.runId, action: deliveryPlan.action, pushRemote: deliveryPlan.pushRemote,
    sourceBranch: deliveryPlan.sourceBranch, headSha: deliveryPlan.headSha, remoteBefore: before, remoteAfter: after, planSha256: digest(args.plan) });
}
// Run by an independent reviewer bot: the published state must equal what the gate passed and the plan showed.
function verifyPublication(args) {
  ownOutput(args.out, 'verification.json');
  const { deliveryPlan, context } = boundPlan(args);
  const observed = read(args.observed);
  requireThat(object(observed) && typeof observed.url === 'string' && /^https:\/\//.test(observed.url), 'observed PR URL required');
  if (deliveryPlan.existingPr) requireThat(observed.url === deliveryPlan.existingPr.url, 'published to a different PR');
  if (deliveryPlan.action === 'create' || deliveryPlan.action === 'update') {
    requireThat(remoteHead(context.repo, deliveryPlan.pushRemote, deliveryPlan.sourceBranch) === deliveryPlan.headSha, 'remote branch does not hold the reviewed commit');
    requireThat(observed.headSha === deliveryPlan.headSha && observed.sourceBranch === deliveryPlan.sourceBranch &&
      observed.targetBranch === deliveryPlan.targetBranch, 'PR does not point at the reviewed commit and branches');
  } else {
    requireThat(deliveryPlan.action === 'comment', 'unsupported publication action');
    const posted = fs.readFileSync(args['observed-comment'], 'utf8').trim();
    requireThat(sha(Buffer.from(posted)) === deliveryPlan.commentSha256, 'posted comment differs from the planned text');
  }
  atomic(args.out, { schemaVersion: 1, verified: true, runId: context.runId, mode: deliveryPlan.mode, action: deliveryPlan.action,
    url: observed.url, sourceBranch: deliveryPlan.sourceBranch, targetBranch: deliveryPlan.targetBranch, headSha: deliveryPlan.headSha,
    approvalRequired: deliveryPlan.approvalRequired, planSha256: digest(args.plan) });
}
function publish(args) {
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR, manifest = process.env.BOTMUX_GOAL_MANIFEST_PATH;
  requireThat(output && manifest, 'goal output/manifest environment required');
  const files = [], names = new Set(), paths = new Set();
  for (const entry of args.entries) {
    const [name, kind, relative] = entry;
    requireThat(/^[A-Za-z0-9._-]+$/.test(name) && !names.has(name) && !paths.has(relative), 'duplicate/invalid manifest entry');
    requireThat(['json', 'markdown', 'text', 'log'].includes(kind), 'unsupported manifest kind');
    const filename = regular(output, relative), bytes = fs.readFileSync(filename);
    if (kind === 'json') JSON.parse(bytes.toString('utf8'));
    names.add(name); paths.add(relative);
    files.push({ name, kind, path: relative, bytes: bytes.length, sha256: sha(bytes).slice('sha256:'.length),
      mime: kind === 'json' ? 'application/json' : kind === 'markdown' ? 'text/markdown' : 'text/plain' });
  }
  requireThat(files.length, 'at least one real product required');
  atomic(manifest, { schemaVersion: 1, status: 'ok', summary: args.summary || 'Products delivered; decisions are in the artifacts.', files });
}
const args = { entries: [] }, mode = process.argv[2];
const allowed = new Set(['preflight', 'params', 'roles', 'context', 'candidate', 'validation', 'change-summary', 'correctness', 'regression', 'resources', 'expected-resources-sha', 'expected-tools-sha', 'round', 'out', 'summary', 'release', 'draft', 'title', 'body', 'comment', 'plan', 'observed', 'observed-comment']);
try {
  for (let index = 3; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--entry') { requireThat(process.argv.length > index + 3, 'entry needs name/kind/path'); args.entries.push(process.argv.slice(index + 1, index + 4)); index += 3; continue; }
    const key = flag.slice(2);
    requireThat(flag.startsWith('--') && allowed.has(key) && !Object.hasOwn(args, key) && process.argv[index+1], 'invalid/duplicate tool argument');
    args[key] = process.argv[++index];
  }
  requireThat(args['expected-tools-sha'] && digest(self) === args['expected-tools-sha'], 'fixed tools hash mismatch');
  if (mode === 'prepare') prepare(args);
  else if (mode === 'candidate') candidate(args);
  else if (mode === 'record') record(args);
  else if (mode === 'gate') gate(args);
  else if (mode === 'delivery') delivery(args);
  else if (mode === 'push') push(args);
  else if (mode === 'verify-publication') verifyPublication(args);
  else if (mode === 'publish') publish(args);
  else throw new Error('unsupported development-review tool mode');
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
`;

export const DEVELOPMENT_REVIEW_RESOURCE_VERSION = 1;
export const DEVELOPMENT_REVIEW_RESOURCES = Object.freeze([Object.freeze({
  path: 'tools.mjs',
  content: DEVELOPMENT_REVIEW_TOOLS_SOURCE,
  sha256: `sha256:${createHash('sha256').update(DEVELOPMENT_REVIEW_TOOLS_SOURCE).digest('hex')}`,
})]);
export const DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 = `sha256:${createHash('sha256').update(JSON.stringify({
  preset: 'development-review', version: 1,
  files: DEVELOPMENT_REVIEW_RESOURCES.map(file => ({ path: file.path, sha256: file.sha256 })),
}, null, 2) + '\n').digest('hex')}`;
