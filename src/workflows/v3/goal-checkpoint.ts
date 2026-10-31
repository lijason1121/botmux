import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeInputHash } from '../../utils/canonical-input-hash.js';
import type { BotSnapshot, GoalInputs, ValidateManifest } from './contract.js';
import type { V3Node } from './dag.js';

/** Paths may change between attempts; content, node instructions and frozen
 * identity must not. Directory inputs are deliberately ineligible for reuse. */
export async function fingerprintGoalInputs(node: V3Node, bot: BotSnapshot, inputs: GoalInputs): Promise<string | undefined> {
  const fingerprints: unknown[] = [];
  let bytes = 0;
  try {
    for (const input of inputs.inputs) {
      const stat = lstatSync(input.path);
      // Optional reuse must neither block on a special file nor add an
      // unbounded scan to ordinary large-artifact workflows.
      bytes += stat.size;
      if (!stat.isFile() || input.kind === 'directory' || bytes > 64_000_000) return undefined;
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(input.path)) digest.update(chunk);
      const { path: _path, preview: _preview, ...identity } = input;
      fingerprints.push({ ...identity, sha256: digest.digest('hex') });
    }
  } catch {
    return undefined;
  }
  return computeInputHash({ node, bot, inputs: fingerprints, omitted: inputs.omitted });
}

/** A checkpoint is incomplete, untrusted work, never a final manifest or an
 * approval. Restore only hash-validated artifacts for the exact same inputs. */
export async function restoreGoalCheckpoint(input: {
  previousOutputDir: string;
  previousInputHash: string;
  inputHash: string;
  validateManifest: ValidateManifest;
}): Promise<GoalInputs['inputs'] | undefined> {
  if (input.inputHash !== input.previousInputHash) return undefined;
  const path = join(input.previousOutputDir, 'checkpoint.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 256_000) return undefined;
    const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
    if (checkpoint.inputHash !== input.inputHash || checkpoint.status !== 'fail'
      || checkpoint.error?.code !== 'CHECKPOINT_INCOMPLETE') return undefined;
    const verified = await input.validateManifest(path, input.previousOutputDir);
    if (!verified.ok || verified.manifest?.status !== 'fail' || !verified.manifest.files.length) return undefined;
    return verified.manifest.files.map(file => ({
      from: 'checkpoint', name: file.name, kind: file.kind, path: join(input.previousOutputDir, file.path),
    }));
  } catch {
    // Optional progress cannot prevent a fresh attempt; no unchecked paths
    // or exception text from an old worker escape into its successor's input.
    return undefined;
  }
}
