import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { V3HumanGate } from './dag.js';
import type { StoredEvent } from './event-contract.js';
import { materialize } from './state.js';

const MARKER = '\n\n[BOTMUX_GATE_CONTEXT_V1]\n';
export const MAX_GATE_CONTEXT_CHARS = 6000;

/** Informational context only: options, approvers and the gate itself stay
 * authored. Pin the bytes to the current successful instance's manifest. */
export function resolveV3GatePrompt(gate: V3HumanGate, runDir: string, events: StoredEvent[]): string {
  const ref = gate.contextFrom;
  if (!ref) return gate.prompt;
  const key = materialize(events).nodes.get(ref.nodeId)?.effectiveInstanceId ?? ref.nodeId;
  const success = [...events].reverse().find(event => event.type === 'nodeSucceeded' &&
    (event.instanceId ?? event.nodeId) === key);
  if (!success || success.type !== 'nodeSucceeded') throw new Error('Approval context has no successful current source');
  const safeRead = (filename: string): Buffer => {
    const rel = relative(resolve(runDir), resolve(filename));
    if (!rel || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error('Approval context escapes run directory');
    let current = resolve(runDir);
    for (const part of rel.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('Approval context symlink rejected');
    }
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('Approval context must be a bounded regular file');
    return readFileSync(current);
  };
  const manifestPath = isAbsolute(success.manifestPath) ? success.manifestPath : join(runDir, success.manifestPath);
  const manifest = JSON.parse(safeRead(manifestPath).toString('utf8'));
  const entries = manifest.files?.filter((file: { path: string }) => file.path === 'result.json');
  if (manifest.status !== 'ok' || entries?.length !== 1) throw new Error('Approval context result is missing');
  const bytes = safeRead(join(dirname(manifestPath), 'work', 'result.json'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (entries[0].sha256 !== digest || entries[0].bytes !== bytes.length) throw new Error('Approval context digest mismatch');
  const text = JSON.parse(bytes.toString('utf8'))[ref.field];
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_GATE_CONTEXT_CHARS) {
    throw new Error('Approval context must be a nonempty bounded string');
  }
  return gate.prompt + MARKER + JSON.stringify({ source: ref.nodeId, sha256: `sha256:${digest}`, text });
}

export function splitV3GateContext(prompt: string): { prompt: string; text?: string; sha256?: string } {
  const index = prompt.indexOf(MARKER);
  if (index < 0) return { prompt };
  try {
    const context = JSON.parse(prompt.slice(index + MARKER.length));
    if (typeof context.text === 'string' && context.text.length <= MAX_GATE_CONTEXT_CHARS &&
        /^sha256:[a-f0-9]{64}$/.test(context.sha256)) {
      return { prompt: prompt.slice(0, index), text: context.text, sha256: context.sha256 };
    }
  } catch { /* Legacy authored prompts containing the marker remain plain text. */ }
  return { prompt };
}
