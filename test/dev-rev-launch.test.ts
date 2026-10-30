import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BotConfig } from '../src/bot-registry.js';
import { bindDevRevLaunchCard, createDevRevLaunch, readDevRevLaunch, resolveDevRevDefaultBranch,
  submitDevRevLaunch, type DevRevLaunch, type DevRevLaunchDeps } from '../src/workflows/v3/dev-rev-launch.js';
import { loadAuthorizedV3Run } from '../src/workflows/v3/run-envelope.js';
import { buildDevRevLaunchCard, DEV_REV_CANCEL, DEV_REV_SUBMIT, handleDevRevLaunchAction, selectDevRevChatBots } from '../src/im/lark/dev-rev-launch-card.js';
import { findV3CardRoute } from '../src/im/lark/card-action-routes.js';
import { isDevRevLaunchCommand, parseV3SavedWorkflowCommand } from '../src/im/lark/v3-saved-workflow-command.js';
import { stampBotmuxCallbackMarkers, BOTMUX_CALLBACK_MARKER_KEY } from '../src/im/lark/callback-button-marker.js';
import { normalizeCardActionData } from '../src/im/lark/card-action-data.js';
import { handleCardAction } from '../src/im/lark/card-handler.js';
import { createPluginCardActionGateway } from '../src/core/plugins/card-actions/gateway.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { loadVisibleSavedWorkflow } from '../src/workflows/v3/library-service.js';
import { createDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review.js';

const context = { actor: { openId: 'ou_owner', larkAppId: 'cli_host' }, chatId: 'oc_here', rootMessageId: 'om_start' };
const bots = [
  { larkAppId: 'cli_dev', name: 'Developer', cliId: 'codex' },
  { larkAppId: 'cli_correct', name: 'Correct', cliId: 'claude-code' },
  { larkAppId: 'cli_regress', name: 'Regression', cliId: 'minimax' },
  { larkAppId: 'cli_other', name: 'Alternate', cliId: 'codex' },
] as BotConfig[];
let root: string, repo: string, dataDir: string, baseDir: string, deps: DevRevLaunchDeps;
function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_COUNT: '0',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
}
const open = (extra: Partial<Parameters<typeof createDevRevLaunch>[0]> = {}) => createDevRevLaunch({ dataDir, context,
  requestKey: 'message-one', repos: [{ path: repo, label: 'Example' }],
  bots: bots.map(bot => ({ appId: bot.larkAppId, label: bot.name! })), ...extra });
