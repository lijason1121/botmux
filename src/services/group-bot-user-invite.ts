import { getBot } from '../bot-registry.js';
import { resolveBoundLarkUserCredential } from '../core/lark-tool-platform-credential.js';
import { getIdentity, resolveVerifiedUserIdentity } from '../im/lark/identity-cache.js';
import { larkHosts, normalizeBrand } from '../im/lark/lark-hosts.js';
import { LARK_CODE_APP_SCOPE_MISSING, LARK_CODE_USER_SCOPE_MISSING } from '../im/lark/lark-errors.js';
import { isUsableOpenId, resolveUserToken, userTokenAuthState } from '../utils/user-token.js';
import type { BotInviteResult } from './groups-store.js';

export interface InviteBotsAsUserInput {
  creatorLarkAppId: string;
  chatId: string;
  targetAppIds: string[];
  /** The human who sent the command, in the creator application's scope. */
  requesterOpenId: string;
  /** Trusted incoming message ID; /g can run without a CLI session. */
  requestId: string;
}

function safeLogId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

/** Only the explicitly requested bots are invited, using the exact sender's
 * existing grant. This shares lark-cli's local/platform selection without
 * spawning a CLI or borrowing an owner's authorization. */
export async function inviteBotsAsUser(input: InviteBotsAsUserInput): Promise<BotInviteResult[]> {
  const ids = [...new Set(input.targetAppIds)];
  if (!ids.length) return [];
  const failed = (error: string, extra: Partial<BotInviteResult> = {}): BotInviteResult[] =>
    ids.map(id => ({ id, ok: false, error, ...extra }));
  // resolveUserToken without a usable person may consult a legacy per-app
  // token. Reject BEFORE resolving either a local or platform credential.
  if (!isUsableOpenId(input.requesterOpenId) || !input.requesterOpenId.startsWith('ou_')
    || !/^oc_[A-Za-z0-9]+$/.test(input.chatId) || !input.requestId.trim()
    || ids.some(id => !/^cli_[A-Za-z0-9]+$/.test(id))) {
    return failed('Invalid user invitation request');
  }

  const signal = AbortSignal.timeout(15_000);
  let credential: string;
  let host: string;
  try {
    const cached = getIdentity(input.creatorLarkAppId, input.requesterOpenId);
    const user = cached?.type === 'user' && ['sender', 'message_api', 'contact_api'].includes(cached.source)
      ? cached : await resolveVerifiedUserIdentity(input.creatorLarkAppId, input.requesterOpenId);
    if (!user || user.type !== 'user' || user.openId !== input.requesterOpenId) {
      return failed('The requesting user could not be verified');
    }
    const bot = getBot(input.creatorLarkAppId).config;
    const brand = normalizeBrand(bot.brand);
    let localAuthState: ReturnType<typeof userTokenAuthState>['state'] | undefined;
    const resolved = await resolveBoundLarkUserCredential({
      bot,
      openId: input.requesterOpenId,
      sessionId: `group-invite:${input.requestId}`,
      turnId: input.requestId,
      delegated: false,
      botAppToken: async openId => {
        const token = await resolveUserToken(bot.larkAppId, bot.larkAppSecret, brand, openId, signal);
        // resolveUserToken also returns null after a transient refresh failure.
        // A still-refreshable grant is not proof that the user must log in.
        if (!token) localAuthState = userTokenAuthState(bot.larkAppId, brand, openId).state;
        return token;
      },
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      const needsAuthorization = localAuthState !== 'authorized' && localAuthState !== 'unknown'
        && (resolved.reason === 'bot_app_missing'
          || /\[reason=platform_(?:not_authorized|consent_missing)\]/.test(resolved.error));
      return failed(needsAuthorization ? 'The requesting user needs authorization' : 'User authorization is temporarily unavailable',
        needsAuthorization ? { authorizationRequired: true } : {});
    }
    credential = resolved.credential;
    // The returned credential may belong to the platform application. No
    // app-scoped person ID is sent: only the chat ID and target App IDs cross
    // this boundary, exactly as with lark-cli --as user.
    host = larkHosts(brand).openApi;
  } catch {
    // Refresh/contact/platform exceptions can carry credentials. Do not echo
    // exception text, and do not mistake an outage for missing authorization.
    return failed('User authorization could not be resolved');
  }

  const results: BotInviteResult[] = [];
  for (let start = 0; start < ids.length; start += 5) {
    const batch = ids.slice(start, start + 5);
    try {
      signal.throwIfAborted();
      const response = await fetch(`${host}/open-apis/im/v1/chats/${encodeURIComponent(input.chatId)}/members?member_id_type=app_id&succeed_type=1`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ id_list: batch }),
      });
      const body: any = await response.json();
      const code = typeof body?.code === 'number' && Number.isFinite(body.code) ? body.code : undefined;
      const logId = safeLogId(body?.log_id) ?? safeLogId(body?.error?.log_id)
        ?? safeLogId(response.headers.get('x-tt-logid'));
      if (!response.ok || code !== 0) {
        const userScopeMissing = code === LARK_CODE_USER_SCOPE_MISSING;
        const error = code === LARK_CODE_APP_SCOPE_MISSING
          ? 'The issuing application needs chat member permissions'
          : code === LARK_CODE_USER_SCOPE_MISSING
            ? 'The requesting user must authorize chat member permissions'
            : 'User invitation rejected';
        results.push(...batch.map(id => ({ id, ok: false, error,
          ...(code !== undefined ? { code } : {}), ...(logId ? { logId } : {}),
          ...(userScopeMissing ? { authorizationRequired: true } : {}) })));
        continue;
      }
      const data = body?.data;
      const lists = ['invalid_id_list', 'not_existed_id_list', 'pending_approval_id_list'] as const;
      if (!data || typeof data !== 'object' || Array.isArray(data) || lists.some(key => data[key] !== undefined
        && (!Array.isArray(data[key]) || data[key].some((id: unknown) => typeof id !== 'string')))) {
        throw new Error('Malformed invitation response');
      }
      const invalid = new Set<string>([...(data.invalid_id_list ?? []), ...(data.not_existed_id_list ?? [])]);
      const pending = new Set<string>(data.pending_approval_id_list ?? []);
      results.push(...batch.map(id => pending.has(id)
        ? { id, ok: false, error: 'User invitation awaits approval', pendingApproval: true, ...(logId ? { logId } : {}) }
        : invalid.has(id)
          ? { id, ok: false, error: 'User invitation rejected this bot', ...(logId ? { logId } : {}) }
          : { id, ok: true }));
    } catch {
      // A timeout may have committed the invite. Never retry this write or
      // switch identities; callers must inspect membership before retrying.
      results.push(...batch.map(id => ({ id, ok: false, outcomeUnknown: true,
        error: 'User invitation result is unknown; check group membership before retrying' })));
    }
  }
  return results;
}
