import { createHash } from 'node:crypto';
import { PUBLICATION_RECOVERY_TOOLS_SOURCE } from './development-review-publication-recovery-tools.js';

/** Embedded bytes are the executable resource: no checkout-relative file reads.
 * Keep it ASCII (\u escapes for text): Bun's transpiler rewrites non-ASCII inside
 * String.raw, which would give Bun and Node different tool bytes and digests. */
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
  atomicText(filename, JSON.stringify(value, null, 2) + '\n');
}
function atomicText(filename, value) {
  const temporary = filename + '.tmp-' + process.pid;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); }
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
function git(cwd, args, timeout, env = gitEnv) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, timeout, maxBuffer: 256 * 1024 * 1024 });
  requireThat(!result.error && result.status === 0, 'git command failed: ' + args[0]);
  return result.stdout.trim();
}
const MODES = ['new', 'review', 'continue'];
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// host + owner/repo of a Git remote URL (https, ssh:// or scp-like); null when unrecognized.
function repositoryIdentity(url) {
  const text = String(url).trim();
  const match = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::[0-9]+)?\/(.+)$/i.exec(text) || /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(text);
  if (!match) return null;
  const repo = match[2].replace(/\/+$/, '').replace(/\.git$/i, '');
  return repo.split('/').length >= 2 ? { host: match[1].toLowerCase(), path: repo.toLowerCase() } : null;
}
// host + owner/repo of a GitHub pull request or GitLab merge request URL; null otherwise.
function pullRequestRepository(url) {
  const match = /^https:\/\/([^/]+)\/(.+?)\/(?:pull|-\/merge_requests)\/[0-9]+(?:[/?#].*)?$/i.exec(String(url));
  return match ? { host: match[1].toLowerCase(), path: match[2].toLowerCase() } : null;
}
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
// A delivery plan is valid only for the passed gate, context and fixed tools it was derived from,
// and only with the routing the context implies: the developer cannot skip an approval.
function checkPlan(args, binding) {
  const deliveryPlan = read(args.plan), context = read(args.context), release = read(args.release);
  version(deliveryPlan, 'delivery plan'); version(context, 'context'); version(release, 'release');
  requireThat(context.runId === (binding ? binding.sourceRunId : runtimeRunId()) && deliveryPlan.runId === context.runId, 'delivery plan wrong run');
  commonRepository(context);
  requireThat(release.passed === true && release.gate.passed === true && release.toolsSha256 === (binding ? binding.sourceToolsSha256 : digest(self)) &&
    deliveryPlan.releaseSha256 === digest(args.release) && deliveryPlan.contextSha256 === digest(args.context), 'delivery plan is not bound to the passed gate');
  requireThat(deliveryPlan.headSha === release.gate.headSha && deliveryPlan.baseSha === context.baseSha && deliveryPlan.mode === context.mode,
    'delivery plan publishes a commit the reviewers did not approve');
  const target = context.reviewTarget, action = deliveryPlan.action;
  requireThat({ new: ['none', 'create'], continue: ['reuse', 'update'], review: ['comment'] }[context.mode].includes(action), 'delivery action does not fit the mode');
  const pushes = action === 'create' || action === 'update', publication = pushes || action === 'comment';
  const direct = ownComment(context, action);
  requireThat(deliveryPlan.publicationRequired === publication && deliveryPlan.approvalRequired === (publication && !direct) &&
    deliveryPlan.directPublish === (publication && direct), 'delivery plan skipped a required approval');
  requireThat(deliveryPlan.targetBranch === context.targetBranch && deliveryPlan.sourceBranch === (target ? target.sourceBranch : context.branch) &&
    (target ? object(deliveryPlan.existingPr) && deliveryPlan.existingPr.url === target.url : deliveryPlan.existingPr === null), 'delivery plan targets another PR or branch');
  requireThat(typeof deliveryPlan.repository === 'string' && deliveryPlan.repository.trim() && typeof deliveryPlan.summary === 'string' && deliveryPlan.summary.trim() &&
    (!pushes || (typeof deliveryPlan.pushRemote === 'string' && REMOTE.test(deliveryPlan.pushRemote) && deliveryPlan.title && deliveryPlan.body)), 'delivery plan material incomplete');
  if (action === 'comment') {
    requireThat(typeof deliveryPlan.commentBody === 'string' && deliveryPlan.commentBody === commentText(deliveryPlan.commentBody) &&
      sha(Buffer.from(deliveryPlan.commentBody)) === deliveryPlan.commentSha256 &&
      deliveryPlan.commentBody.startsWith(commentPrefix(release.gate, context)) &&
      !deliveryPlan.commentBody.slice(commentPrefix(release.gate, context).length).includes('<'), 'planned comment does not carry every finding');
  }
  return { deliveryPlan, context, release };
}
function boundPlan(args, binding) {
  const bound = checkPlan(args, binding);
  requireThat(bound.deliveryPlan.publicationRequired === true, 'delivery plan has no publication');
  return bound;
}
// Raw HTML (e.g. an unclosed comment) could hide or restyle the following text when rendered.
function inert(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
// Keep the frozen private evidence intact. Public material has repository
// locations or diagnostic basenames, never worker/home/run directory names.
function publicText(value, context) {
  let text = String(value);
  for (const root of [context.worktree, context.repo].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(root + path.sep).join('');
  }
  return text.split(/(https?:\/\/[^\s<>"'\x60\]\)]+)/g).map((part, index) => index % 2 ? part : part
    .replace(/(^|[^A-Za-z0-9_.\/-])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s<>"'\x60\]\)\uFF0C\u3002\uFF1B]+/g,
      (match, before) => before + 'diagnostic:' + match.slice(before.length).replace(/\\/g, '/').split('/').pop())
    .replace(/(?:\.?botmux\/)?v3-runs\/[^\s<>"'\x60\]\)]+/g, value => 'diagnostic:' + value.split('/').pop())).join('');
}
// The findings section is generated from the gate and comes first; the developer's note
// follows it, so nothing the developer writes can drop, soften or hide the findings.
function commentPrefix(gate, context) {
  const findings = gate.unresolvedFindings, failures = gate.validationFailures || [];
  const lines = [findings.length || failures.length
    ? '\u7ED3\u8BBA\uFF1A\u9700\u8981\u4FEE\u6539\uFF08' + findings.length + ' \u6761\u610F\u89C1\uFF0C' + failures.length + ' \u9879\u68C0\u67E5\u5931\u8D25\uFF09' : '\u7ED3\u8BBA\uFF1A\u8BC4\u5BA1\u901A\u8FC7\uFF0C\u65E0\u9057\u7559\u610F\u89C1'];
  findings.forEach((finding, index) => lines.push((index + 1) + '. [' + (finding.blocking ? '\u963B\u585E' : '\u5EFA\u8BAE') + '] ' + inert(publicText(finding.location, context)),
    '   \u5F71\u54CD\uFF1A' + inert(publicText(finding.impact, context)), '   \u8BC1\u636E\uFF1A' + inert(publicText(finding.evidence, context))));
  if (failures.length) lines.push('\u68C0\u67E5\u5931\u8D25\uFF1A' + failures.map(inert).join('\u3001'));
  return commentText(lines.join('\n')) + '\n\n---\n\u8BC4\u5BA1\u8BF4\u660E\uFF1A\n';
}
function composeComment(gate, note, context) { return commentText(commentPrefix(gate, context) + inert(publicText(commentText(note), context))); }
// Approval material is rebuilt from the plan's checked fields, not taken from developer prose.
function approvalMaterial(deliveryPlan, context) {
  const action = deliveryPlan.action, pushes = action === 'create' || action === 'update', existing = deliveryPlan.existingPr;
  const notes = [];
  if (context.mode === 'new') {
    const localTarget = git(context.repo, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/' + context.targetBranch + '^{commit}']);
    if (localTarget !== context.baseSha) notes.push('\u6CE8\u610F\uFF1A\u672C\u5730 ' + context.targetBranch + ' \u5DF2\u4ECE\u57FA\u7EBF ' + context.baseSha + ' \u524D\u8FDB\u5230 ' + localTarget + '\uFF0CPR \u5408\u5E76\u524D\u8BF7\u786E\u8BA4\u65E0\u51B2\u7A81\u3002');
  }
  const actionText = { none: '\u65E0\u65B0\u589E\u6539\u52A8\uFF0C\u4EC5\u4EA4\u4ED8\u7ED3\u679C', reuse: '\u5DF2\u6709 PR \u65E0\u9700\u66F4\u65B0\uFF0C\u4EC5\u4EA4\u4ED8\u8BC4\u5BA1\u7ED3\u8BBA', update: '\u63A8\u9001\u4FEE\u590D\u5230\u539F PR \u6E90\u5206\u652F',
    create: '\u63A8\u9001\u4EFB\u52A1\u5206\u652F\u5E76\u65B0\u5EFA PR/MR', comment: deliveryPlan.directPublish ? '\u5728\u672C\u4EBA PR \u4E0A\u53D1\u5E03\u8BC4\u5BA1\u8BC4\u8BBA\uFF08\u65E0\u9700\u5BA1\u6279\uFF09' : '\u5728\u4ED6\u4EBA PR \u4E0A\u53D1\u5E03\u8BC4\u5BA1\u8BC4\u8BBA' }[action];
  return [
    '\u4ED3\u5E93\uFF1A' + deliveryPlan.repository, '\u52A8\u4F5C\uFF1A' + actionText,
    'PR/MR\uFF1A' + (existing ? existing.url : '\u65B0\u5EFA'),
    '\u5206\u652F\uFF1A' + deliveryPlan.sourceBranch + ' \u2192 ' + deliveryPlan.targetBranch,
    '\u63A8\u9001\u8FDC\u7AEF\uFF1A' + (pushes ? deliveryPlan.pushRemote : '\u65E0\u9700\u63A8\u9001'),
    '\u63D0\u4EA4\uFF1A' + deliveryPlan.headSha, '\u57FA\u7EBF\uFF1A' + deliveryPlan.baseSha,
    ...notes,
    '\u53D8\u66F4\u4E0E\u9A8C\u8BC1\uFF1A' + deliveryPlan.summary,
    ...(pushes ? ['\u6807\u9898\uFF1A' + deliveryPlan.title, '\u6B63\u6587\uFF1A\n' + deliveryPlan.body] : []),
    ...(action === 'comment' ? ['\u8BC4\u8BBA\u6B63\u6587\uFF1A\n' + deliveryPlan.commentBody] : []),
    '\u6279\u51C6\u8303\u56F4\uFF1A\u4EC5\u4E0A\u8FF0' + (action === 'comment' ? '\u8BC4\u8BBA\u53D1\u5E03' : '\u5019\u9009\u7684\u63A8\u9001\u53CA PR/MR \u4EA4\u4ED8') + '\uFF1B\u4E0D\u542B\u5408\u5E76\u3001\u90E8\u7F72\u3002',
  ].join('\n');
}
// Platforms may normalize line endings and surrounding whitespace of stored comments.
function commentText(text) { return text.replace(/\r\n?/g, '\n').trim(); }
// Commenting on the initiator's own PR is the only publication without approval.
function ownComment(context, action) {
  return action === 'comment' && context.reviewTarget.author.trim().toLowerCase() === String(context.login).toLowerCase();
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
  requireThat(selected[0] !== selected[1] && selected[0] !== selected[2], 'development and review require distinct bot identities');
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
function dependencyFailure(message) {
  const error = new Error(message);
  error.code = 'DEPENDENCY_ENVIRONMENT_NOT_READY';
  throw error;
}
// Select a project interpreter without changing the worker/daemon runtime or
// invoking version-manager shell hooks. Only already installed binaries qualify.
function projectRuntime(root, preferred) {
  const env = { ...process.env }, pins = [];
  for (const file of ['.nvmrc', '.node-version']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const value = fs.readFileSync(regular(root, file), 'utf8').trim();
    if (!/^v?\d+(?:\.\d+){0,2}$/.test(value)) dependencyFailure('Unsupported Node pin in ' + file + ': ' + value + '; use a numeric installed version');
    pins.push({ file, value, parts: value.replace(/^v/, '').split('.') });
  }
  if (!pins.length) return { env, node: null };
  const matches = value => /^v\d+\.\d+\.\d+$/.test(value) && pins.every(pin =>
    pin.parts.every((part, index) => part === value.slice(1).split('.')[index]));
  const requested = pins.map(pin => pin.file + '=' + pin.value).join(', ');
  const candidates = [preferred?.execPath, 'node'];
  const executable = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, executable));
  let observed = 'unavailable';
  function select(commands) {
    for (const command of new Set(commands.filter(Boolean))) {
      const result = spawnSync(command, ['-p', 'JSON.stringify({version:process.version,execPath:process.execPath})'],
        { cwd: root, env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, shell: false });
      if (result.error || result.status !== 0) continue;
      let node;
      try { node = JSON.parse(result.stdout.trim()); } catch { continue; }
      if (command === 'node') observed = node.version;
      if (!object(node) || typeof node.version !== 'string' || !matches(node.version) || !path.isAbsolute(node.execPath || '')) continue;
      env.PATH = path.dirname(node.execPath) + path.delimiter + (env.PATH || '');
      return { env, node: { version: node.version, execPath: node.execPath } };
    }
  }
  const onPath = select(candidates);
  if (onPath) return onPath;
  const pathCandidateCount = candidates.length;
  const home = env.HOME || env.USERPROFILE;
  const stores = [
    [env.FNM_DIR || (home && path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'fnm')), 'node-versions', 'installation', 'bin'],
    [env.NVM_DIR || (home && path.join(home, '.nvm')), 'versions', 'node'],
  ];
  for (const [base, ...parts] of stores) {
    if (!base) continue;
    const fnm = parts[0] === 'node-versions', store = path.join(base, ...(fnm ? parts.slice(0, 1) : parts));
    let versions;
    try { versions = fs.readdirSync(store); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    for (const value of versions.filter(matches).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      candidates.push(path.join(store, value, ...(fnm ? ['installation', 'bin'] : ['bin']), executable));
    }
  }
  const installed = select(candidates.slice(pathCandidateCount));
  if (installed) return installed;
  dependencyFailure('Node runtime unavailable: required ' + requested + '; current PATH Node ' + observed +
    '. Install the requested Node in the configured fnm/nvm store or expose it on PATH, then retry; no dependencies were installed.');
}
function dependencyInputs(worktree) {
  return git(worktree, ['ls-files', '-z']).split('\0').filter(file => /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc\.yml|\.nvmrc|\.node-version)$/.test(file)).sort();
}
function dependencyDigest(root, files) { return sha(Buffer.from(JSON.stringify(files.map(file => [file, digest(path.join(root, file))])))); }
function workspaceDigest(root, files) {
  return sha(Buffer.from(JSON.stringify(files.map(file => {
    const filename = path.join(root, file), stat = fs.lstatSync(filename);
    requireThat(stat.isFile() || stat.isSymbolicLink(), 'workspace snapshot contains an unsupported entry');
    return [file, stat.isSymbolicLink() ? ['link', fs.readlinkSync(filename)] : ['file', digest(filename)]];
  }))));
}
function checkInstalledPackages(modules, names) {
  for (const name of names) {
    requireThat(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name), 'invalid dependency name');
    requireThat(fs.statSync(path.join(modules, name, 'package.json')).isFile(), 'required dependency missing: ' + name);
  }
}
function checkWorkspaceLinks(worktree, source, modules, files) {
  const pkg = read(path.join(worktree, 'package.json'));
  let patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  if (!patterns && fs.existsSync(path.join(worktree, 'pnpm-workspace.yaml'))) {
    const yaml = fs.readFileSync(path.join(worktree, 'pnpm-workspace.yaml'), 'utf8');
    const block = /(?:^|\n)packages:[ \t]*\r?\n((?:[ \t]+[^\n]*\n?|[ \t]*\n)*)/.exec(yaml)?.[1];
    requireThat(block, 'workspace package patterns must be an explicit list');
    patterns = block.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
      const item = /^\s+-\s+(['"]?)([^'"\s]+)\1\s*(?:#.*)?$/.exec(line);
      requireThat(item, 'unsupported workspace package pattern'); return item[2];
    });
  }
  requireThat(Array.isArray(patterns) && patterns.length && patterns.every(value => typeof value === 'string' && !value.includes('..') && !value.startsWith('/')), 'workspace package patterns required');
  const match = (pattern, directory) => new RegExp('^' + pattern.replace(/[.+^$(){}|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*') + '$').test(directory);
  const packages = new Map();
  for (const file of files.filter(file => file !== 'package.json' && file.endsWith('/package.json'))) {
    const directory = path.posix.dirname(file);
    if (!patterns.some(pattern => !pattern.startsWith('!') && match(pattern, directory)) || patterns.some(pattern => pattern.startsWith('!') && match(pattern.slice(1), directory))) continue;
    const name = read(path.join(worktree, file)).name;
    requireThat(typeof name === 'string' && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name), 'workspace package name required');
    requireThat(!packages.has(name), 'duplicate workspace package name');
    packages.set(name, directory);
  }
  for (const [name, directory] of packages) {
    // pnpm links a workspace package only into its dependents' node_modules;
    // a root link, when present, must still point into the snapshot.
    const installed = path.join(modules, name);
    if (fs.lstatSync(installed, { throwIfNoEntry: false })) requireThat(fs.realpathSync(installed) === fs.realpathSync(path.join(source, directory)), 'workspace link points outside the matching snapshot');
    const child = read(path.join(worktree, directory, 'package.json'));
    for (const dependency of Object.keys({ ...child.dependencies, ...child.devDependencies })) {
      requireThat(/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(dependency), 'invalid workspace dependency name');
      const local = path.join(source, directory, 'node_modules', dependency);
      const resolved = fs.existsSync(path.join(local, 'package.json')) ? local : path.join(modules, dependency);
      requireThat(fs.existsSync(path.join(resolved, 'package.json')), 'workspace dependency missing: ' + dependency);
      if (packages.has(dependency)) requireThat(fs.realpathSync(resolved) === fs.realpathSync(path.join(source, packages.get(dependency))), 'nested workspace link points outside the matching snapshot');
    }
  }
}
// Root lifecycle hooks belong to the project build, not to dependency install;
// the isolated environment may hold only manifests. Dependency hooks still run.
const ROOT_LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
function installCommand(root) {
  const has = file => fs.existsSync(path.join(root, file));
  if (has('bun.lock') || has('bun.lockb')) return ['bun', 'install', '--frozen-lockfile'];
  if (has('pnpm-lock.yaml')) return ['pnpm', 'install', '--frozen-lockfile'];
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return ['npm', 'ci'];
  if (has('yarn.lock')) return has('.yarnrc.yml') ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile'];
  throw new Error('frozen root dependency lockfile required');
}
function checkPackageManager(root, runtime, command) {
  const filename = path.join(root, 'package.json');
  if (!fs.existsSync(filename)) return;
  const pkg = read(filename);
  if (typeof pkg.packageManager !== 'string') return;
  const pin = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(pkg.packageManager);
  if (!pin || (command && pin[1] !== command)) dependencyFailure('packageManager does not match the frozen lockfile: ' + pkg.packageManager);
  const actual = spawnSync(pin[1], ['--version'], { cwd: root, env: runtime.env, encoding: 'utf8', timeout: 10000, shell: false });
  if (actual.error || actual.status !== 0 || actual.stdout.trim() !== pin[2])
    dependencyFailure('Package manager mismatch: required ' + pkg.packageManager + '; use its installed Corepack shim or matching executable before retrying');
}
// Runs the frozen install in root with the root lifecycle hooks removed, then
// restores the manifest bytes.
function frozenInstall(root, log, runtime, rebuild = false) {
  const manifest = path.join(root, 'package.json'), original = fs.readFileSync(manifest), pkg = JSON.parse(original.toString('utf8'));
  if (object(pkg.scripts)) for (const hook of ROOT_LIFECYCLE) delete pkg.scripts[hook];
  const [command, ...argv] = installCommand(root);
  checkPackageManager(root, runtime, command);
  const steps = [argv];
  if (rebuild && command === 'yarn' && fs.existsSync(path.join(root, '.yarnrc.yml'))) steps.push(['rebuild']);
  else if (rebuild && (command === 'pnpm' || command === 'bun' || command === 'yarn')) argv.push('--force');
  // npm ci already removes the old modules. Other managers can retain native
  // build output across frozen installs, so an unknown/changed Node needs rebuild.
  let result, executed;
  const deadline = Date.now() + 30 * 60 * 1000;
  const output = runtime.node ? ['Node ' + runtime.node.version + ' (' + runtime.node.execPath + ')'] : [];
  try {
    fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
    for (const args of steps) {
      executed = [command, ...args].join(' ');
      result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024, shell: false, env: { ...runtime.env, CI: '1' } });
      output.push(executed, result.stdout || '', result.stderr || '', result.error ? result.error.message : '');
      if (result.error || result.status !== 0) break;
    }
  } finally { fs.writeFileSync(manifest, original); }
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, output.join('\n'), { mode: 0o600 });
  requireThat(result.status === 0, 'dependency install failed: ' + executed +
    (result.error ? ' (' + result.error.message + ')' : ' exited ' + result.status) + '; log ' + log);
}
function runDependencyDir() {
  const attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
  requireThat(attempt, 'attempt directory unavailable for a dependency install');
  return path.join(path.dirname(path.dirname(path.dirname(attempt))), 'dependencies');
}
function worktreeInstallState(worktree) {
  const filename = path.join(runDependencyDir(), 'worktree-state-' + sha(Buffer.from(path.resolve(worktree))).slice(7, 39) + '.json');
  let installed;
  try { installed = read(filename); } catch { /* Interrupted/legacy installs have no verified current state. */ }
  return { filename, installed };
}
function currentWorktreeInstall(worktree, dependencies) {
  const { installed } = worktreeInstallState(worktree);
  return installed?.inputsSha256 === dependencies.inputsSha256 && JSON.stringify(installed.runtime) === JSON.stringify(dependencies.runtime);
}
// Workspace links must resolve to the task's own package directories, which an
// out-of-tree snapshot cannot give (pnpm keeps each package's dependencies in
// that package's node_modules). Install into the task-owned worktree instead,
// never through a link into another environment.
function installWorktreeDependencies(worktree, files, names, runtime) {
  requireThat(files.includes('package.json') && files.some(file => /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file)), 'frozen dependency lockfile required');
  const inputsSha256 = dependencyDigest(worktree, files), target = path.join(worktree, 'node_modules');
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) fs.unlinkSync(target);
  else requireThat(!existing || existing.isDirectory(), 'task node_modules is not a directory');
  const log = path.join(runDependencyDir(), 'worktree-' + inputsSha256.slice(7, 39) + '.install.log');
  const { filename: stamp, installed } = worktreeInstallState(worktree);
  const rebuild = !!runtime.node && !!existing?.isDirectory() && JSON.stringify(installed?.runtime) !== JSON.stringify(runtime.node);
  // This describes the current modules, not a cache keyed by a past manifest.
  // Invalidate before mutations so interrupted installs and A -> B -> A retries rebuild.
  fs.rmSync(stamp, { force: true });
  frozenInstall(worktree, log, runtime, rebuild);
  requireThat(!git(worktree, ['status', '--porcelain']), 'dependency install changed the task checkout; repository rules must ignore node_modules');
  requireThat(fs.lstatSync(target).isDirectory(), 'dependency install produced no node_modules');
  const modules = fs.realpathSync(target);
  checkInstalledPackages(modules, names);
  atomic(stamp, { inputsSha256, runtime: runtime.node });
  return { state: 'ready', mode: 'worktree', source: fs.realpathSync(worktree), inputsSha256, files, modules, names, runtime: runtime.node };
}
// Build a run-owned environment outside the repository/worktree from the task
// checkout's exact manifest and lockfile bytes (the whole tracked snapshot for
// workspaces), using the lockfile without updating it. Never writes the worktree.
function installIsolatedDependencies(worktree, files, inputsSha256, hasWorkspaces, runtime) {
  const parent = runDependencyDir();
  const copied = hasWorkspaces ? git(worktree, ['ls-files', '-z']).split('\0').filter(Boolean).sort() : files;
  const key = sha(Buffer.from(JSON.stringify([inputsSha256, hasWorkspaces ? workspaceDigest(worktree, copied) : null, runtime.node]))).slice(7, 39);
  const root = path.join(parent, key), ready = root + '.ready';
  if (fs.existsSync(ready) && fs.existsSync(path.join(root, 'node_modules'))) return root;
  fs.rmSync(ready, { force: true }); fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const file of copied) {
    const from = path.join(worktree, file), to = path.join(root, file), stat = fs.lstatSync(from);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else { requireThat(stat.isFile(), 'workspace snapshot contains an unsupported entry'); fs.copyFileSync(from, to); }
  }
  frozenInstall(root, root + '.install.log', runtime);
  fs.writeFileSync(ready, inputsSha256 + '\n');
  return root;
}
// allowInstall: when the approved source cannot be reused, prepare its own
// isolated environment instead of trusting a hand-made snapshot.
function prepareDependencies(worktree, repository, checked, replaceTaskLink = false, allowInstall = false) {
  const runtime = projectRuntime(worktree);
  if (!fs.existsSync(path.join(worktree, 'package.json'))) return { state: 'not-required', runtime: runtime.node };
  const pkg = read(path.join(worktree, 'package.json'));
  const hasWorkspaces = !!pkg.workspaces || fs.existsSync(path.join(worktree, 'pnpm-workspace.yaml'));
  const required = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, spec]) => !String(spec).startsWith('workspace:'));
  if (!required.length && !hasWorkspaces) return { state: 'not-required', runtime: runtime.node };
  const files = dependencyInputs(worktree), names = required.map(([name]) => name);
  if (hasWorkspaces && allowInstall && checked.dependencyWorktreeInstallAllowed !== false) {
    try { return installWorktreeDependencies(worktree, files, names, runtime); } catch (error) { dependencyFailure(error.message); }
  }
  const use = candidate => {
    const source = fs.realpathSync(candidate);
    requireThat(files.includes('package.json') && files.some(file => /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file)), 'frozen dependency lockfile required');
    const inputsSha256 = dependencyDigest(worktree, files);
    requireThat(dependencyDigest(source, files) === inputsSha256, 'dependency source manifests/lockfiles differ from the task checkout');
    const modules = fs.realpathSync(path.join(source, 'node_modules'));
    requireThat(fs.statSync(modules).isDirectory(), 'dependency source node_modules missing');
    checkInstalledPackages(modules, names);
    let workspace;
    if (hasWorkspaces) {
      requireThat(source !== repository && source !== worktree && modules.startsWith(source + path.sep), 'workspaces require an independently installed snapshot outside the repository/worktree');
      const snapshotFiles = git(worktree, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
      const snapshotSha256 = workspaceDigest(worktree, snapshotFiles);
      requireThat(workspaceDigest(source, snapshotFiles) === snapshotSha256, 'workspace source code differs from the task snapshot');
      checkWorkspaceLinks(worktree, source, modules, files);
      workspace = { sha256: snapshotSha256 };
    }
    return { state: 'ready', source, inputsSha256, files, modules, names, runtime: runtime.node, ...(workspace ? { workspace } : {}) };
  };
  let prepared;
  try {
    let reuseError;
    // A foreign node_modules has no evidence of the interpreter that built its
    // native addons. Pinned projects get a run-owned install keyed by runtime.
    if (checked.dependencyReuseAllowed === true && !runtime.node) {
      try { prepared = use(checked.dependencySourcePath || repository); } catch (error) { reuseError = error; }
    }
    if (!prepared) {
      requireThat(allowInstall, reuseError ? reuseError.message : 'preflight must approve dependency reuse under repository rules');
      prepared = use(installIsolatedDependencies(worktree, files, dependencyDigest(worktree, files), hasWorkspaces, runtime));
      if (reuseError) prepared.reuseRejected = reuseError.message;
    }
    const { modules } = prepared, target = path.join(worktree, 'node_modules');
    // An explicit record --dependency-source can detach this clean task's
    // dependency link, including one prepared in an earlier development round.
    // Never remove a directory or write into the link's shared target.
    const taskLink = fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink();
    // Runtime changes produce another run-owned cache. A pristine prepare retry
    // may rebind only its own cache link; the old environment is left untouched.
    const ownCacheLink = taskLink && allowInstall && /^[a-f0-9]{32}\/node_modules$/.test(
      path.relative(runDependencyDir(), path.resolve(path.dirname(target), fs.readlinkSync(target))).split(path.sep).join('/'));
    if ((replaceTaskLink || ownCacheLink) && taskLink
      && (!fs.existsSync(target) || fs.realpathSync(target) !== modules)) fs.unlinkSync(target);
    if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
      requireThat(fs.realpathSync(target) === modules, 'task dependencies already point to a different environment');
    } else fs.symlinkSync(modules, target, process.platform === 'win32' ? 'junction' : 'dir');
    requireThat(!git(worktree, ['status', '--porcelain', '--', 'node_modules']), 'repository rules must ignore the prepared dependency link');
    return prepared;
  } catch (error) { dependencyFailure(error.message); }
}
function checkDependencies(context, dependencies = context.dependencies) {
  const runtime = projectRuntime(context.worktree, dependencies?.runtime);
  checkPackageManager(context.worktree, runtime);
  if (JSON.stringify(runtime.node) !== JSON.stringify(dependencies?.runtime || null))
    dependencyFailure('Node runtime changed since dependency preparation; prepare dependencies again before validation');
  if (dependencies?.state !== 'ready') {
    if (fs.existsSync(path.join(context.worktree, 'package.json'))) {
      const pkg = read(path.join(context.worktree, 'package.json'));
      if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length || pkg.workspaces || fs.existsSync(path.join(context.worktree, 'pnpm-workspace.yaml'))) {
        dependencyFailure('prepare a matching dependency source and pass record --dependency-source before validation');
      }
    }
    return runtime;
  }
  const { source, files, inputsSha256, modules } = dependencies;
  if (dependencies.mode === 'worktree') {
    try {
      const target = path.join(context.worktree, 'node_modules');
      requireThat(dependencyDigest(context.worktree, dependencyInputs(context.worktree)) === inputsSha256 && source === fs.realpathSync(context.worktree),
        'dependency inputs changed; record reinstalls them in the task worktree');
      requireThat(currentWorktreeInstall(context.worktree, dependencies), 'task dependency installation changed; record must prepare it again before validation');
      requireThat(fs.lstatSync(target).isDirectory() && fs.realpathSync(target) === modules, 'prepared dependencies are unavailable');
      checkInstalledPackages(modules, dependencies.names);
    } catch (error) { dependencyFailure(error.message); }
    return runtime;
  }
  try {
    requireThat(dependencyDigest(context.worktree, dependencyInputs(context.worktree)) === inputsSha256 && dependencyDigest(source, files) === inputsSha256,
      'dependency inputs changed; prepare a matching isolated environment before validation');
    requireThat(fs.realpathSync(path.join(context.worktree, 'node_modules')) === modules && fs.realpathSync(path.join(source, 'node_modules')) === modules && fs.statSync(modules).isDirectory(), 'prepared dependencies are unavailable');
    const pkg = read(path.join(context.worktree, 'package.json'));
    checkInstalledPackages(modules, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
    const workspace = dependencies.workspace;
    if (pkg.workspaces || fs.existsSync(path.join(context.worktree, 'pnpm-workspace.yaml'))) {
      requireThat(workspace && source !== context.repo && source !== context.worktree && modules.startsWith(source + path.sep), 'workspace dependencies must use an independent snapshot');
      const snapshotFiles = git(context.worktree, ['ls-files', '-z']).split('\0').filter(Boolean).sort();
      requireThat(workspaceDigest(context.worktree, snapshotFiles) === workspace.sha256 && workspaceDigest(source, snapshotFiles) === workspace.sha256,
        'workspace code changed; prepare a new task-specific dependency snapshot');
      checkWorkspaceLinks(context.worktree, source, modules, dependencyInputs(context.worktree));
    }
  } catch (error) { dependencyFailure(error.message); }
  return runtime;
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
  // A preflight-verified CLI location is a hint for fresh independent queries, not
  // cached identity/permission evidence. Old preflights need not provide it.
  let repositoryCliPath;
  if (checked.repositoryCliPath !== undefined) {
    requireThat(typeof checked.repositoryCliPath === 'string' && path.isAbsolute(checked.repositoryCliPath), 'repository CLI must use an absolute executable path');
    repositoryCliPath = fs.realpathSync(checked.repositoryCliPath);
    requireThat(fs.statSync(repositoryCliPath).isFile(), 'repository CLI must be a regular executable');
    fs.accessSync(repositoryCliPath, fs.constants.X_OK);
  }
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
    // A fork PR's head lives on the fork, but its target branch lives on the base
    // repository: the baseline must come from the remote of the PR's target
    // repository. Preflight names it baseRemote when it differs from remote.
    const baseRemote = reviewTarget.baseRemote === undefined ? reviewTarget.remote : reviewTarget.baseRemote;
    requireThat(typeof baseRemote === 'string' && REMOTE.test(baseRemote), 'review target base remote must be a configured remote name');
    const baseRemoteRepository = repositoryIdentity(git(repository, ['remote', 'get-url', baseRemote]));
    const prRepository = pullRequestRepository(reviewTarget.url);
    // Same host, different repository: the remote is a fork (or another project), and
    // its target branch is not the PR base. Fail instead of reviewing a wrong range.
    requireThat(!baseRemoteRepository || !prRepository || baseRemoteRepository.host !== prRepository.host ||
      baseRemoteRepository.path === prRepository.path,
      'PR_BASE_REMOTE_MISMATCH: remote ' + baseRemote + ' is ' + baseRemoteRepository?.host + '/' + baseRemoteRepository?.path +
      ' but the PR targets ' + prRepository?.host + '/' + prRepository?.path + '; name the target repository remote as reviewTarget.baseRemote');
    targetBranch = reviewTarget.targetBranch;
    // Preflight fetched both refs; from here on the local objects are the baseline.
    const targetTip = git(repository, ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/' + baseRemote + '/' + targetBranch + '^{commit}']);
    startSha = git(repository, ['rev-parse', '--verify', '--end-of-options', reviewTarget.headSha + '^{commit}']);
    requireThat(startSha === reviewTarget.headSha, 'review target head is not a full commit id');
    // A PR may lag its target branch: review and develop against the merge base.
    baseSha = git(repository, ['merge-base', targetTip, startSha]);
  }
  const login = typeof checked.login === 'string' && checked.login.trim() ? checked.login.trim() : null;
  const recovery = params.recovery_source;
  if (object(recovery) && Object.keys(recovery).length) {
    const runDir = path.dirname(path.dirname(path.dirname(process.env.BOTMUX_GOAL_ATTEMPT_DIR)));
    const journalPath = path.join(runDir, 'journal.ndjson');
    // The public parameter is data, not recovery authority. Only the host's
    // durable fork record can authorize using another run's candidate.
    const records = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8').split('\n').slice(0, -1).filter(line => line.trim()).map(line => JSON.parse(line)) : [];
    const authorization = records.find(event => event.type === 'runRecovered');
    requireThat(authorization && authorization.purpose === undefined && authorization.sourceRunId === recovery.sourceRunId &&
      authorization.sourceAttemptId === recovery.sourceAttemptId && authorization.sourceJournalSha256 === recovery.journalSha256 &&
      ['developer', 'correctness', 'regression'].every(role => authorization.roles[role] === selected[role].bot),
      'authorized recovery record missing or mismatched');
    requireThat(recovery.sourceRunId !== checked.runId && typeof recovery.sourceRunId === 'string', 'invalid recovery source');
    for (const [file, expected] of [['contextPath', 'contextSha256'], ['candidatePath', 'candidateSha256'], ['journalPath', 'journalSha256']]) {
      requireThat(typeof recovery[file] === 'string' && digest(recovery[file]) === recovery[expected], 'recovery source changed: ' + file);
    }
    const previous = read(recovery.contextPath), checkpoint = read(recovery.candidatePath);
    requireThat(previous.runId === recovery.sourceRunId && checkpoint.runId === recovery.sourceRunId &&
      checkpoint.contextSha256 === recovery.contextSha256 && previous.repo === repository && checkpoint.repo === repository &&
      previous.mode === mode && previous.baseSha === baseSha && checkpoint.baseSha === baseSha && COMMIT.test(checkpoint.headSha),
      'recovery candidate does not match the repository, mode and baseline');
    requireThat(mode === 'new' || (previous.startSha === startSha && previous.reviewTarget.url === reviewTarget.url),
      'PR changed since recovery candidate; start a fresh review');
    commonRepository(previous);
    cleanHead(previous, checkpoint.headSha, 'recovery source');
    git(repository, ['merge-base', '--is-ancestor', baseSha, checkpoint.headSha]);
    startSha = checkpoint.headSha;
  }
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
  // Preflight only reports reuse; it must not hand-build environments. An explicit
  // dependencyInstallAllowed:false (repository rules forbid installing) fails closed.
  const dependencies = prepareDependencies(worktree, repository, checked, false, checked.dependencyInstallAllowed !== false);
  const manifest = { preset: 'development-review', version: 1, files: [{ path: 'tools.mjs', sha256: digest(self) }] };
  atomic(path.join(output, 'resources.json'), manifest);
  const context = { schemaVersion: 1, runId: checked.runId, mode, repo: repository, worktree, branch, targetBranch,
    ...(object(recovery) && recovery.sourceRunId ? { recoveredFrom: { runId: recovery.sourceRunId, attemptId: recovery.sourceAttemptId,
      candidateSha256: recovery.candidateSha256, journalSha256: recovery.journalSha256 } } : {}),
    baseSha, startSha, ...(reviewTarget ? { reviewTarget } : {}), ...(repositoryCliPath ? { repositoryCliPath } : {}), login, requirement, requirementSha256: sha(Buffer.from(requirement)), roles: selected,
    dependencies, validationCommands: commands, preflightSha256: digest(args.preflight), resourcesSha256: digest(path.join(output, 'resources.json')) };
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
// A validation budget stop is terminal for the attempt: another round or a retry runs the
// same frozen budget. Producers record it as a failed Manifest with a stable code.
function validationTimeout(message) {
  const error = new Error(message); error.code = 'VALIDATION_TIMEOUT'; return error;
}
function timedOutChecks(file) {
  if (!fs.existsSync(file)) return [];
  const checks = read(file).checks;
  return Array.isArray(checks) ? checks.filter(check => object(check) && check.timedOut === true) : [];
}
function failForTimeout(error, entries) {
  publish({ entries, summary: 'Validation stopped by its frozen budget; this is not a code failure or a pass.',
    error: { code: 'VALIDATION_TIMEOUT', message: error.message, retryable: false } });
}
function runChecks(context, output, prefix, dependencies = context.dependencies) {
  const runtime = checkDependencies(context, dependencies);
  return plan(context.validationCommands).map(command => {
    // An explicit interpreter bypasses PATH. Preserve caller argv, but never
    // certify checks run against a different Node than the installed addons.
    if (runtime.node && path.isAbsolute(command.argv[0])) {
      let executable = command.argv[0];
      try { executable = fs.realpathSync(executable); } catch { /* Normal spawn failure is recorded below. */ }
      if (/^node(?:\.exe)?$/i.test(path.basename(executable)) || /^node(?:\.exe)?$/i.test(path.basename(command.argv[0]))) {
        const actual = spawnSync(command.argv[0], ['--version'], { env: runtime.env, encoding: 'utf8', timeout: 10000, shell: false });
        if (actual.error || actual.status !== 0 || actual.stdout.trim() !== runtime.node.version)
          dependencyFailure('Explicit Node validation command does not match prepared ' + runtime.node.version + ': ' + command.argv[0]);
      }
    }
    const startedAtMs = Date.now(), before = git(context.worktree, ['rev-parse', 'HEAD']);
    const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: context.worktree, env: runtime.env, encoding: 'utf8', timeout: command.timeoutSec * 1000, maxBuffer: 16 * 1024 * 1024, shell: false });
    const logfile = prefix + command.id + '.log';
    // A command stopped by its own budget has not failed a check; record that explicitly so
    // the gate reports an undersized budget instead of a failure there is nothing to fix for.
    const timedOut = !!result.error && result.error.code === 'ETIMEDOUT';
    fs.writeFileSync(path.join(output, logfile), (result.stdout || '') + (result.stderr || '') + (result.error ? '\n' + result.error.message : '') +
      (timedOut ? '\n[development-review] stopped after its ' + command.timeoutSec + 's validation budget' : ''), { mode: 0o600 });
    return { id: command.id, argv: command.argv, cwd: context.worktree, startedAtMs, completedAtMs: Date.now(), exitCode: result.status,
      signal: result.signal, ...(timedOut ? { timedOut: true, timeoutSec: command.timeoutSec } : {}), headBefore: before, headAfter: git(context.worktree, ['rev-parse', 'HEAD']),
      log: { path: logfile, sha256: digest(path.join(output, logfile)) } };
  });
}
function record(args) {
  const context = read(args.context), candidate = read(args.candidate), output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  version(context, 'context'); version(candidate, 'candidate'); commonRepository(context);
  requireThat(context.runId === runtimeRunId(), 'context wrong run');
  same(candidate, context, ['runId', 'repo', 'baseSha'], 'candidate');
  requireThat(Number.isSafeInteger(candidate.round) && Number(args.round) === candidate.round && candidate.round === runtimeRound(), 'wrong current round');
  requireThat(candidate.contextSha256 === digest(args.context) && candidate.resourcesSha256 === context.resourcesSha256, 'candidate context/resource mismatch');
  requireThat(git(context.worktree, ['rev-parse', 'HEAD']) === candidate.headSha && !git(context.worktree, ['status', '--porcelain']), 'candidate must be the clean live HEAD');
  let dependencies = context.dependencies;
  if (dependencies?.mode === 'worktree') {
    if (dependencyDigest(context.worktree, dependencyInputs(context.worktree)) !== dependencies.inputsSha256 || !currentWorktreeInstall(context.worktree, dependencies)) {
      requireThat(context.mode !== 'review', 'review mode must use its prepared dependencies');
      dependencies = prepareDependencies(context.worktree, context.repo, {}, false, true);
    }
  } else if (args['dependency-source']) {
    requireThat(context.mode !== 'review', 'review mode must use its prepared dependencies');
    dependencies = prepareDependencies(context.worktree, context.repo,
      { dependencyReuseAllowed: true, dependencySourcePath: args['dependency-source'] }, true);
  }
  const validation = { schemaVersion: 1, runId: candidate.runId, repo: candidate.repo, baseSha: candidate.baseSha, headSha: candidate.headSha,
    round: candidate.round, candidateSha256: digest(args.candidate), contextSha256: digest(args.context), dependencies, checks: runChecks(context, output, '', dependencies) };
  validation.completedAtMs = Date.now();
  atomic(path.join(output, 'validation.json'), validation);
  const stopped = validation.checks.filter(check => check.timedOut === true);
  if (stopped.length) {
    const error = validationTimeout('VALIDATION_TIMEOUT: ' + stopped.map(check => check.id + ' stopped after its ' + check.timeoutSec + 's budget').join('; ') +
      ' before finishing; the frozen validation budget is smaller than this command needs');
    failForTimeout(error, [['candidate', 'json', path.relative(output, args.candidate) === 'candidate.json' ? 'candidate.json' : null],
      ['validation', 'json', 'validation.json'], ...validation.checks.map(check => ['log-' + check.id, 'log', check.log.path])].filter(entry => entry[2]));
    throw error;
  }
}
function gate(args) {
  ownOutput(args.out, 'result.json');
  const problems = [], unresolvedFindings = [], validationFailures = [], budgetStops = [];
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
      // A budget stop says nothing about the code: name it, in every mode, instead of
      // sending the developer after a failure that does not exist.
      if (actual.timedOut === true) budgetStops.push('VALIDATION_TIMEOUT: ' + expected.id + ' stopped after its ' + expected.timeoutSec +
        's budget before finishing; the frozen validation budget is smaller than this command needs');
      requireThat(actual.timedOut !== true, budgetStops[budgetStops.length - 1]);
      // Reviewing someone else's PR reports failed checks; it cannot repair them.
      if (actual.exitCode !== 0 || actual.signal) {
        requireThat(mode === 'review', 'validation failed or changed HEAD');
        validationFailures.push(expected.id);
      }
    }
    // validation.json is developer-authored: re-run every check here and require the same outcome.
    requireThat(mode !== 'review' || JSON.stringify(validation.dependencies) === JSON.stringify(context.dependencies), 'review dependency environment changed');
    const rerun = runChecks(context, path.dirname(args.out), 'independent-', validation.dependencies);
    atomic(path.join(path.dirname(args.out), 'independent-validation.json'), { schemaVersion: 1, runId: candidate.runId, headSha: candidate.headSha, checks: rerun });
    requireThat(git(context.worktree, ['rev-parse', 'HEAD']) === candidate.headSha, 'independent validation changed HEAD');
    for (const check of rerun) {
      if (check.timedOut !== true) continue;
      budgetStops.push('VALIDATION_TIMEOUT: independent re-run of ' + check.id + ' stopped after its ' + check.timeoutSec +
        's budget before finishing; the frozen validation budget is smaller than this command needs');
      requireThat(false, budgetStops[budgetStops.length - 1]);
    }
    rerun.forEach((check, index) => requireThat(check.exitCode === validation.checks[index].exitCode &&
      (check.signal || null) === (validation.checks[index].signal || null), 'validation record contradicts the independent re-run: ' + check.id));
    const reviews = [read(args.correctness), read(args.regression)];
    for (let index = 0; index < reviews.length; index++) {
      const review = reviews[index], role = index === 0 ? 'correctness' : 'regression';
      try {
        version(review, role + ' review');
        same(review, candidate, ['runId', 'repo', 'baseSha', 'headSha', 'round'], role + ' review');
        requireThat(review.role === role && review.reviewerId === context.roles[role].bot, 'wrong review role or reviewer identity');
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
  const independent = path.join(path.dirname(args.out), 'independent-validation.json');
  for (const [key, filename] of [...['context', 'resources', 'candidate', 'validation', 'change-summary', 'correctness', 'regression'].map(key => [key, args[key]]),
    ['independent-validation', independent]]) {
    if (typeof filename === 'string' && fs.existsSync(filename)) artifacts[key] = { path: path.resolve(filename), sha256: digest(filename) };
  }
  atomic(path.join(path.dirname(args.out), 'release-candidate.json'), { schemaVersion: 1, passed: result.passed, gate: result,
    toolsSha256: digest(self), artifacts });
  const findingsText = JSON.stringify(unresolvedFindings, null, 2) + '\n';
  fs.writeFileSync(path.join(path.dirname(args.out), 'feedback.md'), !result.passed
    ? 'Gate did not pass:\n' + problems.map(problem => '- ' + problem).join('\n') + '\nFindings to assess and resolve (including nits):\n' + findingsText
    : mode === 'review' ? 'Review gate passed; these findings go to the PR comment:\n' + findingsText : 'Gate passed for this candidate.\n', { mode: 0o600 });
  // Another round cannot fix an undersized frozen budget: stop the loop with the evidence
  // above instead of returning a rework result the developer has nothing to act on.
  if (budgetStops.length) throw validationTimeout(budgetStops[0]);
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
  if (mode === 'new') {
    requireThat(existing === undefined || existing === null, 'new development must not attach another PR');
    action = headSha === context.baseSha ? 'none' : 'create';
  } else {
    requireThat(object(existing) && existing.state === 'OPEN', 'open existing PR required');
    same(existing, target, ['url', 'sourceBranch', 'targetBranch'], 'existing review PR');
    sourceBranch = existing.sourceBranch;
    if (mode === 'review') {
      requireThat(headSha === context.startSha, 'review mode must not change the PR head');
      const preface = commentText(fs.readFileSync(args.comment, 'utf8'));
      requireThat(preface, 'review comment required');
      commentBody = composeComment(release.gate, preface, context);
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
  const approvalRequired = publicationRequired && !ownComment(context, action);
  const result = { schemaVersion: 1, runId: context.runId, mode, action, publicationRequired,
    approvalRequired, directPublish: publicationRequired && !approvalRequired,
    repository: publicText(draft.repository, context), summary: publicText(draft.summary, context), existingPr: existing || null, pushRemote: mode === 'review' ? null : draft.pushRemote || null,
    sourceBranch, targetBranch: context.targetBranch, headSha, baseSha: context.baseSha, prHead,
    title: title ? publicText(title, context) : null, body: body ? publicText(body, context) : null,
    commentBody, commentSha256: commentBody ? sha(Buffer.from(commentBody)) : null,
    releaseSha256: digest(args.release), contextSha256: digest(args.context), draftSha256: digest(args.draft),
    titleSha256: args.title ? digest(args.title) : null, bodySha256: args.body ? digest(args.body) : null };
  result.approvalSummary = approvalMaterial(result, context);
  requireThat(!approvalRequired || result.approvalSummary.length <= 6000, 'approval material too long; shorten the title/body/summary/comment before approval');
  atomic(path.join(output, 'result.json'), result);
}
// Run by an independent reviewer bot before any publication: the engine routes on this result, not the developer's plan.
function route(args) {
  ownOutput(args.out, 'result.json');
  const { deliveryPlan, context } = checkPlan(args);
  cleanHead(context, deliveryPlan.headSha, 'delivery candidate');
  let expected = 'comment';
  if (context.mode === 'new') expected = deliveryPlan.headSha === context.baseSha ? 'none' : 'create';
  if (context.mode === 'continue') {
    const live = remoteHead(context.repo, deliveryPlan.pushRemote, deliveryPlan.sourceBranch);
    requireThat(live === deliveryPlan.prHead, 'remote PR head changed since planning');
    expected = live === deliveryPlan.headSha ? 'reuse' : 'update';
  }
  requireThat(deliveryPlan.action === expected, 'delivery action does not match the live repository');
  // Login and PR author came from the developer's preflight: skip approval only when this bot's
  // own query confirms both; anything else falls back to human approval.
  let direct = false;
  if (deliveryPlan.directPublish && args['observed-identity'] && fs.existsSync(args['observed-identity'])) {
    const observed = read(args['observed-identity']), lower = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
    direct = object(observed) && lower(observed.login) !== '' && lower(observed.login) === lower(observed.author) &&
      lower(observed.author) === lower(context.reviewTarget.author) && lower(observed.login) === lower(context.login);
  }
  const routed = { ...deliveryPlan, approvalRequired: deliveryPlan.publicationRequired && !direct, directPublish: direct };
  const approvalSummary = approvalMaterial(routed, context);
  requireThat(!routed.approvalRequired || approvalSummary.length <= 6000, 'approval material too long; shorten the title/body/summary/comment before approval');
  atomic(args.out, { schemaVersion: 1, runId: context.runId, mode: context.mode, action: expected, publicationRequired: routed.publicationRequired,
    approvalRequired: routed.approvalRequired, directPublish: direct, identityConfirmed: direct, approvalSummary, planSha256: digest(args.plan) });
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
// A merged PR may have no source ref. Its original head still identifies the
// reviewed candidate, while the platform's integration commit proves delivery
// on the target branch (including squash/rebase, which rewrite commit IDs).
function publicationTarget(context, planned, observed) {
  const expected = pullRequestRepository(observed.url);
  requireThat(expected, 'merged PR must identify its target repository');
  const expectedUrl = new URL(observed.url);
  const matches = url => {
    const identity = repositoryIdentity(url);
    // SSH and HTTPS use different ports. HTTP remotes, however, must name the
    // same web authority as the PR, including any non-default service port.
    const web = /^https?:\/\//i.test(url) ? new URL(url) : null;
    return identity && identity.host === expectedUrl.hostname.toLowerCase() && identity.path === expected.path &&
      (!web || web.host.toLowerCase() === expectedUrl.host.toLowerCase());
  };
  const rawUrl = remote => git(context.repo, ['config', '--get-all', 'remote.' + remote + '.url']).split('\n')[0];
  let remote = context.reviewTarget && (context.reviewTarget.baseRemote || context.reviewTarget.remote);
  if (!remote) {
    const candidates = git(context.repo, ['remote']).split('\n').filter(name => name && matches(rawUrl(name)));
    requireThat(candidates.length, 'merged PR target repository has no configured remote');
    remote = candidates.includes(planned.pushRemote) ? planned.pushRemote : candidates[0];
  }
  requireThat(typeof remote === 'string' && REMOTE.test(remote), 'merged PR target remote required');
  let url = git(context.repo, ['remote', 'get-url', remote]);
  requireThat(matches(rawUrl(remote)), 'merged PR target remote belongs to another repository');
  // Check the configured identity before resolving insteadOf transport aliases.
  // Resolve local transport paths against the checkout that owns the config.
  if (!url.includes(':')) url = path.resolve(context.repo, url);
  return { remote, url };
}
function observedPublication(context, planned, observed, observationPath) {
  requireThat(object(observed) && ['OPEN', 'MERGED'].includes(observed.state), 'PR must be open or verifiably merged');
  requireThat(typeof observed.url === 'string' && /^https:\/\//.test(observed.url) &&
    (!planned.existingPr || observed.url === planned.existingPr.url), 'published to a different PR');
  requireThat(observed.headSha === planned.headSha && observed.sourceBranch === planned.sourceBranch &&
    observed.targetBranch === planned.targetBranch, 'PR does not point at the reviewed commit and branches');
  const proof = { state: observed.state, observedPrSha256: digest(observationPath) };
  if (observed.state === 'OPEN') {
    requireThat(remoteHead(context.repo, planned.pushRemote, planned.sourceBranch) === planned.headSha, 'remote branch does not hold the reviewed commit');
    return proof;
  }
  requireThat(typeof observed.mergeCommitSha === 'string' && COMMIT.test(observed.mergeCommitSha), 'merged PR integration commit required');
  const target = publicationTarget(context, planned, observed);
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR;
  requireThat(output, 'publication verification output required');
  const temporary = fs.mkdtempSync(path.join(output, 'publication-target-'));
  const isolatedEnv = { ...gitEnv };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_QUARANTINE_PATH']) delete isolatedEnv[key];
  const isolatedGit = (args, timeout) => git(temporary, args, timeout, isolatedEnv);
  try {
    const format = git(context.repo, ['rev-parse', '--show-object-format']);
    isolatedGit(['init', '--bare', '--object-format=' + format, '.']);
    // Keep refs, FETCH_HEAD, configuration and objects of the task checkout
    // unchanged. No shallow boundary may hide the integration's ancestry.
    isolatedGit(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', target.url,
      'refs/heads/' + planned.targetBranch + ':refs/heads/verified-target'], 120000);
    const targetHeadSha = isolatedGit(['rev-parse', '--verify', 'refs/heads/verified-target^{commit}']);
    isolatedGit(['merge-base', '--is-ancestor', observed.mergeCommitSha, targetHeadSha]);
    // Fetch advertised this exact target snapshot. Normal target advancement
    // after the fetch does not invalidate this historical delivery proof.
    return { ...proof, mergeCommitSha: observed.mergeCommitSha, targetHeadSha, targetRemote: target.remote };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function validPublicationProof(proof) {
  return object(proof) && ['OPEN', 'MERGED'].includes(proof.state) && /^sha256:[a-f0-9]{64}$/.test(proof.observedPrSha256) &&
    (proof.state !== 'MERGED' || (COMMIT.test(proof.mergeCommitSha) && COMMIT.test(proof.targetHeadSha)));
}
function recoveryReceipt(binding) {
  return binding ? { sourceRunId: binding.sourceRunId, sourceBundleSha256: binding.sourceBundleSha256, verificationToolsSha256: digest(self) } : {};
}
function verifyPublication(args, binding) {
  ownOutput(args.out, 'verification.json');
  const { deliveryPlan, context } = boundPlan(args, binding);
  // The approval decision is check-delivery's, which may be stricter than the developer's plan.
  const routed = read(args.route);
  requireThat(object(routed) && routed.schemaVersion === 1 && routed.runId === context.runId && routed.planSha256 === digest(args.plan) &&
    routed.action === deliveryPlan.action && routed.publicationRequired === true && typeof routed.approvalRequired === 'boolean' &&
    routed.directPublish === !routed.approvalRequired && (!routed.directPublish || (deliveryPlan.directPublish && routed.identityConfirmed === true)),
  'routing result is not bound to this plan');
  const observed = read(args.observed);
  requireThat(object(observed) && typeof observed.url === 'string' && /^https:\/\//.test(observed.url), 'observed PR URL required');
  if (deliveryPlan.existingPr) requireThat(observed.url === deliveryPlan.existingPr.url, 'published to a different PR');
  let publication;
  if (deliveryPlan.action === 'create' || deliveryPlan.action === 'update') {
    publication = observedPublication(context, deliveryPlan, observed, args.observed);
  } else {
    requireThat(deliveryPlan.action === 'comment', 'unsupported publication action');
    const posted = commentText(fs.readFileSync(args['observed-comment'], 'utf8'));
    requireThat(sha(Buffer.from(posted)) === deliveryPlan.commentSha256, 'posted comment differs from the planned text');
  }
  atomic(args.out, { schemaVersion: 1, verified: true, runId: binding ? binding.executionRunId : context.runId, ...recoveryReceipt(binding), mode: deliveryPlan.mode, action: deliveryPlan.action,
    url: observed.url, sourceBranch: deliveryPlan.sourceBranch, targetBranch: deliveryPlan.targetBranch, headSha: deliveryPlan.headSha,
    approvalRequired: routed.approvalRequired, directPublish: routed.directPublish, identityConfirmed: routed.identityConfirmed === true,
    planSha256: digest(args.plan), routeSha256: digest(args.route), ...(publication ? { publication } : {}) });
}
// The stage entry point resolves the runtime's frozen refs, then calls the same
// guards as the public low-level commands. No model assembles provenance paths.
function stageInputs() {
  const envelope = read(process.env.BOTMUX_GOAL_INPUTS_PATH);
  requireThat(object(envelope) && Array.isArray(envelope.inputs), 'frozen goal inputs unavailable');
  const keys = new Set();
  for (const input of envelope.inputs) {
    requireThat(object(input) && typeof input.from === 'string' && typeof input.name === 'string' &&
      typeof input.path === 'string' && path.isAbsolute(input.path), 'invalid frozen input');
    const key = JSON.stringify([input.from, input.name]);
    requireThat(!keys.has(key), 'duplicate frozen input'); keys.add(key);
  }
  return (from, name, optional = false) => {
    const input = envelope.inputs.find(input => input.from === from && input.name === name);
    if (!input && optional) return undefined;
    requireThat(input, 'missing frozen input: ' + from + '/' + name);
    requireThat(!fs.lstatSync(input.path).isSymbolicLink() && fs.statSync(input.path).isFile(), 'frozen input must be a regular file');
    return input.path;
  };
}
// Evidence text is data even when it contains headings, HTML or unfinished
// fences. A delimiter longer than any run in the text cannot be closed by it.
function reportBlock(value, language = 'text') {
  const text = String(value);
  let longest = 2;
  for (const match of text.matchAll(/\x60+/g)) longest = Math.max(longest, match[0].length);
  const fence = String.fromCharCode(96).repeat(longest + 1);
  return fence + language + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence;
}
function completeStage(args, input, output, binding) {
  const { deliveryPlan: planned, context, release } = checkPlan(args, binding);
  cleanHead(context, planned.headSha, 'completion candidate');
  requireThat(release.artifacts.context.sha256 === digest(args.context), 'completion context changed');
  const evidence = {};
  for (const key of ['context', 'resources', 'candidate', 'validation', 'change-summary', 'correctness', 'regression', 'independent-validation']) {
    const artifact = release.artifacts[key];
    requireThat(object(artifact) && typeof artifact.path === 'string' && !fs.lstatSync(artifact.path).isSymbolicLink() &&
      fs.statSync(artifact.path).isFile() && digest(artifact.path) === artifact.sha256, 'release evidence changed: ' + key);
    evidence[key] = key === 'change-summary' ? fs.readFileSync(artifact.path, 'utf8') : read(artifact.path);
  }
  const gateFile = input('development-review-loop', 'gate-result', true);
  if (gateFile) requireThat(JSON.stringify(read(gateFile)) === JSON.stringify(release.gate), 'completion gate differs from the release');
  let verified, observed, publication, url = null;
  if (planned.publicationRequired) {
    verified = read(input('verify-publication', 'verification'));
    version(verified, 'verification');
    requireThat(verified.verified === true && verified.planSha256 === digest(args.plan) &&
      /^sha256:[a-f0-9]{64}$/.test(verified.routeSha256), 'verification is not bound to this plan');
    same(verified, { ...planned, runId: binding ? binding.executionRunId : planned.runId }, ['runId', 'mode', 'action', 'headSha', 'sourceBranch', 'targetBranch'], 'verification');
    if (binding) same(verified, recoveryReceipt(binding), ['sourceRunId', 'sourceBundleSha256', 'verificationToolsSha256'], 'recovery verification');
    if (planned.action === 'create' || planned.action === 'update') {
      requireThat(validPublicationProof(verified.publication), 'verification lacks a publication state proof');
      publication = verified.publication;
    }
    requireThat(typeof verified.url === 'string' && /^https:\/\//.test(verified.url) &&
      (!planned.existingPr || verified.url === planned.existingPr.url), 'verification targets another PR');
    requireThat(typeof verified.approvalRequired === 'boolean' && verified.directPublish === !verified.approvalRequired &&
      (!verified.directPublish || (planned.directPublish && verified.identityConfirmed === true)), 'verification skipped a required approval');
    url = verified.url;
  } else if (planned.action === 'reuse') {
    observed = read(regular(output, 'observed-pr.json'));
    publication = observedPublication(context, planned, observed, path.join(output, 'observed-pr.json'));
    url = observed.url;
  }
  const completion = { schemaVersion: 1, runId: binding ? binding.executionRunId : context.runId, ...recoveryReceipt(binding), mode: context.mode, action: planned.action, url,
    ...(publication ? { publication } : {}),
    sourceBranch: planned.sourceBranch, targetBranch: planned.targetBranch, headSha: planned.headSha, baseSha: planned.baseSha,
    publicationRequired: planned.publicationRequired, approvalRequired: verified ? verified.approvalRequired : false,
    pushed: planned.action === 'create' || planned.action === 'update', commented: planned.action === 'comment',
    validationFailures: release.gate.validationFailures || [], unresolvedFindings: release.gate.unresolvedFindings,
    planSha256: digest(args.plan), ...(verified ? { verificationSha256: digest(input('verify-publication', 'verification')) } : {}) };
  const lines = ['# Task report', '', 'Mode: ' + completion.mode, 'Action: ' + completion.action,
    'PR:', reportBlock(url || '(none)'), 'Source branch:', reportBlock(completion.sourceBranch),
    'Target branch:', reportBlock(completion.targetBranch), 'Head: ' + completion.headSha, 'Base: ' + completion.baseSha,
    ...(binding ? ['Recovered from run: ' + binding.sourceRunId, 'Recovery run: ' + binding.executionRunId,
      'Original review tools: ' + binding.sourceToolsSha256, 'Publication verification tools: ' + digest(self)] : []),
    ...(publication ? ['Publication state: ' + publication.state, ...(publication.state === 'MERGED' ?
      ['Integration commit: ' + publication.mergeCommitSha, 'Verified target snapshot: ' + publication.targetHeadSha] : [])] : []),
    'Pushed: ' + completion.pushed, 'Commented: ' + completion.commented,
    'Human approval required: ' + completion.approvalRequired, '', '## Delivery summary', '', reportBlock(planned.summary),
    '', '## Changes, validation and limitations', '', reportBlock(evidence['change-summary']),
    '', '## Recorded checks', '', reportBlock(JSON.stringify(evidence.validation.checks, null, 2), 'json'),
    '', '## Independent checks', '', reportBlock(JSON.stringify(evidence['independent-validation'].checks, null, 2), 'json'),
    '', '## Review findings (including nits)', '', reportBlock(JSON.stringify(completion.unresolvedFindings, null, 2), 'json'),
    '', 'Failed checks: ' + JSON.stringify(completion.validationFailures)];
  for (const role of ['correctness', 'regression']) {
    const review = evidence[role];
    lines.push('', '## ' + role, '', 'Decision: ' + review.decision, '',
      'Coverage:', reportBlock(JSON.stringify(review.coverage), 'json'), 'Evidence:', reportBlock(JSON.stringify(review.evidence), 'json'));
  }
  atomicText(path.join(output, 'task-report.md'), lines.join('\n') + '\n');
  atomic(path.join(output, 'completion.json'), completion);
  publish({ entries: [['task-report', 'markdown', 'task-report.md'], ['completion', 'json', 'completion.json'],
    ...(observed ? [['observed-pr', 'json', 'observed-pr.json']] : [])] });
}
function stage(args) {
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR, attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
  requireThat(output && attempt && path.resolve(output) === path.join(path.resolve(attempt), 'work'), 'stage must use this attempt output');
  const node = path.basename(path.dirname(path.dirname(attempt))), input = stageInputs();
  const preparedTools = input('prepare', 'tools');
  requireThat(fs.realpathSync(preparedTools) === fs.realpathSync(self), 'stage must use the frozen prepare tool');
  const context = input('prepare', 'context');
  const local = name => regular(output, name), entries = [];
  const add = (name, kind, filename) => entries.push([name, kind, filename]);
  if (/^development-review-loop\.i[0-9]+\.verify-review-gate$/.test(node)) {
    const prefix = node.slice(0, node.lastIndexOf('.') + 1);
    const gateProducts = () => {
      add('gate-result', 'json', 'result.json'); add('release-candidate', 'json', 'release-candidate.json'); add('feedback', 'markdown', 'feedback.md');
      if (fs.existsSync(path.join(output, 'independent-validation.json'))) {
        add('independent-validation', 'json', 'independent-validation.json');
        for (const check of read(local('independent-validation.json')).checks) { regular(output, check.log.path); add('independent-log-' + check.id, 'log', check.log.path); }
      }
    };
    try {
      gate({ context, resources: input('prepare', 'resources'), 'expected-resources-sha': args['expected-resources-sha'],
        candidate: input(prefix + 'implement', 'candidate'), validation: input(prefix + 'implement', 'validation'),
        'change-summary': input(prefix + 'implement', 'change-summary'), correctness: input(prefix + 'review-correctness', 'review'),
        regression: input(prefix + 'review-regression', 'review'), round: String(runtimeRound()), out: path.join(output, 'result.json') });
    } catch (error) {
      // The gate already wrote its not-passed evidence; deliver it as a failed attempt.
      if (error.code === 'VALIDATION_TIMEOUT') { gateProducts(); failForTimeout(error, entries); }
      throw error;
    }
    gateProducts();
    const decision = read(local('result.json'));
    if (decision.mode === 'review' && !decision.passed) {
      publish({ entries, error: { code: 'REVIEW_EVIDENCE_INCOMPLETE', message: decision.reasons.join('; '), retryable: true } });
      return;
    }
  } else {
    const bound = { context, release: input('development-review-loop', 'release-candidate') };
    const id = node.replace(/#[0-9]+$/, '');
    if (id === 'prepare-mr') {
      const review = read(context).mode === 'review';
      delivery({ ...bound, draft: local('mr-draft.json'), ...(review ? { comment: local('review-comment.md') } : { title: local('mr-title.txt'), body: local('mr-body.md') }) });
      add('mr-draft', 'json', 'mr-draft.json'); add('delivery-plan', 'json', 'result.json');
      for (const [name, kind, filename] of review ? [['review-comment', 'markdown', 'review-comment.md']] : [['mr-title', 'text', 'mr-title.txt'], ['mr-body', 'markdown', 'mr-body.md']]) add(name, kind, filename);
    } else {
      const planned = { ...bound, plan: input('prepare-mr', 'delivery-plan') };
      if (id === 'check-delivery') {
        const observed = fs.existsSync(path.join(output, 'observed-identity.json')) ? local('observed-identity.json') : undefined;
        route({ ...planned, out: path.join(output, 'result.json'), 'observed-identity': observed });
        add('route', 'json', 'result.json'); if (observed) add('observed-identity', 'json', 'observed-identity.json');
      } else if (id === 'verify-publication') {
        const comment = read(planned.plan).action === 'comment';
        verifyPublication({ ...planned, route: input('check-delivery', 'route'), observed: local('observed-pr.json'),
          ...(comment ? { 'observed-comment': local('observed-comment.md') } : {}), out: path.join(output, 'verification.json') });
        add('verification', 'json', 'verification.json'); add('observed-pr', 'json', 'observed-pr.json');
        if (comment) add('observed-comment', 'markdown', 'observed-comment.md');
      } else if (id === 'complete') { completeStage(planned, input, output); return; }
      else throw new Error('unsupported mechanical stage');
    }
  }
  publish({ entries });
}
function publish(args, checkpoint = false) {
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
  // A run stopped by its validation budget can only be delivered as that failure.
  if (!checkpoint && !(args.error && args.error.code === 'VALIDATION_TIMEOUT')) {
    const stopped = [...timedOutChecks(path.join(output, 'validation.json')), ...timedOutChecks(path.join(output, 'independent-validation.json'))];
    requireThat(!stopped.length, 'VALIDATION_TIMEOUT: ' + stopped.map(check => check.id).join(', ') + ' stopped by its validation budget; only a VALIDATION_TIMEOUT failure can be delivered');
  }
  if (checkpoint) {
    const attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
    requireThat(attempt && path.resolve(output) === path.join(path.resolve(attempt), 'work'), 'checkpoint must use this attempt output');
    const context = read(regular(attempt, 'checkpoint-context.json'));
    requireThat(context.schemaVersion === 1 && /^sha256:[a-f0-9]{64}$/.test(context.inputHash), 'checkpoint input hash unavailable');
    requireThat(!paths.has('checkpoint.json'), 'checkpoint cannot include itself');
    atomic(path.join(output, 'checkpoint.json'), { schemaVersion: 1, status: 'fail', inputHash: context.inputHash,
      summary: args.summary || 'Partial progress; remaining work is recorded in the artifacts.',
      error: { code: 'CHECKPOINT_INCOMPLETE', message: 'Work remains; this is not an approval.', retryable: true }, files });
    return;
  }
  atomic(manifest, { schemaVersion: 1, status: args.error ? 'fail' : 'ok', ...(args.error ? { error: args.error } : {}), summary: args.summary || 'Products delivered; decisions are in the artifacts.', files });
}
const args = { entries: [] }, mode = process.argv[2];
const allowed = new Set(['preflight', 'params', 'roles', 'context', 'candidate', 'validation', 'change-summary', 'correctness', 'regression', 'resources', 'expected-resources-sha', 'expected-tools-sha', 'round', 'out', 'summary', 'release', 'draft', 'title', 'body', 'comment', 'plan', 'observed', 'observed-comment', 'observed-identity', 'route', 'dependency-source']);
${PUBLICATION_RECOVERY_TOOLS_SOURCE}
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
  else if (mode === 'route') route(args);
  else if (mode === 'verify-publication') verifyPublication(args);
  else if (mode === 'stage') stage(args);
  else if (mode === 'publication-recovery-stage') publicationRecoveryStage(args);
  else if (mode === 'publish') publish(args);
  else if (mode === 'checkpoint') publish(args, true);
  else throw new Error('unsupported development-review tool mode');
} catch (error) {
  if (error.code === 'DEPENDENCY_ENVIRONMENT_NOT_READY' && process.env.BOTMUX_GOAL_MANIFEST_PATH) {
    atomic(process.env.BOTMUX_GOAL_MANIFEST_PATH, { schemaVersion: 1, status: 'fail', summary: 'Dependency environment requires preparation before review.',
      error: { code: error.code, message: error.message, retryable: true }, files: [] });
  }
  process.stderr.write(error.message + '\n'); process.exitCode = 2;
}
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
