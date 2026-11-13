import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { BotConfig } from '../../bot-registry.js';
import { withFileLock } from '../../utils/file-lock.js';
import { resolveBotConfig } from './bot-resolve.js';
import { openV3WorkerAttempts } from './attempt-ledger.js';
import { openV3ExternalAttempts } from './external-attempt-ledger.js';
import { openV3HostEffects } from './host-effect-ledger.js';
import { loadAuthorizedV3Run } from './run-envelope.js';
import { appendEventDurable, readJournal, type StoredEvent } from './journal.js';
import { materialize } from './state.js';
import { isValidRunId } from './ops-projection.js';
import { readAndValidateManifest } from './manifest.js';
import { canonicalJsonStringify, type SavedWorkflowRevisionDraft } from './library-schema.js';
import { createSavedWorkflow, loadCurrentSavedWorkflow, SavedWorkflowNotFoundError } from './library-store.js';
import { instantiatePublishedSavedWorkflow, requireActorContext, type SavedWorkflowActorContext } from './library-service.js';
import { createDevelopmentReviewPreset, type DevelopmentReviewDefaultBots } from './presets/development-review.js';
import { upgradeDevelopmentReviewPreset } from './presets/development-review-upgrade.js';
import { createDevelopmentReviewPublicationRecoveryPreset } from './presets/development-review-publication-recovery.js';
import { DEVELOPMENT_REVIEW_RESOURCES } from './presets/development-review-resources.js';
import type { ResolvedSavedWorkflowRoles } from './workflow-roles.js';

