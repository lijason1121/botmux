/** Durable, requester-bound launch form for the reviewed development preset. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import type { BotConfig } from '../../bot-registry.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { createDevelopmentReviewPreset } from './presets/development-review.js';
import { upgradeDevelopmentReviewPreset } from './presets/development-review-upgrade.js';
import { canonicalJsonStringify, type SavedWorkflowRevisionPayload } from './library-schema.js';
import { coerceWorkflowParams } from '../shared/params.js';
import { appendSavedWorkflowRevision, createSavedWorkflow } from './library-store.js';
import { instantiatePublishedSavedWorkflow, listVisibleSavedWorkflows, loadVisibleSavedWorkflow,
  requireActorContext, type SavedWorkflowActorContext } from './library-service.js';
import { loadAuthorizedV3Run } from './run-envelope.js';

export const DEV_REV_ROLES = ['developer', 'correctness', 'regression'] as const;
export const DEV_REV_MODES = ['new', 'review', 'continue'] as const;
const choice = z.object({ value: z.string().min(1), label: z.string().min(1).max(160) }).strict();
const schema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^dl_[a-f0-9]{32}$/),
  nonce: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite(),
  context: z.object({ actor: z.object({ openId: z.string().min(1), larkAppId: z.string().min(1) }).strict(),
    chatId: z.string().min(1), chatType: z.enum(['group', 'p2p']).optional(), rootMessageId: z.string().min(1) }).strict(),
  cardMessageId: z.string().optional(),
  repos: z.array(choice.extend({ path: z.string().min(1), commonDir: z.string().min(1) })).max(100),
  bots: z.array(choice.extend({ appId: z.string().min(1) })).max(100),
  runId: z.string().regex(/^devrev-[a-f0-9]{32}$/),
  submitted: z.object({ repo: z.string(), requirement: z.string().min(1).max(12000),
    // Absent only on requests frozen before modes existed; their revision has no mode input.
    mode: z.enum(DEV_REV_MODES).optional(),
    developer: z.string(), correctness: z.string(), regression: z.string(),
    targetBranch: z.string().min(1), workflowId: z.string().min(1), revisionId: z.string().min(1) }).strict().optional(),
  started: z.boolean().default(false), cancelled: z.boolean().default(false),
}).strict();
export type DevRevLaunch = z.infer<typeof schema>;
export interface DevRevBotChoice { appId: string; label: string }
export class DevRevLaunchError extends Error {}
export class DevRevAuthorizationError extends DevRevLaunchError {
  constructor() { super('只有发起人可在原群和原机器人下操作此卡片。'); }
}
function fail(message: string): never { throw new DevRevLaunchError(message); }
function file(dataDir: string, id: string): string {
  if (!/^dl_[a-f0-9]{32}$/.test(id)) fail('启动卡片已失效，请重新发送命令。');
  return join(dataDir, 'workflow-launches', `${id}.json`);
}
function save(dataDir: string, request: DevRevLaunch): void {
  atomicWriteFileSync(file(dataDir, request.id), JSON.stringify(schema.parse(request)), { mode: 0o600, durable: true });
}
export function readDevRevLaunch(dataDir: string, id: string): DevRevLaunch {
  return schema.parse(JSON.parse(readFileSync(file(dataDir, id), 'utf8')));
}
function git(repo: string, args: string[]): string | undefined {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim(); }
  catch { return undefined; }
}
export function devRevRepoIdentity(path: string): { path: string; commonDir: string } {
  const actual = realpathSync(path);
  const top = git(actual, ['rev-parse', '--show-toplevel']);
  const common = git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!top || realpathSync(top) !== actual || !common) fail('请选择有效的仓库根目录。');
  return { path: actual, commonDir: realpathSync(common) };
}
/** Use repository default metadata; never silently use the currently checked-out task. */
export function resolveDevRevDefaultBranch(repo: string): string {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) {
    if (git(repo, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`])) return head;
    fail('远端默认分支尚未获取，请先同步该仓库后重试原卡片。');
  }
  for (const refs of [['origin/main', 'origin/master'], ['main', 'master']]) {
    const found = refs.filter(ref => git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]));
    if (found.length === 1) return found[0]!;
    if (found.length > 1) break;
  }
  fail('无法唯一确定仓库默认分支，请先配置远端默认分支后重新提交。');
}
/** New development starts from the local default branch; PR modes use the PR target after fetching. */
export function resolveDevRevLocalDefaultBranch(repo: string, mode: typeof DEV_REV_MODES[number]): string {
  if (mode !== 'new') {
    // Informational only: preflight takes the base from the PR target it fetches.
    try { return resolveDevRevDefaultBranch(repo).replace(/^origin\//, ''); } catch { return 'pr-target'; }
  }
  const name = resolveDevRevDefaultBranch(repo).replace(/^origin\//, '');
  if (!git(repo, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${name}^{commit}`])) {
    fail(`本地没有默认分支 ${name}，请先在仓库中创建该分支后重试原卡片。`);
  }
  return name;
}
export async function createDevRevLaunch(input: {
  dataDir: string; context: SavedWorkflowActorContext; requestKey: string;
  repos: Array<{ path: string; label: string }>; bots: DevRevBotChoice[]; now?: number;
}): Promise<DevRevLaunch> {
  const context = requireActorContext(input.context, { requireChat: true });
  if (!context.rootMessageId || context.rootMessageId.startsWith('oc_') || !input.requestKey.trim()) fail('无法确认发起消息，请重新发送命令。');
  mkdirSync(join(input.dataDir, 'workflow-launches'), { recursive: true, mode: 0o700 });
  // Stable per inbound message: redelivery and daemon recovery reuse the same form.
  const id = 'dl_' + createHash('sha256').update(canonicalJsonStringify([context, input.requestKey])).digest('hex').slice(0, 32);
  return withFileLock(file(input.dataDir, id), async () => {
    if (existsSync(file(input.dataDir, id))) return readDevRevLaunch(input.dataDir, id);
    const seen = new Set<string>();
    const repos = input.repos.slice(0, 100).flatMap(repo => {
      try {
        const identity = devRevRepoIdentity(repo.path);
        if (seen.has(identity.commonDir)) return [];
        seen.add(identity.commonDir);
        return [{ ...identity, label: repo.label.slice(0, 160), value: `repo-${seen.size}` }];
      } catch { return []; }
    }).slice(0, 100);
    const bots = [...new Map(input.bots.map(bot => [bot.appId, bot])).values()].slice(0, 100)
      .map((bot, i) => ({ ...bot, label: bot.label.slice(0, 160), value: `bot-${i}` }));
    if (!repos.length) fail('未找到可选仓库，请先配置机器人的仓库扫描目录。');
    if (bots.length < 3) fail('本群至少需要三个已配置且支持工作流的机器人，请添加后重新运行。');
    const request = schema.parse({ schemaVersion: 1, id, nonce: randomBytes(32).toString('hex'),
      context, expiresAt: (input.now ?? Date.now()) + 86400000, repos, bots,
      runId: `devrev-${id.slice(3)}`, started: false, cancelled: false });
    save(input.dataDir, request);
    return request;
  });
}
export async function bindDevRevLaunchCard(dataDir: string, id: string, cardMessageId: string): Promise<void> {
  await withFileLock(file(dataDir, id), async () => {
    const request = readDevRevLaunch(dataDir, id);
    if (request.cardMessageId && request.cardMessageId !== cardMessageId) fail('启动卡片已发布，请使用原卡片。');
    request.cardMessageId = cardMessageId; save(dataDir, request);
  });
}
export async function ensureDevelopmentReviewPreset(dataDir: string, context: SavedWorkflowActorContext, selected: Record<string, string>) {
  const lock = join(dataDir, '.dev-rev-author-' + createHash('sha256').update(canonicalJsonStringify([context.actor, context.chatId])).digest('hex'));
  return withFileLock(lock, async () => {
    const listed = await listVisibleSavedWorkflows({ dataDir, context });
    const own = listed.entries.filter(entry => entry.displayName === 'dev-rev' &&
      entry.owner.openId === context.actor.openId && entry.owner.larkAppId === context.actor.larkAppId &&
      entry.scope.kind === 'chat' && entry.scope.chatId === context.chatId);
    if (own.length > 1) fail('本群存在多个同名流程，请先整理 dev-rev 定义。');
    if (own.length) {
      const loaded = await loadVisibleSavedWorkflow({ dataDir, context, ref: own[0]!.workflowId });
      const { workflowId: _id, humanVersion: _v, createdAt: _at, createdBy: _by, ...draft } = loaded.revision.payload;
      const defaults = Object.fromEntries(DEV_REV_ROLES.map(role => [role, draft.roles?.[role]?.defaultBot]));
      const upgrade = loaded.metadata.status === 'active' ? upgradeDevelopmentReviewPreset(draft) : undefined;
      if (upgrade) {
        return appendSavedWorkflowRevision(dataDir, loaded.metadata.workflowId, {
          actor: context.actor, revision: upgrade, publish: true, expectedLatestRevision: loaded.metadata.latestRevision,
        });
      }
      if (loaded.metadata.status !== 'active' || canonicalJsonStringify(draft) !== canonicalJsonStringify(
        createDevelopmentReviewPreset(defaults as unknown as Parameters<typeof createDevelopmentReviewPreset>[0]))) {
        fail('同名 dev-rev 与当前内置预设不同，请更新定义或更名后重试。');
      }
      return loaded;
    }
    return createSavedWorkflow(dataDir, { displayName: 'dev-rev', owner: context.actor,
      scope: { kind: 'chat', chatId: context.chatId! },
      revision: createDevelopmentReviewPreset(selected as unknown as Parameters<typeof createDevelopmentReviewPreset>[0]) });
  });
}
export interface DevRevLaunchDeps {
  dataDir: string; baseDir: string;
  resolveMessageChatId(appId: string, messageId: string): Promise<string | null>;
  authorize(appId: string, chatId: string, operator: string): boolean;
  listChatBots(appId: string, chatId: string): Promise<DevRevBotChoice[]>;
  loadBots(): BotConfig[];
  persistStartIntent(runId: string, runDir: string): void;
  driveDetached(runId: string): void;
  onError?(id: string, error: unknown): void;
}
export async function submitDevRevLaunch(input: {
  id: string; nonce: string; operator: string; appId: string; cardMessageId: string;
  form: unknown; cancel?: boolean; now?: number;
}, deps: DevRevLaunchDeps): Promise<{ runId: string; cancelled: boolean; started: boolean }> {
  return withFileLock(file(deps.dataDir, input.id), async () => {
    const r = readDevRevLaunch(deps.dataDir, input.id), ctx = r.context;
    if (r.nonce !== input.nonce || ctx.actor.openId !== input.operator || ctx.actor.larkAppId !== input.appId ||
      !r.cardMessageId || r.cardMessageId !== input.cardMessageId ||
      await deps.resolveMessageChatId(input.appId, input.cardMessageId) !== ctx.chatId ||
      !deps.authorize(input.appId, ctx.chatId, input.operator)) throw new DevRevAuthorizationError();
    if (r.started || r.cancelled) return { runId: r.runId, cancelled: r.cancelled, started: r.started };
    if (r.expiresAt < (input.now ?? Date.now())) fail('启动卡片已过期，请重新发送命令。');
    if (input.cancel) {
      if (r.submitted) fail('启动请求已提交，请重试启动或使用工作流取消命令。');
      r.cancelled = true; save(deps.dataDir, r);
      return { runId: r.runId, cancelled: true, started: false };
    }
    if (!r.submitted) {
      const form = z.object({ repo: z.string(), mode: z.enum(DEV_REV_MODES), developer: z.string(), correctness: z.string(), regression: z.string(),
        requirement: z.string().trim().min(1).max(12000) }).strict().safeParse(input.form);
      if (!form.success) fail('请选择仓库、模式和三个角色，并填写需求文字、文档链接或 PR 链接。');
      const f = form.data;
      const repo = r.repos.find(x => x.value === f.repo);
      if (!repo) fail('仓库选项无效，请重新选择。');
      const actual = devRevRepoIdentity(repo.path);
      if (actual.commonDir !== repo.commonDir) fail('仓库已变化，请重新打开启动卡片。');
      const selected = Object.fromEntries(DEV_REV_ROLES.map(role => [role, r.bots.find(x => x.value === f[role])?.appId]));
      if (Object.values(selected).some(x => !x) || new Set(Object.values(selected)).size !== 3) fail('三个角色必须选择不同的本群机器人。');
      const targetBranch = resolveDevRevLocalDefaultBranch(repo.path, f.mode);
      // Validate live membership before authoring a definition or publishing a run.
      const members = new Set((await deps.listChatBots(input.appId, ctx.chatId)).map(x => x.appId));
      if (Object.values(selected).some(appId => !members.has(appId!))) fail('所选机器人已离群或无法确认成员身份，请重新打开卡片。');
      const saved = await ensureDevelopmentReviewPreset(deps.dataDir, ctx, selected as Record<string, string>);
      r.submitted = { repo: repo.value, mode: f.mode, requirement: f.requirement, targetBranch,
        developer: selected.developer!, correctness: selected.correctness!, regression: selected.regression!,
        workflowId: saved.metadata.workflowId, revisionId: saved.revision.revisionId };
      save(deps.dataDir, r); // Durable frozen submission before any run publication.
    }
    const s = r.submitted!, repo = r.repos.find(x => x.value === s.repo)!;
    const members = new Set((await deps.listChatBots(input.appId, ctx.chatId)).map(x => x.appId));
    if (DEV_REV_ROLES.some(role => !members.has(s[role]))) fail('所选机器人已离群，请重新发起。');
    const roleSelections = Object.fromEntries(DEV_REV_ROLES.map(role => [role, s[role]]));
    const rawParams = { ...(s.mode ? { mode: { kind: 'string' as const, value: s.mode } } : {}),
      repo_path: { kind: 'string' as const, value: repo.path },
      requirement: { kind: 'string' as const, value: s.requirement },
      target_branch: { kind: 'string' as const, value: s.targetBranch },
      validation_commands: { kind: 'json' as const, value: [] } };
    const runDir = join(deps.baseDir, r.runId);
    if (!existsSync(runDir)) {
      const current = await loadVisibleSavedWorkflow({ dataDir: deps.dataDir, context: ctx, ref: s.workflowId });
      if (current.revision.revisionId !== s.revisionId) fail('流程定义已变化，请重新发起。');
      const actual = devRevRepoIdentity(repo.path);
      if (actual.commonDir !== repo.commonDir) fail('仓库已变化，请重新发起。');
      await instantiatePublishedSavedWorkflow({ dataDir: deps.dataDir, baseDir: deps.baseDir,
        ref: s.workflowId, runId: r.runId, context: ctx, roleSelections, rawParams, bots: deps.loadBots() });
    }
    // Recover the publish -> journal-intent crash window using exactly this run.
    const loaded = loadAuthorizedV3Run(runDir);
    const definition = (loaded.definitionSnapshot as { definition: SavedWorkflowRevisionPayload }).definition;
    const expectedParams = coerceWorkflowParams({ params: definition.inputs }, rawParams);
    if (loaded.envelope.source.kind !== 'saved_definition' || loaded.envelope.source.workflowId !== s.workflowId ||
      loaded.envelope.source.revisionId !== s.revisionId ||
      loaded.envelope.chatBinding?.ownerOpenId !== ctx.actor.openId ||
      loaded.envelope.chatBinding?.larkAppId !== ctx.actor.larkAppId ||
      loaded.envelope.chatBinding?.chatId !== ctx.chatId ||
      loaded.envelope.chatBinding?.rootMessageId !== ctx.rootMessageId ||
      canonicalJsonStringify((loaded.resolvedParams as { params?: unknown })?.params) !== canonicalJsonStringify(expectedParams) ||
      DEV_REV_ROLES.some(role => (loaded.resolvedRoles as Record<string, { bot: string }>)?.[role]?.bot !== s[role])) {
      fail('启动记录与已物化流程不一致，已停止启动。');
    }
    deps.persistStartIntent(r.runId, runDir);
    deps.driveDetached(r.runId);
    r.started = true; save(deps.dataDir, r);
    return { runId: r.runId, cancelled: false, started: true };
  });
}