const form = { repo: 'repo-1', developer: 'bot-0', correctness: 'bot-1', regression: 'bot-2', requirement: 'Implement new behavior' };
const click = (request: DevRevLaunch, extra: Partial<Parameters<typeof submitDevRevLaunch>[0]> = {}) => submitDevRevLaunch({
  id: request.id, nonce: request.nonce, operator: context.actor.openId, appId: context.actor.larkAppId,
  cardMessageId: 'om_card', form, ...extra,
}, deps);
async function bound(extra: Partial<Parameters<typeof createDevRevLaunch>[0]> = {}) {
  const request = await open(extra); await bindDevRevLaunchCard(dataDir, request.id, 'om_card');
  return readDevRevLaunch(dataDir, request.id);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-rev-launch-'))); repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(root, 'gitconfig'), '');
  git('init', '-q', '-b', 'main'); writeFileSync(join(repo, 'file'), 'base'); git('add', 'file'); git('commit', '-qm', 'fixture');
  dataDir = join(root, 'data'); baseDir = join(dataDir, 'workflow-runs-v3');
  deps = { dataDir, baseDir, resolveMessageChatId: async () => context.chatId, authorize: () => true,
    listChatBots: async () => bots.map(bot => ({ appId: bot.larkAppId, label: bot.name! })),
    loadBots: () => bots.map(bot => ({ ...bot, workingDir: repo })), persistStartIntent: vi.fn(), driveDetached: vi.fn() };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('dev-rev interactive launcher', () => {
  it('upgrades an owned original definition on the next launch without overwriting the old revision', async () => {
    const selected = { developer: 'cli_dev', correctness: 'cli_correct', regression: 'cli_regress' };
    const previous = JSON.parse(readFileSync(new URL('./fixtures/development-review/v2.json', import.meta.url), 'utf8'), (_key, value) =>
      typeof value === 'string' ? ({ cli_developer: selected.developer, cli_correctness: selected.correctness, cli_regression: selected.regression } as Record<string, string>)[value] ?? value : value);
    const saved = await createSavedWorkflow(dataDir, { displayName: 'dev-rev', owner: context.actor,
      scope: { kind: 'chat', chatId: context.chatId }, revision: previous, publish: true });
    const oldPath = join(dataDir, 'workflow-library', saved.metadata.workflowId, 'revisions', saved.metadata.latestRevision + '.json');
    const oldBytes = readFileSync(oldPath, 'utf8');
    const request = await bound(); expect(await click(request)).toMatchObject({ started: true });
    const updated = await loadVisibleSavedWorkflow({ dataDir, context, ref: saved.metadata.workflowId });
    expect(updated.revision.payload.humanVersion).toBe(2);
    const { workflowId, humanVersion, createdAt, createdBy, ...draft } = updated.revision.payload;
    expect(draft).toEqual(createDevelopmentReviewPreset(selected));
    expect(readFileSync(oldPath, 'utf8')).toBe(oldBytes);
    expect(deps.driveDetached).toHaveBeenCalledTimes(1);
  });
  it('parses the short IM invocation and opens one durable form without creating any run', async () => {
    expect(parseV3SavedWorkflowCommand('/workflow run dev-rev')).toMatchObject({ kind: 'run', ref: 'dev-rev', rawParams: {} });
    const [a, b] = await Promise.all([open(), open()]);
    expect(a.id).toBe(b.id); expect(a.nonce).toBe(b.nonce);
    expect(existsSync(baseDir)).toBe(false);
    expect(existsSync(join(dataDir, 'workflow-library'))).toBe(false);
    const card = JSON.parse(buildDevRevLaunchCard(a));
    const fields = card.body.elements.find((x: any) => x.tag === 'form').elements;
    expect(fields.filter((x: any) => x.tag === 'select_static').map((x: any) => x.name))
      .toEqual(['repo', 'developer', 'correctness', 'regression']);
    expect(fields.find((x: any) => x.name === 'requirement').input_type).toBe('multiline_text');
    expect(JSON.stringify(card).includes(repo)).toBe(false);
  });
  it('keeps parameterized and other saved workflow runs on their ordinary path', () => {
    expect(isDevRevLaunchCommand(parseV3SavedWorkflowCommand('/workflow run dev-rev')!)).toBe(true);
    for (const command of ['/workflow run other', '/workflow run dev-rev requirement=x', '/workflow run dev-rev --role developer=Developer']) {
      expect(isDevRevLaunchCommand(parseV3SavedWorkflowCommand(command)!)).toBe(false);
    }
    const member = { larkAppId: 'cli_dev', source: 'configured', displayName: 'Live developer', name: 'codex' };
    expect(selectDevRevChatBots(bots, [member, { ...member, source: 'introduce', larkAppId: 'cli_correct' },
      { ...member, larkAppId: 'cli_unconfigured' }] as any)).toEqual([{ appId: 'cli_dev', label: 'Live developer · codex' }]);
  });
  it('returns a durable retry card after a failed callback, retaining requirement text', async () => {
    const request = await bound(); deps.persistStartIntent = () => { throw new Error('write unavailable'); };
    const value = { action: DEV_REV_SUBMIT, id: request.id, nonce: request.nonce };
    const result: any = await handleDevRevLaunchAction(value, form, 'ou_owner', 'cli_host', 'om_card', deps);
    const fields = result.card.data.body.elements.find((x: any) => x.tag === 'form').elements;
    expect(fields.find((x: any) => x.name === 'requirement').default_value).toBe(form.requirement);
    expect(readDevRevLaunch(dataDir, request.id).submitted).toBeDefined();
    expect(deps.driveDetached).not.toHaveBeenCalled();
  });
  it('materializes the reviewed definition with chosen roles, empty auto-discovery plan and default base', async () => {
    const request = await bound(); const result = await click(request);
    expect(result).toMatchObject({ started: true, runId: request.runId });
    const loaded = loadAuthorizedV3Run(join(baseDir, request.runId));
    expect(loaded.resolvedParams).toMatchObject({ params: { repo_path: repo, target_branch: 'main',
      requirement: form.requirement, validation_commands: [] } });
    expect(loaded.resolvedRoles).toMatchObject({ developer: { bot: 'cli_dev' }, correctness: { bot: 'cli_correct' }, regression: { bot: 'cli_regress' } });
    expect(loaded.envelope.chatBinding).toMatchObject({ ownerOpenId: 'ou_owner', rootMessageId: 'om_start', chatId: 'oc_here', larkAppId: 'cli_host' });
    expect(deps.driveDetached).toHaveBeenCalledTimes(1);
  });
  it('concurrent repeat submissions start one run and reuse its final card', async () => {
    const request = await bound();
    const [a, b] = await Promise.all([click(request), click(request)]);
    expect(a.runId).toBe(b.runId); expect(deps.driveDetached).toHaveBeenCalledTimes(1);
    expect(readdirSync(baseDir).filter(x => x.startsWith('devrev-'))).toEqual([request.runId]);
    expect(JSON.parse(buildDevRevLaunchCard(readDevRevLaunch(dataDir, request.id))).body.elements).toHaveLength(1);
  });
  it('recovers a published run after a start-intent failure without rematerializing or accepting changed inputs', async () => {
    const request = await bound();
    deps.persistStartIntent = vi.fn().mockImplementationOnce(() => { throw new Error('intent write unavailable'); });
    await expect(click(request)).rejects.toThrow('intent write unavailable');
    const first = loadAuthorizedV3Run(join(baseDir, request.runId));
    const reloaded = readDevRevLaunch(dataDir, request.id); expect(reloaded.started).toBe(false);
    expect(await click(reloaded, { form: { ...form, requirement: 'changed' } })).toMatchObject({ started: true });
    const recovered = loadAuthorizedV3Run(join(baseDir, request.runId));
    expect(recovered.envelope).toEqual(first.envelope);
    expect(recovered.resolvedParams).toMatchObject({ params: { requirement: form.requirement } });
  });
  it('reuses one owned definition while allowing a different developer on the next invocation', async () => {
    await click(await bound());
    const next = await bound({ requestKey: 'message-two' });
    await click(next, { form: { ...form, developer: 'bot-3' } });
    const loaded = loadAuthorizedV3Run(join(baseDir, next.runId));
    expect(loaded.resolvedRoles).toMatchObject({ developer: { bot: 'cli_other' } });
    expect(readdirSync(join(dataDir, 'workflow-library')).filter(x => x.startsWith('wf_'))).toHaveLength(1);
  });
  it.each([
    { operator: 'ou_other' }, { appId: 'cli_other' }, { cardMessageId: 'om_copy' }, { nonce: '0'.repeat(64) },
  ])('rejects forged identity or card binding before publication: %j', async override => {
    const request = await bound(); await expect(click(request, override)).rejects.toThrow(/只有发起人/);
    expect(existsSync(baseDir)).toBe(false); expect(deps.driveDetached).not.toHaveBeenCalled();
  });
  it('denies forwarded-chat cards, revoked permissions and expired requests', async () => {
    const request = await bound();
    deps.resolveMessageChatId = async () => 'oc_elsewhere'; await expect(click(request)).rejects.toThrow(/原群/);
    deps.resolveMessageChatId = async () => context.chatId; deps.authorize = () => false;
    await expect(click(request)).rejects.toThrow(/只有发起人/);
    deps.authorize = () => true; await expect(click(request, { now: request.expiresAt + 1 })).rejects.toThrow(/过期/);
    expect(existsSync(baseDir)).toBe(false);
  });
  it.each([
    { ...form, requirement: '' }, { ...form, repo: '/tmp/forged' }, { ...form, developer: 'bot-99' },
    { ...form, developer: 'bot-1' }, { ...form, injected: 'unexpected' },
  ])('rejects invalid form data before any run: %j', async value => {
    const request = await bound(); await expect(click(request, { form: value })).rejects.toThrow();
    expect(existsSync(baseDir)).toBe(false); expect(deps.persistStartIntent).not.toHaveBeenCalled();
  });
  it('rechecks current membership instead of trusting the original dropdown', async () => {
    const request = await bound(); deps.listChatBots = async () => [{ appId: 'cli_dev', label: 'Developer' }];
    await expect(click(request)).rejects.toThrow(/离群/); expect(existsSync(baseDir)).toBe(false);
  });
  it('cancel remains idempotent and cannot later be submitted', async () => {
    const request = await bound(); expect(await click(request, { cancel: true })).toMatchObject({ cancelled: true, started: false });
    expect(await click(request)).toMatchObject({ cancelled: true, started: false });
    expect(existsSync(baseDir)).toBe(false);
  });
  it('passes a supplied document URL as requirement data to preflight', async () => {
    const request = await bound(); const requirement = 'https://example.invalid/docx/requirement';
    await click(request, { form: { ...form, requirement } });
    expect(loadAuthorizedV3Run(join(baseDir, request.runId)).resolvedParams).toMatchObject({ params: { requirement } });
  });
  it('routes real submit/cancel callbacks and preserves an unauthorized card', async () => {
    const request = await bound(); const value = { action: DEV_REV_SUBMIT, id: request.id, nonce: request.nonce };
    const denied: any = await handleDevRevLaunchAction(value, form, 'ou_other', 'cli_host', 'om_card', deps);
    expect(denied.toast.type).toBe('error'); expect(denied.card).toBeUndefined();
    const route = findV3CardRoute(DEV_REV_SUBMIT)!;
    const accepted: any = await route.run({ value, operatorOpenId: 'ou_owner', larkAppId: 'cli_host',
      cardMessageId: 'om_card', formValue: form, deps: { devRevLaunchDeps: deps } as any });
    expect(accepted.card.data.schema).toBe('2.0'); expect(deps.driveDetached).toHaveBeenCalledTimes(1);
    expect(findV3CardRoute(DEV_REV_CANCEL)?.name).toBe(route.name);
  });
  it.each(['submit', 'cancel'] as const)('accepts the actual stamped outbound card through %s callback ingress', async mode => {
    const request = await bound();
    // Use exactly the serialization transform applied by all Lark send/reply/update paths.
    const wire = JSON.parse(stampBotmuxCallbackMarkers(buildDevRevLaunchCard(request)));
    const formElement = wire.body.elements.find((x: any) => x.tag === 'form');
    const button = mode === 'submit' ? formElement.elements.find((x: any) => x.name === 'start') :
      wire.body.elements.find((x: any) => x.tag === 'button');
    expect(button.value[BOTMUX_CALLBACK_MARKER_KEY]).toBe(1);
    const handlerDeps = { activeSessions: new Map(), lastRepoScan: new Map(),
      sessionReply: vi.fn(), devRevLaunchDeps: deps };
    const gateway = createPluginCardActionGateway({ resolvePluginIds: () => [],
      fallback: (event, appId) => handleCardAction(event, handlerDeps, appId) });
    const event = normalizeCardActionData({ header: { event_type: 'card.action.trigger' }, event: {
      operator: { open_id: context.actor.openId },
      context: { open_message_id: 'om_card', open_chat_id: context.chatId },
      action: { tag: 'button', value: button.value, ...(mode === 'submit' ? { form_value: form } : {}) },
    } });
    const result: any = await gateway.dispatch(event, context.actor.larkAppId);
    expect(result.card?.data.schema).toBe('2.0');
    expect(readDevRevLaunch(dataDir, request.id)).toMatchObject(mode === 'submit'
      ? { started: true, cancelled: false } : { started: false, cancelled: true });
    expect(deps.driveDetached).toHaveBeenCalledTimes(mode === 'submit' ? 1 : 0);
  });
  it.each([
    { [BOTMUX_CALLBACK_MARKER_KEY]: 0 }, { [BOTMUX_CALLBACK_MARKER_KEY]: '1' },
    { [BOTMUX_CALLBACK_MARKER_KEY]: 1, ownerOpenId: 'ou_forged' },
    { [BOTMUX_CALLBACK_MARKER_KEY]: 1, unexpected: 'value' },
  ])('keeps rejecting malformed marker or extra authority fields: %j', async extras => {
    const request = await bound();
    const result: any = await handleDevRevLaunchAction({ action: DEV_REV_SUBMIT, id: request.id,
      nonce: request.nonce, ...extras }, form, context.actor.openId, context.actor.larkAppId, 'om_card', deps);
    expect(existsSync(baseDir)).toBe(false); expect(result.toast?.type).toBe('error');
    expect(deps.driveDetached).not.toHaveBeenCalled();
  });
  it('does not mistake the marker for authorization of another group member', async () => {
    const request = await bound();
    const result: any = await handleDevRevLaunchAction({ action: DEV_REV_SUBMIT, id: request.id,
      nonce: request.nonce, [BOTMUX_CALLBACK_MARKER_KEY]: 1 }, form, 'ou_other', context.actor.larkAppId, 'om_card', deps);
    expect(existsSync(baseDir)).toBe(false); expect(result.toast?.type).toBe('error');
    expect(deps.driveDetached).not.toHaveBeenCalled();
  });
});

describe('automatic repository base', () => {
  it('uses the remote default and never the active feature branch', () => {
    git('branch', 'release'); git('update-ref', 'refs/remotes/origin/release', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');
    git('checkout', '-qb', 'some-feature');
    expect(resolveDevRevDefaultBranch(repo)).toBe('origin/release');
  });
  it('fails closed on an ambiguous default instead of guessing current HEAD', () => {
    git('branch', 'master'); expect(() => resolveDevRevDefaultBranch(repo)).toThrow(/无法唯一确定/);
  });
  it('does not fall back to main when the declared remote default has not been fetched', () => {
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release');
    expect(() => resolveDevRevDefaultBranch(repo)).toThrow(/尚未获取/);
  });
});
