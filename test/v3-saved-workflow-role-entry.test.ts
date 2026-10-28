import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ instantiate: vi.fn(), save: vi.fn(), start: vi.fn(), source: vi.fn() }));
vi.mock('../src/workflows/v3/library-service.js', () => ({
  instantiatePublishedSavedWorkflow: h.instantiate, saveTerminalRunAsWorkflow: h.save,
  resolveOwnedTerminalRunDir: h.source, listVisibleSavedWorkflows: vi.fn(),
  loadVisibleSavedWorkflow: vi.fn(), resolveVisibleSavedWorkflow: vi.fn(),
}));
vi.mock('../src/core/current-turn-provenance.js', () => ({
  resolveCurrentTurnProvenance: () => ({ larkAppId: 'cli_owner', callerOpenId: 'ou_owner', chatId: 'oc_chat', sessionId: 'session' }),
}));
vi.mock('../src/bot-registry.js', () => ({ loadBotConfigs: () => [] }));
vi.mock('../src/utils/daemon-discovery.js', () => ({ findOnlineDaemon: () => ({ port: 1 }) }));
vi.mock('../src/workflows/v3/daemon-ipc-client.js', () => ({ postWorkflowDaemonMutation: h.start }));

import { cmdSavedWorkflow } from '../src/cli/saved-workflow.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_DATA_DIR', '/test-data');
  h.instantiate.mockResolvedValue({ runId: 'role-run', runDir: '/role-run',
    resolvedRoles: { developer: { nodes: ['work'], bot: 'cli_codex', label: 'Codex', cliId: 'codex' } } });
  h.start.mockResolvedValue({ ok: true });
  h.source.mockResolvedValue('/source-run');
  h.save.mockResolvedValue({ created: true, metadata: { displayName: 'Reusable', workflowId: 'wf_test', status: 'active' },
    revision: { revisionId: 'rev_test', payload: { humanVersion: 1 } } });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Saved Workflow CLI role execution entry', () => {
  it('passes role choices to instantiation and reports the actual frozen result', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdSavedWorkflow('run', ['Reusable', '--role', 'developer=Codex', '--json']);
    expect(h.instantiate).toHaveBeenCalledWith(expect.objectContaining({ ref: 'Reusable',
      roleSelections: { developer: 'Codex' }, rawParams: {} }));
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ runId: 'role-run',
      resolvedRoles: { developer: { bot: 'cli_codex', cliId: 'codex' } } });
  });

  it('forwards explicit save declarations without treating them as part of the display name', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdSavedWorkflow('save', ['last', 'Reusable', '--role', 'developer=loop/work']);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Reusable',
      roleNodes: { developer: ['loop/work'] }, acknowledgeUnsafeLiterals: false }));
  });

  it('rejects duplicate selections and role validation failures before daemon mutation', async () => {
    await expect(cmdSavedWorkflow('run', ['Reusable', '--role', 'developer=A', '--role=developer=B'])).rejects.toThrow(/duplicate role/);
    expect(h.instantiate).not.toHaveBeenCalled();
    h.instantiate.mockRejectedValue(new Error('unknown workflow role: missing'));
    await expect(cmdSavedWorkflow('run', ['Reusable', '--role', 'missing=Codex'])).rejects.toThrow(/unknown workflow role/);
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['--distill', '--ack-unsafe', '--global'])('keeps the agent authority boundary with role declarations: %s', async flag => {
    await expect(cmdSavedWorkflow('save', ['last', 'Reusable', '--role', 'developer=work', flag])).rejects.toThrow(/不接受/);
    expect(h.save).not.toHaveBeenCalled();
  });
});
