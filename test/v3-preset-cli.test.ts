import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../src/workflows/v3/preset-service.js', () => ({ createPresetSavedWorkflow: h.create }));
vi.mock('../src/core/current-turn-provenance.js', () => ({
  resolveCurrentTurnProvenance: () => ({ larkAppId: 'cli_here', callerOpenId: 'ou_caller', chatId: 'oc_here', sessionId: 'session' }),
}));
vi.mock('../src/bot-registry.js', () => ({ loadBotConfigs: () => [] }));
import { cmdSavedWorkflow } from '../src/cli/saved-workflow.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SESSION_DATA_DIR', '/fixture-context');
  h.create.mockResolvedValue({ created: true, origin: 'authored_preset',
    metadata: { displayName: 'Reusable', workflowId: 'wf_fixture', status: 'active' } });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('workflow create builtin preset entry', () => {
  it('binds the authenticated caller and explicit roles without a source run', async () => {
    await cmdSavedWorkflow('create', ['development-review', 'Reusable',
      '--role', 'developer=Developer', '--role=correctness=Correctness', '--role', 'regression=Regression', '--json']);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      presetId: 'development-review', displayName: 'Reusable',
      context: expect.objectContaining({ actor: { openId: 'ou_caller', larkAppId: 'cli_here' }, chatId: 'oc_here' }),
      roleSelections: { developer: 'Developer', correctness: 'Correctness', regression: 'Regression' },
    }));
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({ origin: 'authored_preset' });
  });

  it.each(['--global', '--distill', '--ack-unsafe', '--allow-draft', '--file', '--base-dir']) (
    'refuses %s rather than turning creation into another authority surface', async flag => {
      await expect(cmdSavedWorkflow('create', ['development-review', flag])).rejects.toThrow(/does not accept/);
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it('refuses duplicate role choices and a missing preset before dispatch', async () => {
    await expect(cmdSavedWorkflow('create', ['development-review', '--role', 'developer=A', '--role=developer=B']))
      .rejects.toThrow(/duplicate/);
    await expect(cmdSavedWorkflow('create', ['--json'])).rejects.toThrow(/用法/);
    expect(h.create).not.toHaveBeenCalled();
  });
});