interface SourceFile { path: string; sha256: string }
export interface PublicationRecoverySource {
  schemaVersion: 1; purpose: 'publication-only'; sourceRunId: string; sourceRunDir: string; sourceAttemptId: string;
  publisher: 'create-mr' | 'publish-direct'; roles: { developer: string; regression: string };
  previousRoles: Record<string, string>; verificationToolsSha256: string; files: Record<string, SourceFile>;
}
const digest = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
const hashValue = (value: unknown) => 'sha256:' + createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
function requireThat(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const roleNames = ['developer', 'correctness', 'regression'] as const;
type Success = StoredEvent & Extract<StoredEvent, { type: 'nodeSucceeded' }>;

/** A separate, read-only successor; source evidence and terminal history remain untouched. */
export async function recoverDevelopmentReviewPublicationRun(input: {
  dataDir: string; baseDir: string; sourceRunId: string; runId?: string;
  context: SavedWorkflowActorContext; bots: BotConfig[];
}) {
  const context = requireActorContext(input.context, { requireChat: true });
  requireThat(isValidRunId(input.sourceRunId), 'invalid publication recovery source runId');
  return withFileLock(join(input.baseDir, `.publication-recovery-${input.sourceRunId}`), async () => {
    const sourceRunDir = realpathSync(join(input.baseDir, input.sourceRunId));
    const loaded = loadAuthorizedV3Run(sourceRunDir, { expectedRunId: input.sourceRunId, allowedSources: ['saved_definition'] });
    const binding = loaded.envelope.chatBinding;
    requireThat(binding?.larkAppId === context.actor.larkAppId && binding.ownerOpenId === context.actor.openId && binding.chatId === context.chatId,
      'publication recovery source belongs to another actor or chat');
    const journalPath = join(sourceRunDir, 'journal.ndjson'), events = readJournal(journalPath), state = materialize(events);
    requireThat(state.runStatus === 'failed' && ['verify-publication', 'complete'].includes(state.failedNodeId ?? ''),
      'publication recovery requires a run failed during verification or completion');
    requireThat(!openV3WorkerAttempts(events).length && !openV3ExternalAttempts(events).length && !openV3HostEffects(events).length,
      'publication recovery source workers/effects are not quiescent');
    requireThat(!events.some(event => event.type === 'dagRevised'), 'publication recovery requires the unchanged built-in flow');
    const { workflowId: _id, humanVersion: _version, createdAt: _at, createdBy: _by, ...draft } =
      (loaded.definitionSnapshot as { definition: Record<string, unknown> }).definition;
    const previous = loaded.resolvedRoles as ResolvedSavedWorkflowRoles;
    const defaults = Object.fromEntries(roleNames.map(role => [role, (draft.roles as SavedWorkflowRevisionDraft['roles'])?.[role]?.defaultBot]));
    requireThat(roleNames.every(role => typeof defaults[role] === 'string' && previous?.[role]?.bot), 'source development roles missing');
    requireThat(upgradeDevelopmentReviewPreset(draft as unknown as SavedWorkflowRevisionDraft) || canonicalJsonStringify(draft) ===
      canonicalJsonStringify(createDevelopmentReviewPreset(defaults as unknown as DevelopmentReviewDefaultBots)),
    'publication recovery supports only complete built-in development-review presets');
    const selected = { developer: resolveBotConfig(previous.developer!.bot, input.bots).larkAppId,
      regression: resolveBotConfig(previous.regression!.bot, input.bots).larkAppId };
    requireThat(selected.developer !== selected.regression, 'publication recovery requires an independent reviewer');
    const success = (nodeId: string): Success => {
      const node = state.nodes.get(nodeId), effective = node?.effectiveInstanceId ?? nodeId;
      const event = [...events].reverse().find((event): event is Success => event.type === 'nodeSucceeded' &&
        event.nodeId === nodeId && (event.instanceId ?? event.nodeId) === effective);
      requireThat(node?.status === 'done' && event, 'source node has no current successful artifact: ' + nodeId);
      requireThat(realpathSync(event.manifestPath) === realpathSync(join(sourceRunDir, event.attemptId, 'manifest.json')), 'source manifest is outside its attempt');
      return event;
    };
    const publishers = (['create-mr', 'publish-direct'] as const).filter(node => state.nodes.get(node)?.status === 'done');
    requireThat(publishers.length === 1, 'source must have exactly one successful publication');
    const publisher = publishers[0]!, publicationEvent = success(publisher);
    requireThat(!events.some(event => event.type === 'nodeDispatched' && ['create-mr', 'publish-direct'].includes(event.nodeId) && event.nodeId !== publisher),
      'source dispatched another publication route');
    const files: Record<string, SourceFile> = {};
    const bindFile = (key: string, path: string): string => {
      requireThat(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile(), 'source must be a regular file: ' + key);
      const actual = realpathSync(path);
      requireThat(actual.startsWith(sourceRunDir + sep), 'source artifact escapes run: ' + key);
      files[key] = { path: actual, sha256: digest(actual) }; return actual;
    };
    bindFile('envelope', join(sourceRunDir, 'run.json')); bindFile('journal', journalPath);
    const artifact = async (node: string, name: string, key = name) => {
      const event = success(node), out = join(dirname(event.manifestPath), 'work');
      const manifest = await readAndValidateManifest(event.manifestPath, out);
      requireThat(manifest.status === 'ok', 'source manifest was not successful');
      const file = manifest.files.find(file => file.name === name);
      requireThat(file, 'source artifact missing: ' + node + '/' + name);
      bindFile('manifest:' + node, event.manifestPath);
      return bindFile(key, join(out, file.path));
    };
    const loop = state.loops.get('development-review-loop');
    requireThat(loop?.lastDecision === 'exit' && loop.iteration > 0, 'source review loop did not pass');
    const gateNode = 'development-review-loop.i' + String(loop.iteration).padStart(3, '0') + '.verify-review-gate';
    await artifact('prepare', 'context'); await artifact('prepare', 'resources'); await artifact('prepare', 'tools');
    await artifact(gateNode, 'gate-result', 'gate'); await artifact(gateNode, 'release-candidate', 'release');
    await artifact('prepare-mr', 'delivery-plan', 'plan'); await artifact('check-delivery', 'route');
    await artifact(publisher, 'mr-result', 'publication');
    const prior = read(files.context!.path), release = read(files.release!.path), plan = read(files.plan!.path), route = read(files.route!.path), publication = read(files.publication!.path);
    requireThat(prior.runId === input.sourceRunId && plan.runId === prior.runId && release.gate?.runId === prior.runId && release.passed === true && release.gate?.passed === true,
      'source run/gate binding mismatch');
    requireThat(release.toolsSha256 === files.tools!.sha256 && prior.resourcesSha256 === files.resources!.sha256 &&
      plan.releaseSha256 === files.release!.sha256 && plan.contextSha256 === files.context!.sha256 && route.planSha256 === files.plan!.sha256,
      'source evidence digest binding mismatch');
    const prepareGoal = (draft.dagTemplate as SavedWorkflowRevisionDraft['dagTemplate']).nodes.find(node => node.id === 'prepare')?.goal;
    requireThat(typeof prepareGoal === 'string' && prepareGoal.includes('--expected-tools-sha ' + files.tools!.sha256), 'source fixed tools do not match the authorized preset');
    requireThat(canonicalJsonStringify(read(files.gate!.path)) === canonicalJsonStringify(release.gate) && plan.headSha === release.gate.headSha &&
      plan.baseSha === prior.baseSha && plan.mode === prior.mode && plan.publicationRequired === true && route.publicationRequired === true &&
      route.runId === prior.runId && route.action === plan.action, 'source plan differs from its passed gate and route');
    requireThat(['create', 'update', 'comment'].includes(plan.action) && publication.schemaVersion === 1 &&
      ['action', 'headSha', 'sourceBranch', 'targetBranch'].every(key => publication[key] === plan[key]) &&
      typeof publication.url === 'string' && /^https:\/\//.test(publication.url) && (!plan.existingPr || publication.url === plan.existingPr.url),
      'source publication differs from its plan');
    requireThat(typeof route.approvalRequired === 'boolean' && route.directPublish === !route.approvalRequired &&
      (publisher === 'create-mr' ? route.approvalRequired : route.directPublish && route.identityConfirmed === true && plan.directPublish === true),
      'source publisher differs from the independent route');
    if (publisher === 'create-mr') {
      const gate = [...events].reverse().find(event => event.type === 'gateResolved' && event.nodeId === publisher &&
        (event.instanceId ?? event.nodeId) === (publicationEvent.instanceId ?? publicationEvent.nodeId));
      requireThat(gate?.type === 'gateResolved' && gate.resolution === 'approved' && state.nodes.get(publisher)?.gateCleared,
        'source publication has no effective approval');
    }
    if (plan.action !== 'comment') {
      await artifact(publisher, 'push');
      const pushed = read(files.push!.path);
      requireThat(pushed.runId === prior.runId && pushed.planSha256 === files.plan!.sha256 && pushed.headSha === plan.headSha &&
        pushed.remoteAfter === plan.headSha && pushed.sourceBranch === plan.sourceBranch && pushed.action === plan.action,
        'source push is not bound to the reviewed publication');
    } else requireThat(typeof publication.commentUrl === 'string' && /^https:\/\//.test(publication.commentUrl), 'published comment URL missing');
    for (const key of ['context', 'resources', 'candidate', 'validation', 'change-summary', 'correctness', 'regression', 'independent-validation']) {
      const item = release.artifacts?.[key];
      requireThat(item && typeof item.path === 'string' && digest(bindFile('evidence:' + key, item.path)) === item.sha256, 'source release artifact changed: ' + key);
    }
    requireThat(release.artifacts.context.sha256 === files.context!.sha256 && release.artifacts.resources.sha256 === files.resources!.sha256, 'source release context changed');
    const git = (...args: string[]) => execFileSync('git', ['-C', prior.worktree, ...args], { encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
    requireThat(git('rev-parse', 'HEAD') === plan.headSha && git('branch', '--show-current') === prior.branch && !git('status', '--porcelain'),
      'source candidate is no longer the clean task HEAD');
    const source: PublicationRecoverySource = { schemaVersion: 1, purpose: 'publication-only', sourceRunId: input.sourceRunId, sourceRunDir,
      sourceAttemptId: publicationEvent.attemptId, publisher, roles: selected,
      previousRoles: Object.fromEntries(roleNames.map(role => [role, previous[role]!.bot])), verificationToolsSha256: DEVELOPMENT_REVIEW_RESOURCES[0]!.sha256, files };
    const sourceBundleSha256 = hashValue(source), key = sourceBundleSha256.slice(7);
    const runId = input.runId ?? `publication-${input.sourceRunId.slice(0, 60)}-${key.slice(0, 16)}`;
    requireThat(isValidRunId(runId) && runId !== input.sourceRunId, 'invalid publication recovery runId');
    const rawParams = { repo_path: { kind: 'string' as const, value: prior.repo }, publication_recovery: { kind: 'json' as const, value: source } };
    return withFileLock(join(input.baseDir, `.publication-recovery-target-${runId}`), async () => {
      const runDir = join(input.baseDir, runId), revision = createDevelopmentReviewPublicationRecoveryPreset(selected);
      if (!existsSync(runDir)) {
        // A deterministic private definition makes a crash before materialization replayable.
        const workflowId = 'wf_' + createHash('sha256').update(canonicalJsonStringify([context.actor, context.chatId, revision])).digest('hex').slice(0, 32);
        const saved = await withFileLock(join(input.dataDir, '.publication-recovery-definition-' + workflowId), async () => {
          try { return await loadCurrentSavedWorkflow(input.dataDir, workflowId, { requireActive: true, revision: 'published' }); }
          catch (error) {
            if (!(error instanceof SavedWorkflowNotFoundError)) throw error;
            return createSavedWorkflow(input.dataDir, { workflowId, displayName: '已发布结果收尾恢复', owner: context.actor,
              scope: { kind: 'chat', chatId: context.chatId! }, revision });
          }
        });
        const { workflowId: _wid, humanVersion: _v, createdAt: _date, createdBy: _creator, ...savedDraft } = saved.revision.payload;
        requireThat(canonicalJsonStringify(savedDraft) === canonicalJsonStringify(revision), 'publication recovery definition changed');
        await instantiatePublishedSavedWorkflow({ dataDir: input.dataDir, baseDir: input.baseDir, runId, ref: workflowId, context, bots: input.bots, rawParams });
      }
      const recovered = loadAuthorizedV3Run(runDir, { expectedRunId: runId, allowedSources: ['saved_definition'] });
      const recoveredParams = (recovered.resolvedParams as { params: Record<string, unknown> }).params;
      const recoveredRoles = recovered.resolvedRoles as ResolvedSavedWorkflowRoles;
      const { workflowId: _wid, humanVersion: _v, createdAt: _date, createdBy: _creator, ...recoveredDraft } =
        (recovered.definitionSnapshot as { definition: Record<string, unknown> }).definition;
      requireThat(recovered.envelope.chatBinding?.larkAppId === context.actor.larkAppId && recovered.envelope.chatBinding?.ownerOpenId === context.actor.openId &&
        recovered.envelope.chatBinding?.chatId === context.chatId && recoveredParams.repo_path === prior.repo &&
        hashValue(recoveredParams.publication_recovery) === sourceBundleSha256 && canonicalJsonStringify(recoveredDraft) === canonicalJsonStringify(revision) &&
        recoveredRoles.developer?.bot === selected.developer && recoveredRoles.regression?.bot === selected.regression,
        'publication recovery runId is bound to another request');
      requireThat(Object.values(files).every(file => digest(file.path) === file.sha256), 'source changed while creating publication recovery');
      const nextJournal = join(runDir, 'journal.ndjson'), nextEvents = readJournal(nextJournal);
      const markers = nextEvents.filter(event => event.type === 'runRecovered');
      if (!markers.length) {
        requireThat(nextEvents.length === 0, 'publication recovery started without host provenance');
        appendEventDurable(nextJournal, { type: 'runRecovered', purpose: 'publication-only', sourceRunId: input.sourceRunId,
          sourceAttemptId: publicationEvent.attemptId, sourceJournalSha256: files.journal!.sha256, sourceBundleSha256,
          previousRoles: source.previousRoles, roles: selected });
      } else requireThat(markers.length === 1 && markers[0]!.purpose === 'publication-only' && markers[0]!.sourceBundleSha256 === sourceBundleSha256,
        'publication recovery provenance mismatch');
      return { runId, runDir, resolvedRoles: recoveredRoles, resolvedParams: recoveredParams, sourceBundleSha256 };
    });
  });
}
