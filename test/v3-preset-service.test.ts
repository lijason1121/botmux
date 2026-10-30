import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotConfig } from '../src/bot-registry.js';
import { createPresetSavedWorkflow } from '../src/workflows/v3/preset-service.js';
import { instantiatePublishedSavedWorkflow, loadVisibleSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { appendSavedWorkflowRevision, workflowLibraryRoot } from '../src/workflows/v3/library-store.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { validateSavedWorkflowRevisionDraft } from '../src/workflows/v3/library-schema.js';
import { DEVELOPMENT_REVIEW_ROLE_CONTEXT_JSON } from '../src/workflows/v3/presets/development-review.js';
import { renderSavedWorkflowRoleText } from '../src/workflows/v3/workflow-roles.js';

const context = { actor: { larkAppId: 'cli_coordinator', openId: 'ou_owner' }, chatId: 'oc_here', rootMessageId: 'om_here' };
const bots = [
  { larkAppId: 'cli_dev', name: 'Developer', cliId: 'codex', workingDir: '/workspace' },
  { larkAppId: 'cli_correct', name: 'Correctness', cliId: 'claude-code', workingDir: '/workspace' },
  { larkAppId: 'cli_regress', name: 'Regression', cliId: 'minimax', workingDir: '/workspace' },
  { larkAppId: 'cli_alternate', name: 'Alternate', cliId: 'codex', workingDir: '/workspace' },
] as BotConfig[];
const roleSelections = { developer: 'Developer', correctness: 'Correctness', regression: 'Regression' };
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'wf-preset-service-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

const create = (extra: Partial<Parameters<typeof createPresetSavedWorkflow>[0]> = {}) =>
  createPresetSavedWorkflow({ dataDir, context, presetId: 'development-review', bots, roleSelections, ...extra });

describe('reviewed preset creation', () => {
  it('keeps the fixed preparation JSON valid for bot display names containing quotes', () => {
    const selected = Object.fromEntries(['developer', 'correctness', 'regression'].map(name => [name, {
      bot: `cli_${name}`, label: 'Bot "quoted" \\ name', cliId: 'codex' as const, nodes: ['work'],
    }]));
    const decoded = JSON.parse(renderSavedWorkflowRoleText(DEVELOPMENT_REVIEW_ROLE_CONTEXT_JSON, selected));
    expect(decoded.correctness).toEqual({ bot: 'cli_correctness', label: 'cli_correctness', cliId: 'codex' });
  });
  it('creates an executable authored definition without a source run or fabricated journal', async () => {
    const result = await create();
    expect(result).toMatchObject({ created: true, origin: 'authored_preset', metadata: {
      status: 'active', owner: context.actor, scope: { kind: 'chat', chatId: 'oc_here' },
    } });
    const loaded = await loadVisibleSavedWorkflow({ dataDir, context, ref: result.metadata.workflowId });
    expect(loaded.revision.payload.sourceRunId).toBeUndefined();
    expect(loaded.revision.payload.roles?.correctness.defaultBot).toBe('cli_correct');
    expect(loaded.revision.payload.inputs.repo_path?.required).toBe(true);
    expect(loaded.revision.payload.inputs.requirement?.required).toBe(true);
    expect(existsSync(join(dataDir, 'v3-runs'))).toBe(false);
  });

  it('concurrent retries return the same definition and do not overwrite different choices', async () => {
    const [one, two] = await Promise.all([create(), create()]);
    expect(one.metadata.workflowId).toBe(two.metadata.workflowId);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(readdirSync(workflowLibraryRoot(dataDir)).filter(x => x.startsWith('wf_'))).toHaveLength(1);
    await expect(create({ roleSelections: { ...roleSelections, developer: 'Alternate' } })).rejects.toThrow(/different definition/);
    const saved = await loadVisibleSavedWorkflow({ dataDir, context, ref: one.metadata.workflowId });
    expect(saved.revision.payload.roles?.developer.defaultBot).toBe('cli_dev');
  });

  it('does not upgrade or overwrite a customized owned workflow', async () => {
    const saved = await create();
    const { workflowId: _id, humanVersion: _version, createdAt: _at, createdBy: _by, ...draft } = saved.revision.payload;
    draft.dagTemplate.nodes[0]!.goal += '\nCustom requirement policy';
    const custom = await appendSavedWorkflowRevision(dataDir, saved.metadata.workflowId, {
      actor: context.actor, revision: draft, publish: true, expectedLatestRevision: saved.metadata.latestRevision,
    });
    await expect(create()).rejects.toThrow(/different definition/);
    const after = await loadVisibleSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId });
    expect(after.metadata.latestRevision).toBe(custom.metadata.latestRevision);
  });

  it.each([
    { presetId: 'arbitrary-template' },
    { context: { ...context, chatId: '' } },
    { context: { ...context, actor: { larkAppId: 'cli_coordinator', openId: '' } } },
    { roleSelections: { developer: 'Developer', correctness: 'Correctness' } },
    { roleSelections: { ...roleSelections, unexpected: 'Alternate' } },
    { roleSelections: { ...roleSelections, regression: 'Correctness' } },
    { roleSelections: { ...roleSelections, developer: 'Missing' } },
  ])('rejects invalid creation before creating library storage: %j', async input => {
    await expect(create(input)).rejects.toThrow();
    expect(existsSync(workflowLibraryRoot(dataDir))).toBe(false);
  });

  it('new tasks get their own inputs and frozen role choices without starting external work', async () => {
    const saved = await create();
    const runs = join(dataDir, 'test-runs');
    const repo = join(dataDir, 'new-repo'); mkdirSync(repo);
    const rawParams = {
      mode: { kind: 'string' as const, value: 'new' },
      repo_path: { kind: 'string' as const, value: repo },
      requirement: { kind: 'string' as const, value: 'Implement a new task' },
      target_branch: { kind: 'string' as const, value: 'main' },
      validation_commands: { kind: 'json' as const, value: [{ id: 'runtime', argv: ['node', '--version'] }] },
    };
    const run = await instantiatePublishedSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId,
      bots, baseDir: runs, runId: 'preset-fixture', rawParams,
      roleSelections: { correctness: 'Alternate' } });
    expect(run.resolvedRoles?.correctness.bot).toBe('cli_alternate');
    expect([...run.botSnapshots.values()].every(bot => bot.workingDir === realpathSync(repo))).toBe(true);
    expect(run.resolvedParams.requirement).toBe('Implement a new task');
    expect(existsSync(join(run.runDir, 'journal.ndjson'))).toBe(false);
    expect(loadAuthorizedV3Run(run.runDir).envelope.source.kind).toBe('saved_definition');
    const unchanged = await loadVisibleSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId });
    expect(unchanged.revision.payload.roles?.correctness.defaultBot).toBe('cli_correct');
    await expect(instantiatePublishedSavedWorkflow({ dataDir,
      context: { ...context, actor: { ...context.actor, openId: 'ou_other' } },
      ref: saved.metadata.workflowId, bots, baseDir: runs, rawParams,
      roleSelections: { developer: 'Alternate' } })).rejects.toThrow(/owner/i);
    await expect(loadVisibleSavedWorkflow({ dataDir, ref: saved.metadata.workflowId,
      context: { ...context, actor: { ...context.actor, larkAppId: 'cli_elsewhere' } } })).rejects.toThrow();
  });

  it('rejects role collisions and missing workspaces before publishing a run directory', async () => {
    const saved = await create();
    const baseDir = join(dataDir, 'not-published');
    const params = { mode: { kind: 'string' as const, value: 'new' }, repo_path: { kind: 'string' as const, value: join(dataDir, 'missing') },
      requirement: { kind: 'string' as const, value: 'New task' }, target_branch: { kind: 'string' as const, value: 'main' },
      validation_commands: { kind: 'json' as const, value: [{ id: 'runtime', argv: ['node', '--version'] }] } };
    await expect(instantiatePublishedSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId,
      bots, baseDir, rawParams: params, roleSelections: { correctness: 'Developer' } })).rejects.toThrow(/distinct/);
    await expect(instantiatePublishedSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId,
      bots, baseDir, rawParams: params })).rejects.toThrow(/ENOENT/);
    expect(existsSync(baseDir)).toBe(false);
  });

  it('validates execution constraints against the actual declared inputs and roles', async () => {
    const saved = await create();
    const { workflowId: _id, humanVersion: _v, createdAt: _at, createdBy: _by, ...draft } = saved.revision.payload;
    for (const execution of [{ workingDirectoryParam: 'missing' }, { workingDirectoryParam: 'validation_commands' },
      { distinctRoles: ['developer', 'missing'] }, { distinctRoles: ['developer', 'developer'] },
      { distinctRoles: [] }, { unrelatedPolicy: true }]) {
      expect(() => validateSavedWorkflowRevisionDraft({ ...draft, execution })).toThrow(/execution/);
    }
  });
});
