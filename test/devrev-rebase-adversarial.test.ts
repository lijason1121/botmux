import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import {
  commitSavedWorkflowRunInPlace, compileDashboardSavedWorkflowFromRun, compileSavedWorkflowFromRun,
  materializeSavedWorkflowRun, savedWorkflowRunFlow,
} from '../src/workflows/v3/library-materialize.js';
import { computeSavedWorkflowGateDigest, computeSavedWorkflowSideEffects, validateDagTemplate } from '../src/workflows/v3/library-schema.js';
import { artifactRef, loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { loadEffectiveV3Dag, v3RevisionDigest, v3RevisionFilePaths } from '../src/workflows/v3/dag-revision.js';
import { persistV3StartIntent } from '../src/workflows/v3/start-intent.js';
import { V3ProgressCardManager, type V3ProgressCardTransport } from '../src/im/lark/v3-progress-card-manager.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { validateSpec } from '../src/workflows/v3/spec.js';

const roots: string[] = [];
const owner = { openId: 'ou_owner', larkAppId: 'cli_dev' };
const binding = { larkAppId: owner.larkAppId, ownerOpenId: owner.openId, chatId: 'oc_probe', rootMessageId: 'om_probe' };
const bots = [{ larkAppId: 'cli_dev', name: 'Developer', cliId: 'codex', workingDir: '/probe' }] as BotConfig[];
const json = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T01:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function roleFixture(markers = true, executionWorkspace = false, independentRoles = false) {
  const root = mkdtempSync(join(tmpdir(), 'devrev-rebase-review-')); roots.push(root);
  const goal = markers ? '${roles.developer.label} inspects the candidate' : 'Inspect the candidate';
  const dagTemplate = validateDagTemplate({ schemaVersion: 2, nodes: [
    { id: 'inspect', type: 'goal', goal, bot: 'cli_dev', depends: [], inputs: [] },
    ...(independentRoles ? [{ id: 'review', type: 'goal', goal: 'Review independently', bot: 'cli_dev', depends: [], inputs: [] }] : []),
  ] });
  const saved = await createSavedWorkflow(join(root, 'library'), {
    displayName: 'Role probe', owner, scope: { kind: 'global' }, publish: true,
    revision: {
      roles: { developer: { nodes: ['inspect'], defaultBot: 'cli_dev' },
        ...(independentRoles ? { reviewer: { nodes: ['review'], defaultBot: 'cli_dev' } } : {}) },
      inputs: executionWorkspace ? { repo_path: { type: 'string', default: root } } : {},
      ...(executionWorkspace || independentRoles ? { execution: {
        ...(executionWorkspace ? { workingDirectoryParam: 'repo_path' } : {}),
        ...(independentRoles ? { distinctRoleGroups: [['developer', 'reviewer']] } : {}),
      } } : {}),
      contextRefs: [], specStatus: 'current', dagTemplate,
      specTemplate: { schemaVersion: 1, title: 'Role probe', requirement: 'Inspect the candidate', nodes: [
        { sketchId: 'inspect', goal: 'Inspect the candidate', input_needs: [], expected_outputs: ['report'], acceptance: 'Evidence recorded', risk_gate: false, unknowns: [] },
      ] },
      safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: computeSavedWorkflowSideEffects(dagTemplate) },
    },
  });
  return { root, saved };
}

function preparedDashboardCommit(f: Awaited<ReturnType<typeof roleFixture>>) {
  const runId = 'dashboard-role', runDir = join(f.root, runId);
  mkdirSync(runDir);
  const flow = savedWorkflowRunFlow(f.saved.revision, runId, bots);
  json(join(runDir, 'dag.json'), flow.dag);
  json(join(runDir, 'spec.json'), flow.spec);
  return {
    ...f.saved, runDir, rawParams: {}, bots, chatBinding: binding,
    initiator: { openId: owner.openId, source: 'dashboard-local' as const },
    expected: { dagSha256: artifactRef(runDir, 'dag.json').sha256, specSha256: artifactRef(runDir, 'spec.json').sha256 },
  };
}

