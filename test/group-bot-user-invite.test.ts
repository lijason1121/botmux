import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bots from '../src/bot-registry.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { __setPlatformCredentialDepsForTest } from '../src/core/platform-credential-source.js';
import { inviteBotsAsUser } from '../src/services/group-bot-user-invite.js';

const input = {
  creatorLarkAppId: 'cli_creator', chatId: 'oc_created', targetAppIds: ['cli_a', 'cli_b'],
  requesterOpenId: 'ou_requester', requestId: 'om_request',
};
let config: any;
let request: ReturnType<typeof vi.fn>;
let grants: any[];
let platformResponse: any;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  config = { larkAppId: 'cli_creator', larkAppSecret: 'app-secret', allowedUsers: ['ou_owner'] };
  vi.spyOn(bots, 'getBot').mockImplementation(() => ({ config } as any));
  vi.spyOn(identities, 'getIdentity').mockReturnValue(undefined);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockImplementation(async (_app, openId) => ({ openId, type: 'user' }));
  vi.spyOn(tokens, 'resolveUserToken').mockResolvedValue('requester-token');
  vi.spyOn(tokens, 'userTokenAuthState').mockReturnValue({ state: 'needs-login' });
  request = vi.fn(async () => jsonResponse({ code: 0, data: {} }));
  vi.stubGlobal('fetch', request);
  grants = [];
  platformResponse = { ok: true, value: {
    tool: 'lark-cli', unionId: 'on_requester', expiresAt: Date.now() + 60_000,
    variables: { LARKSUITE_CLI_APP_ID: 'cli_platform', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'platform-user-token' },
  } };
  __setPlatformCredentialDepsForTest({
    readBinding: () => ({ platformUrl: 'https://platform.example.test', machineToken: 'machine-token', machineId: 'machine' }),
    resolveUnionId: async (_app, openId) => openId === 'ou_requester' ? 'on_requester' : null,
    requestGrant: async req => { grants.push(req); return platformResponse; },
  });
});
afterEach(() => {
  __setPlatformCredentialDepsForTest(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inviteBotsAsUser', () => {
  it('uses only the exact human sender grant and explicitly selected bots', async () => {
    const result = await inviteBotsAsUser(input);
    expect(result).toEqual([{ id: 'cli_a', ok: true }, { id: 'cli_b', ok: true }]);
    expect(tokens.resolveUserToken).toHaveBeenCalledExactlyOnceWith('cli_creator', 'app-secret', 'feishu', 'ou_requester', expect.any(AbortSignal));
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://open.feishu.cn/open-apis/im/v1/chats/oc_created/members?member_id_type=app_id&succeed_type=1');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer requester-token' } });
    expect(JSON.parse(init.body)).toEqual({ id_list: ['cli_a', 'cli_b'] });
    expect(grants).toHaveLength(0);
  });

  it('uses the platform grant for the same person when their local grant is absent', async () => {
    config.triggerUserAuth = { enabled: true, tools: ['lark-cli'] };
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    expect((await inviteBotsAsUser(input)).every(x => x.ok)).toBe(true);
    expect(grants).toEqual([{ tool: 'lark-cli', unionId: 'on_requester', appId: 'cli_creator',
      sessionId: 'group-invite:om_request', turnId: 'om_request' }]);
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer platform-user-token');
  });

  it('respects platform-only policy even when a local token exists', async () => {
    config.triggerUserAuth = { enabled: true, tools: ['lark-cli'], credentialSource: 'platform' };
    await inviteBotsAsUser(input);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer platform-user-token');
  });

  it.each(['', '../owner', 'cli_bot'])('rejects invalid human identity %j before token lookup', async requesterOpenId => {
    expect((await inviteBotsAsUser({ ...input, requesterOpenId })).every(x => !x.ok)).toBe(true);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(grants).toHaveLength(0);
  });

  it('refuses an unverified requester without borrowing the configured owner token', async () => {
    vi.mocked(identities.resolveVerifiedUserIdentity).mockResolvedValue(undefined);
    const result = await inviteBotsAsUser(input);
    expect(result.every(x => !x.ok && !x.authorizationRequired)).toBe(true);
    expect(tokens.resolveUserToken).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not treat a display cache as proof of a human', async () => {
    vi.mocked(identities.getIdentity).mockReturnValue({ openId: 'ou_requester', type: 'user', source: 'bot_info' } as any);
    vi.mocked(identities.resolveVerifiedUserIdentity).mockResolvedValue(undefined);
    await inviteBotsAsUser(input);
    expect(identities.resolveVerifiedUserIdentity).toHaveBeenCalledExactlyOnceWith('cli_creator', 'ou_requester');
    expect(request).not.toHaveBeenCalled();
  });

  it('accepts an authoritative sender cache without requiring contact scope', async () => {
    vi.mocked(identities.getIdentity).mockReturnValue({ openId: 'ou_requester', type: 'user', source: 'sender' } as any);
    await inviteBotsAsUser(input);
    expect(identities.resolveVerifiedUserIdentity).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports missing local authorization without a write', async () => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    expect((await inviteBotsAsUser(input)).every(x => !x.ok && x.authorizationRequired)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['authorized', 'unknown'] as const)('does not report a failed refresh or unreadable token store as missing authorization (%s)', async state => {
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    vi.mocked(tokens.userTokenAuthState).mockReturnValue({ state });
    expect((await inviteBotsAsUser(input)).every(x => !x.ok && !x.authorizationRequired)).toBe(true);
    expect(tokens.userTokenAuthState).toHaveBeenCalledExactlyOnceWith('cli_creator', 'feishu', 'ou_requester');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'not_authorized', error: 'missing' }, true],
    [{ ok: false, reason: 'consent_missing', error: 'missing' }, true],
    [{ ok: false, reason: 'network', error: 'secret-network-detail' }, false],
    [{ ok: false, reason: 'not_teammate', error: 'private-team-detail' }, false],
  ])('distinguishes platform consent from outages or policy refusal', async (reply, authorizationRequired) => {
    config.triggerUserAuth = { enabled: true, tools: ['lark-cli'] };
    vi.mocked(tokens.resolveUserToken).mockResolvedValue(null);
    platformResponse = reply;
    const result = await inviteBotsAsUser(input);
    expect(result.every(x => !x.ok && !!x.authorizationRequired === authorizationRequired)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/secret-network-detail|private-team-detail/);
  });

  it('separates successful, invalid, nonexistent and pending invites without retrying', async () => {
    request.mockResolvedValue(jsonResponse({ code: 0, data: {
      invalid_id_list: ['cli_b'], not_existed_id_list: ['cli_c'], pending_approval_id_list: ['cli_d'],
    } }));
    const result = await inviteBotsAsUser({ ...input, targetAppIds: ['cli_a', 'cli_b', 'cli_c', 'cli_d'] });
    expect(result.map(x => [x.id, x.ok, !!x.pendingApproval])).toEqual([
      ['cli_a', true, false], ['cli_b', false, false], ['cli_c', false, false], ['cli_d', false, true],
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('deduplicates and sends serial batches of at most five with the configured brand', async () => {
    config.brand = 'lark';
    const targetAppIds = ['cli_a', 'cli_b', 'cli_c', 'cli_d', 'cli_e', 'cli_f', 'cli_a'];
    const result = await inviteBotsAsUser({ ...input, targetAppIds });
    expect(result).toHaveLength(6);
    expect(request.mock.calls.map(([url, init]) => [new URL(url).host, JSON.parse(init.body).id_list])).toEqual([
      ['open.larksuite.com', targetAppIds.slice(0, 5)], ['open.larksuite.com', ['cli_f']],
    ]);
  });

  it('retains API code and safe log ID without reflecting token-bearing error text', async () => {
    request.mockResolvedValue(jsonResponse({ code: 230003, msg: 'requester-token', error: { log_id: 'LOG_123' } }, 400));
    const result = await inviteBotsAsUser(input);
    expect(result).toEqual(input.targetAppIds.map(id => ({ id, ok: false, error: expect.any(String), code: 230003, logId: 'LOG_123' })));
    expect(JSON.stringify(result)).not.toContain('requester-token');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([99991672, 99991679])('distinguishes application permission from user authorization (%s)', async code => {
    request.mockResolvedValue(jsonResponse({ code, msg: 'secret request detail', log_id: 'LOG_SCOPE' }, 403));
    const result = await inviteBotsAsUser(input);
    expect(result.every(x => !x.ok && !!x.authorizationRequired === (code === 99991679) && x.code === code)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret request detail');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Authorization: Bearer requester-token'), new DOMException('timeout', 'TimeoutError')])(
    'does not retry ambiguous network failures or reveal their details', async error => {
      request.mockRejectedValue(error);
      const result = await inviteBotsAsUser(input);
      expect(result.every(x => !x.ok && !x.authorizationRequired)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('requester-token');
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('will not send after credential resolution outlives its operation budget', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.mocked(tokens.resolveUserToken).mockImplementation(async () => { controller.abort(); return 'requester-token'; });
    expect((await inviteBotsAsUser(input)).every(x => !x.ok && !x.authorizationRequired)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([[], { invalid_id_list: 'cli_a' }])('fails closed for malformed successful member data: %j', async data => {
    request.mockResolvedValue(jsonResponse({ code: 0, data }));
    expect((await inviteBotsAsUser(input)).every(x => !x.ok)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
