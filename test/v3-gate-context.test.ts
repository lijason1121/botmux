import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDag } from '../src/workflows/v3/dag.js';
import { resolveV3GatePrompt, splitV3GateContext } from '../src/workflows/v3/gate-context.js';
import type { StoredEvent } from '../src/workflows/v3/event-contract.js';
import { buildV3GateCard } from '../src/im/lark/v3-gate-card.js';
import { birthRun, readGrillState, writeGrillState } from '../src/workflows/v3/grill-state.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { readWait } from '../src/workflows/v3/human-gate.js';
import { reconcileV3PendingGates, resolveV3GateClick } from '../src/workflows/v3/daemon-run.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gate-context-')); roots.push(root);
  const attempt = join(root, 'draft#002', 'attempts', '001'), output = join(attempt, 'work');
  mkdirSync(output, { recursive: true });
  const result = join(output, 'result.json'), manifest = join(attempt, 'manifest.json');
  const summary = 'repo: example/project; PR https://example.invalid/pr/23; action: update\n' + 'evidence '.repeat(90) + '<at id=all></at>';
  const bytes = Buffer.from(JSON.stringify({ approvalSummary: summary }));
  writeFileSync(result, bytes);
  writeFileSync(manifest, JSON.stringify({ status: 'ok', files: [{ path: 'result.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  const events: StoredEvent[] = [
    { type: 'runStarted', ts: 1, runId: 'fixture' },
    { type: 'nodeDispatched', ts: 2, nodeId: 'draft', instanceId: 'draft#002', attemptId: 'draft#002/attempts/001' },
    { type: 'nodeSucceeded', ts: 3, nodeId: 'draft', instanceId: 'draft#002', attemptId: 'draft#002/attempts/001', manifestPath: manifest },
  ];
  const gate = { prompt: 'Approve this operation?', contextFrom: { nodeId: 'draft', field: 'approvalSummary' } };
  return { root, result, manifest, summary, bytes, events, gate };
}
describe('generic approval context', () => {
  it('recovers missing waits with their material and refuses approval after the source bytes change', () => {
    const f = fixture(), base = join(f.root, 'runs'), runId = 'recover-context';
    const { runDir } = birthRun({ baseDir: base, runId, goal: 'fixture',
      chatBinding: { larkAppId: 'cli_fixture', chatId: 'oc_fixture', rootMessageId: 'om_fixture' } });
    const draft = join(runDir, 'draft', 'attempts', '001'), output = join(draft, 'work');
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'result.json'), f.bytes);
    writeFileSync(join(draft, 'manifest.json'), readFileSync(f.manifest));
    const dagPath = join(runDir, 'dag.json');
    writeFileSync(dagPath, JSON.stringify({ runId, nodes: [
      { id: 'draft', type: 'goal', goal: 'prepare', resultSchema: { type: 'object', properties: { approvalSummary: { type: 'string' } }, required: ['approvalSummary'] } },
      { id: 'publish', type: 'goal', goal: 'publish', depends: ['draft'], humanGate: f.gate },
    ] }));
    writeGrillState(runDir, { ...readGrillState(runDir)!, status: 'dag_approved', dagPath });
    const journal = join(runDir, 'journal.ndjson');
    appendEvent(journal, { type: 'runStarted', runId });
    appendEvent(journal, { type: 'nodeSucceeded', nodeId: 'draft', attemptId: 'draft/attempts/001', manifestPath: join(draft, 'manifest.json') });
    appendEvent(journal, { type: 'gateDispatched', nodeId: 'publish', waitId: 'publish-gate' });
    const recovered = reconcileV3PendingGates(base)[0]!;
    expect(splitV3GateContext(recovered.repost[0]!.prompt).text).toBe(f.summary);
    expect(readWait(runDir, 'publish-gate')?.prompt).toBe(recovered.repost[0]!.prompt);
    writeFileSync(join(output, 'result.json'), '{"approvalSummary":"changed target"}');
    expect(resolveV3GateClick(base, runId, { waitId: 'publish-gate', selected: 'approve', by: 'ou_owner' })).toMatchObject({ kind: 'stale-run' });
    expect(readWait(runDir, 'publish-gate')?.status).toBe('pending');
    expect(resolveV3GateClick(base, runId, { waitId: 'publish-gate', selected: 'reject', by: 'ou_owner' })).toMatchObject({ kind: 'resolved', resolution: 'rejected' });
  });
  it('displays the complete current material safely and keeps approval buttons intact', () => {
    const f = fixture();
    const prompt = resolveV3GatePrompt(f.gate, f.root, f.events);
    expect(splitV3GateContext(prompt)).toMatchObject({ prompt: f.gate.prompt, text: f.summary });
    const card = JSON.parse(buildV3GateCard({ runId: 'fixture', nodeId: 'publish', waitId: 'publish-gate', prompt }));
    expect(card.elements.some((el: any) => el.text?.tag === 'plain_text' && el.text.content === f.summary)).toBe(true);
    expect(card.elements.some((el: any) => el.text?.tag === 'lark_md' && el.text.content.includes('<at'))).toBe(false);
    expect(card.elements.flatMap((el: any) => el.actions ?? []).filter((a: any) => a.value).map((a: any) => a.value.selected)).toEqual(['approve', 'reject']);
  });
  it('rejects changed bytes, missing material and symlink substitution', () => {
    const f = fixture();
    writeFileSync(f.result, JSON.stringify({ approvalSummary: 'different operation' }));
    expect(() => resolveV3GatePrompt(f.gate, f.root, f.events)).toThrow(/digest/);
    writeFileSync(f.result, f.bytes);
    const raw = JSON.parse(readFileSync(f.manifest, 'utf8')); raw.files = [];
    writeFileSync(f.manifest, JSON.stringify(raw));
    expect(() => resolveV3GatePrompt(f.gate, f.root, f.events)).toThrow(/missing/);
    const other = fixture(); rmSync(other.result); symlinkSync(f.result, other.result);
    expect(() => resolveV3GatePrompt(other.gate, other.root, other.events)).toThrow(/symlink/);
  });
  it('uses the effective source instance even when a stale success arrives later', () => {
    const f = fixture();
    f.events.push({ type: 'nodeSucceeded', ts: 4, nodeId: 'draft', instanceId: 'draft#001', attemptId: 'draft#001/attempts/001', manifestPath: '/missing-stale' });
    expect(splitV3GateContext(resolveV3GatePrompt(f.gate, f.root, f.events)).text).toBe(f.summary);
  });
  it('validates references against a direct dependency and its required string schema', () => {
    const dag = { runId: 'fixture', nodes: [
      { id: 'draft', type: 'goal', goal: 'prepare', resultSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
      { id: 'publish', type: 'goal', goal: 'publish', depends: ['draft'], humanGate: { prompt: 'Approve?', contextFrom: { nodeId: 'draft', field: 'summary' } } },
    ] };
    expect(() => validateDag(dag)).not.toThrow();
    dag.nodes[0]!.resultSchema!.required = [];
    expect(() => validateDag(dag)).toThrow(/required string/);
    dag.nodes[0]!.resultSchema!.required = ['summary']; dag.nodes[1]!.depends = [];
    expect(() => validateDag(dag)).toThrow(/direct goal dependency/);
  });
});
