import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BotConfig } from '../../bot-registry.js';
import type { RawParamInput } from '../shared/params.js';
import { resolveBotConfig } from './bot-resolve.js';
import { openV3WorkerAttempts } from './attempt-ledger.js';
import { openV3HostEffects } from './host-effect-ledger.js';
import { loadAuthorizedV3Run } from './run-envelope.js';
import { readJournal, appendEventDurable } from './journal.js';
import { materialize } from './state.js';
import { isValidRunId } from './ops-projection.js';
import { readAndValidateManifest } from './manifest.js';
import { instantiatePublishedSavedWorkflow, requireActorContext, type SavedWorkflowActorContext } from './library-service.js';
import { ensureDevelopmentReviewPreset, DEV_REV_ROLES } from './dev-rev-launch.js';
import { upgradeDevelopmentReviewPreset } from './presets/development-review-upgrade.js';
import { createDevelopmentReviewPreset, type DevelopmentReviewDefaultBots } from './presets/development-review.js';
import { canonicalJsonStringify, type SavedWorkflowRevisionDraft } from './library-schema.js';
import type { ResolvedSavedWorkflowRoles } from './workflow-roles.js';
import { withFileLock } from '../../utils/file-lock.js';

const digest = (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
const requireThat = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };

/** Explicit owner-authorized fork from a quiescent development run. Reuse a
 * verified clean candidate, never old approvals, role identities or side effects. */