describe('rebase integration: saved roles meet Dashboard flow semantics', () => {
  it('commits a role template through Dashboard using the same frozen role narrative as direct execution', async () => {
    const f = await roleFixture(true, true);
    const direct = materializeSavedWorkflowRun({ ...f.saved, bots, baseDir: join(f.root, 'runs'), runId: 'direct', context: { chatBinding: binding } });
    expect(direct.dag.nodes[0]?.goal).toBe('Developer inspects the candidate');
    const input = preparedDashboardCommit(f);
    commitSavedWorkflowRunInPlace(input);
    const loaded = loadAuthorizedV3Run(input.runDir);
    expect(loaded.dag.nodes[0]?.goal).toBe(direct.dag.nodes[0]?.goal);
    expect(loaded.resolvedRoles).toEqual(direct.resolvedRoles);
    expect(loaded.botSnapshots).toMatchObject({ cli_dev: { workingDir: f.root } });
  });

  it('replays a committed role run after losing the Dashboard record without publishing an unloadable run', async () => {
    const f = await roleFixture(false);
    const input = preparedDashboardCommit(f);
    const first = commitSavedWorkflowRunInPlace(input);
    const bytes = readFileSync(join(input.runDir, 'run.json'), 'utf8');
    // The run commit survived; the caller's draft record and acknowledgement
    // did not. A later retry must validate only these frozen artifacts.
    vi.setSystemTime(new Date('2026-11-07T02:00:00Z'));
    const replay = commitSavedWorkflowRunInPlace(input);
    expect(replay).toEqual(first);
    expect(readFileSync(join(input.runDir, 'run.json'), 'utf8')).toBe(bytes);
    expect(loadAuthorizedV3Run(input.runDir).resolvedRoles).toMatchObject({ developer: { bot: 'cli_dev' } });
  });

  it.each(['update', 'add'] as const)('saves the effective human-edited goal and instructions of a role run: %s', async mode => {
    const f = await roleFixture();
    const run = materializeSavedWorkflowRun({ ...f.saved, bots, baseDir: join(f.root, 'runs'), runId: 'revised-role', context: { chatBinding: binding } });
    const journal = join(run.runDir, 'journal.ndjson');
    persistV3StartIntent(run.runId, run.runDir);
    const revisedGoal = 'Inspect the amended authorization boundary';
    const revisedInstructions = 'Require evidence for the amended boundary';
    const dag = structuredClone(run.dag);
    const target = mode === 'add'
      ? { ...structuredClone(dag.nodes[0]!), id: 'additional', goal: revisedGoal, override: { systemPromptAppend: revisedInstructions } }
      : dag.nodes[0]!;
    target.goal = revisedGoal;
    target.override = { systemPromptAppend: revisedInstructions };
    if (mode === 'add') dag.nodes.push(target);
    const paths = v3RevisionFilePaths(run.runDir, 2);
    mkdirSync(join(run.runDir, 'dag-revisions'));
    json(paths.dag, dag);
    json(paths.patch, { by: owner.openId, ops: [mode === 'add' ? { op: 'addNode', node: target }
      : { op: 'updateNode', nodeId: target.id, set: { goal: revisedGoal, override: target.override } }] });
    const event = { revision: 2, baseRevision: 1, sha256: v3RevisionDigest(readFileSync(paths.dag)),
      patchSha256: v3RevisionDigest(readFileSync(paths.patch)), summary: 'Change inspection scope', by: owner.openId };
    appendEvent(journal, { type: 'dagRevisionProposed', ...event, reasons: ['scope changed'], touched: [target.id] });
    appendEvent(journal, { type: 'dagRevised', ...event, approval: { by: owner.openId, proposedBy: owner.openId } });
    appendEvent(journal, { type: 'runSucceeded' });
    expect(loadEffectiveV3Dag(run.runDir, run.dag, readJournal(journal)).dag.nodes.find(node => node.id === target.id)?.goal).toBe(revisedGoal);
    for (const compile of [compileDashboardSavedWorkflowFromRun, compileSavedWorkflowFromRun]) {
      const saved = compile(run.runDir);
      expect(saved.runtimeRevisions).toBe(1);
      expect(saved.revision.dagTemplate.nodes.find(node => node.id === target.id)?.goal, compile.name).toBe(revisedGoal);
      expect(saved.revision.dagTemplate.nodes.find(node => node.id === target.id)?.override?.systemPromptAppend, compile.name).toBe(revisedInstructions);
    }
  });

  it('keeps one executor-stamped start across repeated requests after a persisted recovery marker', async () => {
    const f = await roleFixture(false);
    const run = materializeSavedWorkflowRun({ ...f.saved, bots, baseDir: join(f.root, 'runs'), runId: 'recover-role', context: { chatBinding: binding }, nodeExecutor: 'bot' });
    const journal = join(run.runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'runRecovered', sourceRunId: 'source', sourceAttemptId: 'inspect/attempts/001', sourceJournalSha256: 'sha256:source', previousRoles: { developer: 'cli_old' }, roles: { developer: 'cli_dev' } });
    await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => persistV3StartIntent(run.runId, run.runDir))));
    expect(readJournal(journal).filter(event => event.type === 'runRecovered')).toHaveLength(1);
    expect(readJournal(journal).filter(event => event.type === 'runStarted')).toMatchObject([{ runId: run.runId, nodeExecutor: 'bot' }]);
  });

  it('rejects aliased independent roles before committing a legacy prepared Dashboard draft', async () => {
    const f = await roleFixture(false, false, true);
    const runId = 'independent-role', runDir = join(f.root, runId);
    mkdirSync(runDir);
    // This is the prepared representation the pre-integration Dashboard
    // emitted: valid DAG/spec, before checking execution-role constraints.
    json(join(runDir, 'dag.json'), validateDag({ ...f.saved.revision.payload.dagTemplate, runId }));
    json(join(runDir, 'spec.json'), validateSpec({ ...f.saved.revision.payload.specTemplate, runId }));
    const input = { ...f.saved, runDir, rawParams: {}, bots, chatBinding: binding,
      initiator: { openId: owner.openId, source: 'dashboard-local' as const },
      expected: { dagSha256: artifactRef(runDir, 'dag.json').sha256, specSha256: artifactRef(runDir, 'spec.json').sha256 } };
    expect(() => commitSavedWorkflowRunInPlace(input)).toThrow(/distinct bots/);
    expect(existsSync(join(runDir, 'run.json'))).toBe(false);
    expect(existsSync(join(runDir, 'bots.snapshot.json'))).toBe(false);
  });

  it('coalesces polling during an unresolved failure notice and reuses its durable key after a retry', async () => {
    const f = await roleFixture(false);
    const run = materializeSavedWorkflowRun({ ...f.saved, bots, baseDir: join(f.root, 'runs'), runId: 'notice-role', context: { chatBinding: binding } });
    const journal = join(run.runDir, 'journal.ndjson');
    persistV3StartIntent(run.runId, run.runDir);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const transport: V3ProgressCardTransport = { reply: vi.fn(async () => 'om_progress'), send: vi.fn(async () => 'om_progress'), patch: vi.fn(async () => {}) };
    const options = { baseDir: join(f.root, 'runs'), transport, pollIntervalMs: 1000, buildCard: () => '{}', now: () => new Date() };
    const cards = new V3ProgressCardManager(options);
    const cold = new V3ProgressCardManager(options);
    try {
      cards.observe(run.runId);
      await cards.refresh(run.runId, { allowCreate: true });
      appendEvent(journal, { type: 'runFailed', failedNodeId: 'inspect' });
      let entered!: () => void;
      let failSend!: (reason: Error) => void;
      const sending = new Promise<void>(resolve => { entered = resolve; });
      const transportResult = new Promise<string>((_resolve, reject) => { failSend = reject; });
      vi.mocked(transport.reply).mockImplementationOnce(async () => { entered(); return transportResult; });
      const pending = cards.refresh(run.runId, { allowCreate: true });
      await sending;
      // Several actual poll callbacks race with the same unresolved send.
      await vi.advanceTimersByTimeAsync(5000);
      expect(transport.reply).toHaveBeenCalledTimes(2);
      const firstKey = vi.mocked(transport.reply).mock.calls[1]![3];
      vi.mocked(transport.reply).mockResolvedValueOnce('om_failure');
      failSend(new Error('accepted but receipt unavailable'));
      // Polling leaves one coalesced refresh pending; it retries once after
      // this send settles and may complete before another clock tick.
      expect(await pending).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await cards.refresh(run.runId, { allowCreate: true });
      expect(transport.reply).toHaveBeenCalledTimes(3);
      expect(vi.mocked(transport.reply).mock.calls[2]![3]).toBe(firstKey);
      cards.close();
      await cold.coldAttach(owner.larkAppId);
      await vi.advanceTimersByTimeAsync(5000);
      expect(transport.reply).toHaveBeenCalledTimes(3);
    } finally { cards.close(); cold.close(); }
  });
});
