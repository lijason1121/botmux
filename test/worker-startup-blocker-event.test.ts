import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCliStartupBlocker, startupBlockerKey } from '../src/core/cli-startup-blocker.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { WorkerToDaemon } from '../src/types.js';

function harness(workflow = false, alreadyExplained = false) {
  const messages: WorkerToDaemon[] = [];
  const scope = {
    backend: {}, lastInitConfig: { workingDir: '/workspace', backendType: 'tmux' },
    freshCliNeverReady: () => true,
    isRemoteBackendType: () => false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    captureBackendScreen: () => readFileSync(join(process.cwd(), 'test/fixtures/startup-blockers/grok-1.0.67-folder-trust.txt'), 'utf8'),
    detectCliStartupBlocker, startupBlockerKey,
    startupBlocker: null, cliSpawnGeneration: 1,
    reportedUntrustedWorkspaces: new Set(alreadyExplained ? ['/root/ec-apply-access'] : []),
    cliName: () => 'Grok', log: () => {},
    startupBlockerNotice: () => 'workspace needs trust', currentBotmuxTurnId: 'turn',
    send: (event: WorkerToDaemon) => messages.push(event),
    process: { env: workflow ? { BOTMUX_WORKFLOW: '1' } : {} },
  };
  return { messages, probe: loadWorkerFunction<(source: string) => unknown>('probeStartupBlocker', scope) };
}

describe('worker startup blocker IPC', () => {
  it('publishes a specific structured blocker once from the real detector', () => {
    const { probe, messages } = harness();
    probe('first-prompt');
    probe('ready-fallback');
    expect(messages).toEqual([expect.objectContaining({ type: 'user_notify', kind: 'cli_startup_blocked',
      startupBlocker: { kind: 'folder_trust', rule: 'grok-folder-trust' } })]);
  });

  it('still informs a workflow when the ordinary trust notice was already explained', () => {
    const { probe, messages } = harness(true, true);
    probe('first-prompt');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: 'cli_startup_blocked' });
  });

  it('keeps an already-explained ordinary chat notice deduplicated', () => {
    const { probe, messages } = harness(false, true);
    probe('first-prompt');
    expect(messages).toEqual([]);
  });
});
