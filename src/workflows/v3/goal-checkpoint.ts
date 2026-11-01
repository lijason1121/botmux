import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync, readSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
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

/** Last-resort continuation context when the agent never published a valid
 * checkpoint. Logs are untrusted observations, not validated progress or an
 * approval. Only this node's prior attempt with identical inputs/identity is
 * eligible; no sibling reviewers, growing native history stores or secrets
 * configuration files are discovered here. */
export function writeAttemptHistory(input: {
  runDir: string;
  runId: string;
  nodeId: string;
  previousAttemptId: string;
  attemptDir: string;
  previousInputHash: string;
  inputHash: string;
}): GoalInputs['inputs'][number] | undefined {
  if (input.inputHash !== input.previousInputHash) return undefined;
  const previousDir = join(input.runDir, input.previousAttemptId);
  const output = join(input.attemptDir, 'previous-attempt.json');
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    const within = relative(input.runDir, previousDir);
    if (!within || isAbsolute(within) || within.split(sep).some(p => !p || p === '..')) return undefined;
    let directory = input.runDir;
    const directories: { path: string; dev: number; ino: number }[] = [];
    for (const part of within.split(sep)) {
      directory = join(directory, part);
      const stat = lstatSync(directory);
      if (!stat.isDirectory()) return undefined; // also rejects symlinks
      directories.push({ path: directory, dev: stat.dev, ino: stat.ino });
    }
    const logs: Record<string, { text: string; truncated: boolean }> = {};
    for (const [name, limit] of [['pty.log', 64_000], ['stdout.log', 16_000], ['stderr.log', 16_000]] as const) {
      let fd: number | undefined;
      try {
        const filename = join(previousDir, name), before = lstatSync(filename);
        if (!before.isFile()) continue;
        // NOFOLLOW protects the final component; recheck parent identities as
        // well so a detected directory replacement discards optional history.
        // NONBLOCK avoids hanging on a file replaced by a FIFO before open.
        fd = openSync(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
        const stat = fstatSync(fd);
        if (!stat.isFile() || !stat.size) continue;
        if (stat.dev !== before.dev || stat.ino !== before.ino) return undefined;
        for (const prior of directories) {
          const current = lstatSync(prior.path);
          if (!current.isDirectory() || current.dev !== prior.dev || current.ino !== prior.ino) return undefined;
        }
        const current = lstatSync(filename);
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) return undefined;
        const buffer = Buffer.alloc(Math.min(stat.size, limit));
        const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
        if (length) logs[name] = { text: buffer.subarray(0, length).toString('utf8'), truncated: stat.size > limit };
      } catch { /* Missing/unreadable logs do not prevent a fresh attempt. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    if (!Object.keys(logs).length) return undefined;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, runId: input.runId, nodeId: input.nodeId,
      previousAttemptId: input.previousAttemptId, inputHash: input.inputHash, approval: false, logs }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, output);
    return { from: 'attempt-history', name: 'previous-execution', kind: 'json', path: output };
  } catch {
    return undefined;
  } finally {
    try { unlinkSync(temporary); } catch { /* absent after successful rename */ }
  }
}
