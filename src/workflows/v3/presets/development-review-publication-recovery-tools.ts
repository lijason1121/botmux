/** Appended to the fixed development-review resource; keep embedded bytes ASCII. */
export const PUBLICATION_RECOVERY_TOOLS_SOURCE = String.raw`
function publicationRecoveryCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(publicationRecoveryCanonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + publicationRecoveryCanonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function publicationRecoveryStage(args) {
  const output = process.env.BOTMUX_GOAL_OUTPUT_DIR, attempt = process.env.BOTMUX_GOAL_ATTEMPT_DIR;
  requireThat(output && attempt && path.resolve(output) === path.join(path.resolve(attempt), 'work'), 'recovery stage must use this attempt output');
  const runDir = path.dirname(path.dirname(path.dirname(attempt))), envelope = read(path.join(runDir, 'run.json'));
  const node = path.basename(path.dirname(path.dirname(attempt))).replace(/#[0-9]+$/, '');
  requireThat(node === 'verify-publication' || node === 'complete', 'publication recovery is read-only');
  const input = stageInputs(), params = read(input('workflow', 'params')).params;
  const source = params && params.publication_recovery;
  requireThat(object(source) && source.schemaVersion === 1 && source.purpose === 'publication-only', 'publication recovery source unavailable');
  const sourceBundleSha256 = sha(Buffer.from(publicationRecoveryCanonical(source)));
  const frozenParams = regular(runDir, 'params.resolved.json'), frozenRoles = regular(runDir, 'roles.resolved.json');
  requireThat(envelope.artifacts.resolvedParams.sha256 === digest(frozenParams) && envelope.artifacts.resolvedRoles.sha256 === digest(frozenRoles), 'recovery envelope binding changed');
  requireThat(publicationRecoveryCanonical(read(frozenParams).params.publication_recovery) === publicationRecoveryCanonical(source), 'recovery source differs from frozen params');
  const records = fs.readFileSync(regular(runDir, 'journal.ndjson'), 'utf8').split('\n').slice(0, -1).filter(line => line.trim()).map(line => JSON.parse(line));
  const authorizations = records.filter(event => event.type === 'runRecovered');
  const authorization = authorizations[0], selected = read(frozenRoles);
  requireThat(authorizations.length === 1 && authorization.purpose === 'publication-only' &&
    authorization.sourceRunId === source.sourceRunId && authorization.sourceAttemptId === source.sourceAttemptId &&
    authorization.sourceJournalSha256 === source.files.journal.sha256 && authorization.sourceBundleSha256 === sourceBundleSha256 &&
    ['developer', 'regression'].every(role => selected[role].bot === source.roles[role] && authorization.roles[role] === source.roles[role]),
    'authorized publication recovery record missing or mismatched');
  requireThat(envelope.runId !== source.sourceRunId && source.verificationToolsSha256 === digest(self), 'recovery execution identity or tools changed');
  const sourceRoot = fs.realpathSync(source.sourceRunDir);
  function sourceFile(name) {
    const file = source.files[name];
    requireThat(object(file) && path.isAbsolute(file.path) && !fs.lstatSync(file.path).isSymbolicLink() && fs.statSync(file.path).isFile(), 'invalid recovery source file: ' + name);
    const actual = fs.realpathSync(file.path);
    requireThat(actual.startsWith(sourceRoot + path.sep) && digest(actual) === file.sha256, 'recovery source changed: ' + name);
    return actual;
  }
  for (const key of Object.keys(source.files)) sourceFile(key);
  const previousEnvelope = read(sourceFile('envelope'));
  requireThat(previousEnvelope.runId === source.sourceRunId &&
    ['larkAppId', 'ownerOpenId', 'chatId'].every(key => previousEnvelope.chatBinding[key] === envelope.chatBinding[key]), 'recovery source belongs to another actor or chat');
  const binding = { executionRunId: envelope.runId, sourceRunId: source.sourceRunId,
    sourceToolsSha256: source.files.tools.sha256, sourceBundleSha256 };
  const planned = { context: sourceFile('context'), release: sourceFile('release'), plan: sourceFile('plan') };
  if (node === 'verify-publication') {
    requireThat(fs.realpathSync(self) === fs.realpathSync(regular(output, 'tools.mjs')), 'recovery must use the bootstrapped fixed tool');
    const observed = regular(output, 'observed-pr.json'), publication = read(sourceFile('publication'));
    requireThat(read(observed).url === publication.url, 'recovery observed another published PR');
    const comment = read(planned.plan).action === 'comment';
    verifyPublication({ ...planned, route: sourceFile('route'), observed,
      ...(comment ? { 'observed-comment': regular(output, 'observed-comment.md') } : {}), out: path.join(output, 'verification.json') }, binding);
    publish({ entries: [['verification', 'json', 'verification.json'], ['observed-pr', 'json', 'observed-pr.json'], ['tools', 'text', 'tools.mjs'],
      ...(comment ? [['observed-comment', 'markdown', 'observed-comment.md']] : [])] });
  } else {
    requireThat(fs.realpathSync(input('verify-publication', 'tools')) === fs.realpathSync(self), 'completion must use the verified recovery tool');
    const adaptedInput = (from, name, optional = false) => from === 'development-review-loop' && name === 'gate-result' ? sourceFile('gate') : input(from, name, optional);
    completeStage(planned, adaptedInput, output, binding);
  }
}
`;
