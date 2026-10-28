import { z } from 'zod';
import { DevRevAuthorizationError, DevRevLaunchError, readDevRevLaunch, submitDevRevLaunch, type DevRevLaunch, type DevRevLaunchDeps } from '../../workflows/v3/dev-rev-launch.js';
import { isV3SupportedCli } from '../../workflows/v3/contract.js';
import type { BotConfig } from '../../bot-registry.js';
import type { ChatBotMember } from './client.js';

export const DEV_REV_SUBMIT = 'v3_dev_rev_submit';
export const DEV_REV_CANCEL = 'v3_dev_rev_cancel';
const valueSchema = z.object({ action: z.enum([DEV_REV_SUBMIT, DEV_REV_CANCEL]),
  id: z.string().regex(/^dl_[a-f0-9]{32}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function isDevRevLaunchAction(action: unknown): boolean { return action === DEV_REV_SUBMIT || action === DEV_REV_CANCEL; }
const text = (content: string) => ({ tag: 'plain_text', content });

export function selectDevRevChatBots(bots: BotConfig[], roster: ChatBotMember[]) {
  const supported = new Set(bots.filter(bot => isV3SupportedCli(bot.cliId) && !bot.codexProfile && bot.disableCliBypass !== true).map(bot => bot.larkAppId));
  return roster.filter(bot => bot.source === 'configured' && supported.has(bot.larkAppId))
    .map(bot => ({ appId: bot.larkAppId, label: `${bot.displayName} · ${bot.name}` }));
}

export function buildDevRevLaunchCard(request: DevRevLaunch, feedback?: { message: string; form: unknown }): string {
  if (request.started || request.cancelled) return buildDevRevLaunchResult(request);
  const submitted = request.submitted;
  const defaults: Record<string, unknown> = submitted ? {
    repo: submitted.repo, requirement: submitted.requirement,
    ...Object.fromEntries(['developer', 'correctness', 'regression'].map(role =>
      [role, request.bots.find(bot => bot.appId === submitted[role as 'developer'])?.value])),
  } : feedback?.form && typeof feedback.form === 'object' ? feedback.form as Record<string, unknown> : {};
  const select = (name: string, label: string, choices: Array<{ value: string; label: string }>) => ({
    tag: 'select_static', name, width: 'fill', required: true, placeholder: text(label),
    ...(choices.some(x => x.value === defaults[name]) ? { initial_option: defaults[name] } : {}),
    options: choices.map(x => ({ value: x.value, text: text(x.label) })),
  });
  return JSON.stringify({ schema: '2.0', config: { wide_screen_mode: true },
    header: { template: 'blue', title: text('启动开发评审') },
    body: { elements: [
      ...(feedback ? [{ tag: 'markdown', content: feedback.message }] : []),
      ...(submitted ? [{ tag: 'markdown', content: `请求已提交，重试将恢复同一任务：\`${request.runId}\`。` }] : []),
      { tag: 'markdown', content: '选择仓库与三个不同的机器人，填写需求后启动。基线自动使用仓库默认分支，任务在独立 worktree 中开发。' },
      { tag: 'form', name: 'dev_rev_launch', elements: [
        { tag: 'markdown', content: '**仓库**' },
        select('repo', '选择仓库', request.repos),
        { tag: 'markdown', content: '**开发**' },
        select('developer', '开发机器人', request.bots),
        { tag: 'markdown', content: '**正确性评审**' },
        select('correctness', '正确性评审机器人', request.bots),
        { tag: 'markdown', content: '**回归评审**' },
        select('regression', '回归评审机器人', request.bots),
        { tag: 'markdown', content: '**需求**' },
        { tag: 'input', name: 'requirement', input_type: 'multiline_text', required: true,
          ...(typeof defaults.requirement === 'string' ? { default_value: defaults.requirement.slice(0, 12000) } : {}),
          placeholder: text('填写需求和验收标准，或粘贴需求文档链接') },
        { tag: 'button', name: 'start', text: text(submitted ? '恢复启动' : '开始开发评审'), type: 'primary', action_type: 'form_submit',
          value: { action: DEV_REV_SUBMIT, id: request.id, nonce: request.nonce } },
      ] },
      ...(!submitted ? [{ tag: 'button', text: text('取消'), type: 'default',
        value: { action: DEV_REV_CANCEL, id: request.id, nonce: request.nonce } }] : []),
      { tag: 'markdown', content: '仅发起人可提交；文档无权限时会等待授权。创建 PR/MR 前仍需人工确认。' },
    ] },
  });
}
export function buildDevRevLaunchResult(result: { runId: string; cancelled: boolean; started: boolean }): string {
  return JSON.stringify({ schema: '2.0', header: {
    template: result.cancelled ? 'grey' : 'green', title: text(result.cancelled ? '已取消启动' : '开发评审已启动'),
  }, body: { elements: [{ tag: 'markdown', content: result.cancelled ? '本次未启动开发任务。' :
    `工作流：\`${result.runId}\`\n认证与需求预检 → 准备 worktree → 开发与评审 → PR/MR 审批。` }] } });
}
export async function handleDevRevLaunchAction(
  raw: unknown, form: unknown, operator: string | undefined, appId: string | undefined,
  cardMessageId: string | undefined, deps: DevRevLaunchDeps,
): Promise<unknown> {
  const value = valueSchema.safeParse(raw);
  if (!value.success || !operator || !appId || !cardMessageId) {
    return { toast: { type: 'error', content: '无法确认启动卡片身份，请重新发送命令。' } };
  }
  try {
    const result = await submitDevRevLaunch({ ...value.data, form, operator, appId, cardMessageId,
      cancel: value.data.action === DEV_REV_CANCEL }, deps);
    return { card: { type: 'raw', data: JSON.parse(buildDevRevLaunchResult(result)) } };
  } catch (error) {
    deps.onError?.(value.data.id, error);
    const message = error instanceof DevRevLaunchError ? error.message :
      '启动尚未完成。请重试原卡片，将恢复同一请求；仍失败时联系管理员。';
    // Slow callback ACKs cannot show a later toast. Return a real card update
    // for recoverable failures, retaining the user's inputs and original nonce.
    if (!(error instanceof DevRevAuthorizationError)) {
      try {
        const request = readDevRevLaunch(deps.dataDir, value.data.id);
        if (request.context.actor.openId === operator && request.context.actor.larkAppId === appId &&
          request.cardMessageId === cardMessageId && request.nonce === value.data.nonce) {
          return { card: { type: 'raw', data: JSON.parse(buildDevRevLaunchCard(request, { message, form })) } };
        }
      } catch { /* Malformed or missing requests have no trusted card to patch. */ }
    }
    return { toast: { type: 'error', content: message } };
  }
}
