/** Fixture agents exercise the production scheduler and artifact validators;
 * these runs never execute repository commands or create external PRs. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotConfig } from '../src/bot-registry.js';
import { GOAL_ENV, type GoalInputs, type Manifest, type RunNode, type ValidateManifest } from '../src/workflows/v3/contract.js';
import { isLoopNode } from '../src/workflows/v3/dag.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { createPresetSavedWorkflow } from '../src/workflows/v3/preset-service.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { compileSavedWorkflowFromRun } from '../src/workflows/v3/library-materialize.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dev-review-runtime-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const validateManifest: ValidateManifest = async (path, outputDir) => {
  try { return { ok: true, manifest: await readAndValidateManifest(path, outputDir) }; }
  catch (error) { return { ok: false, problems: [String(error)] }; }
};

async function fixture(mode: 'repair' | 'reject' | 'auth') {
  const context = { actor: { larkAppId: 'cli_dev', openId: 'ou_owner' }, chatId: 'oc_fixture' };
  const bots = [
    { larkAppId: 'cli_dev', cliId: 'codex', workingDir: root },
    { larkAppId: 'cli_check', cliId: 'claude-code', workingDir: root },
    { larkAppId: 'cli_regress', cliId: 'minimax', workingDir: root },
    { larkAppId: 'cli_alternate', cliId: 'codex', workingDir: root },
  ] as BotConfig[];
  const saved = await createPresetSavedWorkflow({ dataDir: root, context, presetId: 'development-review', bots,
    roleSelections: { developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regress' } });
  const baseDir = join(root, 'runs');
  const run = await instantiatePublishedSavedWorkflow({ dataDir: root, context, ref: saved.metadata.workflowId,
    bots, baseDir, runId: `fixture-${mode}`, roleSelections: { correctness: 'cli_alternate' },
    rawParams: { repo_path: { kind: 'string', value: root }, requirement: { kind: 'string', value: 'Fixture task' },
      target_branch: { kind: 'string', value: 'main' },
      validation_commands: { kind: 'json', value: [{ id: 'fixture', argv: ['node', '--version'] }] } } });
  const loop = run.dag.nodes.find(isLoopNode)!;
  const gatedNode = run.dag.nodes.find(node => node.humanGate)!;
  const calls: Array<{ id: string; bot: string; inputs: GoalInputs }> = [];
  const runNode: RunNode = async req => {
    const inputs = JSON.parse(readFileSync(req.inputsPath, 'utf8')) as GoalInputs;
    calls.push({ id: req.node.id, bot: req.botSnapshot.larkAppId, inputs });
    const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
    if (mode === 'auth' && calls.length === 1) {
      writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'fail', summary: 'Authentication required',
        error: { code: 'AUTH_REQUIRED', message: 'Fixture authentication missing', retryable: true }, files: [] }));
      return { status: 'ok', manifestPath };
    }
    const result = Object.fromEntries(Object.entries(req.node.resultSchema?.properties ?? {}).map(([key, field]) => [key,
      field.enum?.[0] ?? ({ string: 'fixture', number: 1, boolean: true, object: {}, array: [] }[field.type]),
    ]));
    if (req.node.id.endsWith(`.${loop.exit.node}`)) result.passed = mode === 'repair' && req.node.id.includes('.i002.');
    const files: Manifest['files'] = [];
    for (const [name, output] of Object.entries(req.node.outputs ?? {})) {
      if (output.kind === 'directory') throw new Error('Fixture needs a real directory artifact adapter');
      const content = output.kind === 'json' ? JSON.stringify(output.path === 'result.json' ? result : { fixture: req.node.id }) : 'fixture';
      const path = join(req.outputDir, output.path);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
      files.push({ name, path: output.path, kind: output.kind, bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'), mime: output.kind === 'json' ? 'application/json' : 'text/plain' });
    }
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: 'Fixture agent output', files }));
    return { status: 'ok', manifestPath };
  };
  const outcome = await runWorkflow(run.dag, { runNode, validateManifest,
    resolveBotSnapshot: bot => run.botSnapshots.get(bot!)! }, { baseDir, gateMode: 'suspend',
    frozenBotSnapshots: run.botSnapshots, authorizedArtifacts: true,
    executionContext: { params: run.resolvedParams, context: run.resolvedContext as Record<string, string> } });
  return { run, loop, gatedNode, calls, outcome, events: readJournal(join(run.runDir, 'journal.ndjson')) };
}

describe('created development-review preset on the production runtime', () => {
  it('repairs after a rejection and suspends before any PR creation', async () => {
    const { run, loop, calls, events, outcome, gatedNode } = await fixture('repair');
    expect(outcome).toMatchObject({ reason: 'awaitingGate', pendingWaits: [expect.objectContaining({ nodeId: gatedNode.id })] });
    expect(calls.some(call => call.id === gatedNode.id)).toBe(false);
    expect(events.filter(event => event.type === 'loopIterationStarted')).toHaveLength(2);
    const correctness = run.resolvedRoles!.correctness.nodes.find(path => path.startsWith(`${loop.id}/`))!.split('/')[1]!;
    const checkCalls = calls.filter(call => call.id.endsWith(`.${correctness}`));
    expect(checkCalls).toHaveLength(2);
    expect(checkCalls.every(call => call.bot === 'cli_alternate')).toBe(true);
    const second = calls.find(call => call.id.startsWith(`${loop.id}.i002.`))!;
    expect(second.inputs.inputs.some(input => input.from.startsWith('previous.'))).toBe(true);
    expect(calls.filter(call => call.id.startsWith(`${loop.id}.`)).every(call =>
      call.inputs.inputs.some(input => input.from === 'prepare'))).toBe(true);
  });

  it('exhausts the repair limit without reaching PR preparation or approval', async () => {
    const { run, loop, calls, outcome, events } = await fixture('reject');
    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked', blockedNodeId: loop.id });
    expect(events.filter(event => event.type === 'loopIterationStarted')).toHaveLength(3);
    expect(calls.filter(call => !call.id.startsWith(`${loop.id}.`)).map(call => call.id)).toEqual(['preflight', 'prepare']);
    const resaved = compileSavedWorkflowFromRun(run.runDir, { allowDraft: true });
    expect(resaved.revision.execution).toEqual({ workingDirectoryParam: 'repo_path',
      distinctRoles: ['developer', 'correctness', 'regression'] });
    expect(resaved.revision.inputs.repo_path?.default).toBeUndefined();
  });

  it('missing authentication blocks before resources, development and reviews', async () => {
    const { calls, outcome } = await fixture('auth');
    expect(calls.map(call => call.id)).toEqual(['preflight']);
    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked', blockedNodeId: 'preflight' });
  });
});