export async function recoverDevelopmentReviewRun(input: {
  dataDir: string; baseDir: string; sourceRunId: string; runId?: string;
  context: SavedWorkflowActorContext; bots: BotConfig[]; roleSelections?: Record<string, string>;
}) {
  const context = requireActorContext(input.context, { requireChat: true });
  requireThat(isValidRunId(input.sourceRunId), 'invalid recovery source runId');
  const runDir = join(input.baseDir, input.sourceRunId);
  const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: input.sourceRunId, allowedSources: ['saved_definition'] });
  const binding = loaded.envelope.chatBinding;
  requireThat(binding?.larkAppId === context.actor.larkAppId && binding?.ownerOpenId === context.actor.openId
    && binding?.chatId === context.chatId, 'recovery source belongs to another actor or chat');
  const events = readJournal(join(runDir, 'journal.ndjson')), state = materialize(events);
  requireThat(state.runStatus === 'failed' || state.runStatus === 'cancelled',
    'recovery requires a failed or cancelled run; retry a blocked node or cancel the old run before changing roles');
  requireThat(!openV3WorkerAttempts(events).length && !openV3HostEffects(events).length, 'recovery source workers/effects are not quiescent');
  requireThat(!events.some(e => e.type === 'nodeDispatched' && ['create-mr', 'publish-direct'].includes(e.nodeId)),
    'recovery cannot replay a run that started publication; reconcile its external outcome first');

  const snapshot = loaded.definitionSnapshot as { definition: Record<string, unknown> };
  // The materializer's definition snapshot is the payload itself, not a live
  // library lookup: recognize complete known presets, never just node names.
  const { workflowId: _id, humanVersion: _version, createdAt: _at, createdBy: _by, ...draft } = snapshot.definition;
  const roles = loaded.resolvedRoles as ResolvedSavedWorkflowRoles;
  const defaults = Object.fromEntries(DEV_REV_ROLES.map(role => [role,
    (draft.roles as SavedWorkflowRevisionDraft['roles'])?.[role]?.defaultBot]));
  requireThat(DEV_REV_ROLES.every(role => typeof defaults[role] === 'string' && roles?.[role]?.bot), 'source has no development role bindings');
  requireThat(upgradeDevelopmentReviewPreset(draft as unknown as SavedWorkflowRevisionDraft)
    || canonicalJsonStringify(draft) === canonicalJsonStringify(createDevelopmentReviewPreset(defaults as unknown as DevelopmentReviewDefaultBots)),
  'recovery supports only complete built-in development-review presets');
  requireThat(Object.keys(input.roleSelections ?? {}).every(role => DEV_REV_ROLES.some(expected => role === expected)), 'unknown recovery role');
  const selected = Object.fromEntries(DEV_REV_ROLES.map(role => [role,
    resolveBotConfig(input.roleSelections?.[role] ?? roles[role]!.bot, input.bots).larkAppId]));
  requireThat(new Set(Object.values(selected)).size === 3, 'developer and reviewers must remain independent');

  const success = (node: string | RegExp) => [...events].reverse().find(e => e.type === 'nodeSucceeded'
    && (typeof node === 'string' ? e.nodeId === node : node.test(e.nodeId)));
  const prepared = success('prepare'), implemented = success(/^development-review-loop\.i\d{3}\.implement$/);
  requireThat(prepared?.type === 'nodeSucceeded' && implemented?.type === 'nodeSucceeded', 'source has no complete candidate checkpoint');
  if (prepared?.type !== 'nodeSucceeded' || implemented?.type !== 'nodeSucceeded') throw new Error('candidate unavailable');
  const artifact = async (manifestPath: string, name: string) => {
    const output = join(dirname(manifestPath), 'work');
    const manifest = await readAndValidateManifest(manifestPath, output);
    requireThat(manifest.status === 'ok', 'source artifact is incomplete');
    const file = manifest.files.find(f => f.path === name);
    requireThat(file?.kind === 'json', 'source artifact missing: ' + name);
    return join(output, file!.path);
  };
  const contextPath = await artifact(prepared.manifestPath, 'context.json');
  const candidatePath = await artifact(implemented.manifestPath, 'candidate.json');
  const prior = JSON.parse(readFileSync(contextPath, 'utf8')), candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
  requireThat(candidate.runId === input.sourceRunId && prior.runId === input.sourceRunId
    && candidate.contextSha256 === digest(contextPath) && candidate.repo === prior.repo && candidate.baseSha === prior.baseSha,
  'candidate/context provenance mismatch');
  const git = (...args: string[]) => execFileSync('git', ['-C', prior.worktree, ...args], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  requireThat(git('rev-parse', 'HEAD') === candidate.headSha && !git('status', '--porcelain'), 'candidate worktree changed; preserve or commit remaining work first');
  requireThat(realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')) === realpathSync(execFileSync('git',
    ['-C', prior.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000 }).trim()), 'candidate repository changed');
  const recovery = { sourceRunId: input.sourceRunId, sourceAttemptId: implemented.attemptId, contextPath, candidatePath,
    contextSha256: digest(contextPath), candidateSha256: digest(candidatePath), journalPath: join(runDir, 'journal.ndjson'),
    journalSha256: digest(join(runDir, 'journal.ndjson')) };
  const params = (loaded.resolvedParams as { params: Record<string, unknown> }).params;
  const rawParams: Record<string, RawParamInput> = Object.fromEntries(Object.entries({ ...params, recovery_source: recovery })
    .map(([key, value]) => [key, { kind: 'json' as const, value }]));
  const recoveryKey = createHash('sha256').update(canonicalJsonStringify({ recovery, selected, actor: context.actor })).digest('hex');
  const runId = input.runId ?? `recover-${input.sourceRunId.slice(0, 60)}-${recoveryKey.slice(0, 16)}`;
  requireThat(isValidRunId(runId) && runId !== input.sourceRunId, 'invalid recovery runId');
  return withFileLock(join(input.baseDir, `.recover-${runId}`), async () => {
    const nextDir = join(input.baseDir, runId);
    let run: { runId: string; runDir: string; resolvedRoles?: ResolvedSavedWorkflowRoles; resolvedParams: Record<string, unknown> };
    if (existsSync(nextDir)) {
      const existing = loadAuthorizedV3Run(nextDir, { expectedRunId: runId, allowedSources: ['saved_definition'] });
      const existingRoles = existing.resolvedRoles as ResolvedSavedWorkflowRoles;
      const existingParams = (existing.resolvedParams as { params: Record<string, unknown> }).params;
      requireThat(existing.envelope.chatBinding?.larkAppId === context.actor.larkAppId
        && existing.envelope.chatBinding?.ownerOpenId === context.actor.openId && existing.envelope.chatBinding?.chatId === context.chatId
        && canonicalJsonStringify(existingParams) === canonicalJsonStringify({ ...params, recovery_source: recovery })
        && DEV_REV_ROLES.every(role => existingRoles[role]?.bot === selected[role]), 'recovery runId is already bound to another request');
      run = { runId, runDir: nextDir, resolvedRoles: existingRoles, resolvedParams: existingParams };
    } else {
      const saved = await ensureDevelopmentReviewPreset(input.dataDir, context, selected);
      run = await instantiatePublishedSavedWorkflow({ dataDir: input.dataDir, baseDir: input.baseDir,
        ref: saved.metadata.workflowId, context, bots: input.bots, roleSelections: selected, rawParams, runId });
    }
    if (!readJournal(join(run.runDir, 'journal.ndjson')).some(e => e.type === 'runRecovered')) {
      appendEventDurable(join(run.runDir, 'journal.ndjson'), { type: 'runRecovered', sourceRunId: input.sourceRunId,
        sourceAttemptId: implemented.attemptId, sourceJournalSha256: recovery.journalSha256,
        previousRoles: Object.fromEntries(DEV_REV_ROLES.map(role => [role, roles[role]!.bot])), roles: selected });
    }
    return run;
  });
}
