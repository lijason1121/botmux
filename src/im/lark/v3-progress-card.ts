/**
 * v3 run-level progress card.
 *
 * This is intentionally a pure renderer: the journal/envelope projection lives
 * in `workflows/v3/progress-projection.ts`, while daemon-side send/PATCH
 * lifecycle lives elsewhere.  Keeping the card on the projected allowlist is
 * also a data-boundary — goals, parameter values, error messages and local
 * paths never reach this renderer.
 */

import { config } from '../../config.js';
import { buildV3RunDetailUrl, buildV3TerminalUrl } from '../../core/dashboard-url.js';
import type { V3ProgressView } from '../../workflows/v3/progress-projection.js';
import { readRunEnvelope } from '../../workflows/v3/run-envelope.js';
import type { V3RunSaveActionValue } from './v3-run-save-card.js';
import { buildWorkflowSidebarEntryV1Button, type WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

export interface V3ProgressCardOptions {
  /** Override the dashboard link (primarily for tests). */
  webDetailUrl?: string;
  /**
   * Pre-authorized action payloads prepared from the immutable run envelope.
   * The renderer never derives identity or nonces itself.
   */
  saveActions?: {
    chat: V3RunSaveActionValue;
  };
  /**
   * §11.1: for runs whose nodes are handed to bots in the chat, the「Web 详情
   * （需登录）」button becomes the same「工作流 ›」sidebar entry the task
   * messages carry. Absent = the card is exactly what it always was.
   */
  workflowEntry?: WorkflowSidebarEntryLink;
  /**
   * Render clock for elapsed durations. Only statuses the card manager keeps
   * polling use it, so a settled card never shows a frozen "elapsed" value.
   * Absent = journal times only (deterministic output).
   */
  now?: Date;
}

/**
 * The progress card's sidebar entry: only a run pinned to `nodeExecutor:
 * "bot"` gets one (design §11.1 / §15.1 — every other run keeps its card
 * byte-for-byte), and only when the host can name its Dashboard address.
 */
export function v3ProgressWorkflowEntry(
  envelope: { runId: string; nodeExecutor?: 'bot'; chatBinding?: { larkAppId: string } },
  entryFor: (mainLarkAppId: string, runId: string) => WorkflowSidebarEntryLink | undefined,
): WorkflowSidebarEntryLink | undefined {
  if (envelope.nodeExecutor !== 'bot' || !envelope.chatBinding?.larkAppId) return undefined;
  return entryFor(envelope.chatBinding.larkAppId, envelope.runId);
}

/**
 * The same entry for the other main-topic cards of a run known only by its
 * directory — the flow-revision confirmation and rerun-grant cards (§11.1):
 * read from its run.json, so again only a run pinned to `nodeExecutor: "bot"`
 * gets one. Unreadable run.json → no entry (the card keeps its old shape).
 */
export function v3RunWorkflowEntry(
  runDir: string,
  runId: string,
  entryFor: (mainLarkAppId: string, runId: string) => WorkflowSidebarEntryLink | undefined,
): WorkflowSidebarEntryLink | undefined {
  const read = readRunEnvelope(runDir, runId);
  return read.kind === 'ok' ? v3ProgressWorkflowEntry(read.envelope, entryFor) : undefined;
}

const MAX_INLINE_IDS = 5;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1_000;
/** Statuses whose card the manager keeps re-rendering on its polling tick. */
const LIVE_STATUSES: ReadonlySet<V3ProgressView['status']> = new Set(['starting', 'running', 'cancelling']);
const TERMINAL_STATUSES: ReadonlySet<V3ProgressView['status']> = new Set(['succeeded', 'failed', 'cancelled']);

export function v3ProgressRunDetailUrl(runId: string): string {
  return buildV3RunDetailUrl(runId, { host: config.dashboard.externalHost, port: config.dashboard.port });
}

/** Render one complete Feishu card body from the safe v3 progress projection. */
export function buildV3ProgressCard(
  view: V3ProgressView,
  options: V3ProgressCardOptions = {},
): string {
  const chrome = statusChrome(view.status);
  if (view.status === 'succeeded' && view.reviews?.some(review => review.decision !== 'approve')) {
    chrome.emoji = '📋'; chrome.template = 'orange'; chrome.label = '执行完成 · 审查未通过';
  }
  const completed = view.counts.done + view.counts.skipped + view.counts.cancelled;
  const webDetailUrl = options.webDetailUrl ?? v3ProgressRunDetailUrl(view.runId);
  const terminalUrl = view.terminal
    ? buildV3TerminalUrl(view.terminal.sessionId, {
        host: config.dashboard.externalHost,
        webPort: view.terminal.webPort,
        viewToken: view.terminal.viewToken,
      })
    : null;
  const source = sourceLabel(view.source);
  const now = options.now && LIVE_STATUSES.has(view.status) ? options.now.getTime() : undefined;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**状态**\n${chrome.emoji} ${chrome.label}` },
        },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**进度**\n${completed} / ${view.counts.total} 节点完成`,
          },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**来源**\n${escapeMd(source)}` },
        },
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**Run ID**\n${escapeMd(view.runId)}` },
        },
      ],
    },
    {
      tag: 'note',
      elements: [{ tag: 'plain_text', content: timeNote(view, now) }],
    },
  ];

  if (view.currentNodeIds.length > 0) {
    appendSection(elements, '🏃 当前节点', formatCurrentNodes(view, now));
  }

  if (view.waitingNodeIds.length > 0) {
    appendSection(elements, '⏸ 等待', formatIdList(view.waitingNodeIds));
  }

  if (view.reviews?.length) {
    const labels = { approve: '审查通过', changes_requested: '要求修改', blocked: '证据不足，审查阻塞' };
    appendSection(elements, '审查结论', view.reviews.map(review => `${escapeMd(review.nodeId)}：${labels[review.decision]}`).join('\n'));
  }

  if (view.loops.length > 0) {
    appendSection(
      elements,
      '🔁 循环',
      view.loops.map((loop) => {
        const effectiveMax = loop.maxIterations + loop.granted;
        const budget = effectiveMax > 0 ? ` / ${effectiveMax}` : '';
        const grant = loop.granted > 0 ? ` · 已追加 ${loop.granted} 轮` : '';
        const decision = loop.lastDecision ? ` · ${loopDecisionLabel(loop.lastDecision)}` : '';
        return `${escapeMd(loop.loopId)}：第 ${loop.iteration}${budget} 轮${grant}${decision}`;
      }).join('\n'),
    );
  }

  if (view.revision) {
    const latest = view.revision.edits > 0
      ? `第 ${view.revision.current} 版 · 最近修改：${escapeMd(view.revision.lastSummary ?? '')}`
      : `第 ${view.revision.current} 版`;
    const pending = view.revision.pending !== undefined
      ? `\n第 ${view.revision.pending} 版待发起人确认，涉及的节点暂停派发`
      : '';
    appendSection(elements, '📝 流程版本', `${latest}${pending}`);
  }

  if (view.revisit.count > 0) {
    const refreshed = view.revisit.refreshedNodeIds.length > 0
      ? ` · 刷新 ${formatIdList(view.revisit.refreshedNodeIds)}`
      : '';
    appendSection(elements, '↩️ 回访', `${view.revisit.count} 次${refreshed}`);
  }

  if (view.issue) {
    const parts: string[] = [];
    if (view.issue.nodeId) parts.push(`节点 ${escapeMd(view.issue.nodeId)}`);
    if (view.issue.errorClass) parts.push(escapeMd(view.issue.errorClass));
    if (view.issue.errorCode) parts.push(`\`${escapeMd(view.issue.errorCode)}\``);
    appendSection(elements, '⚠️ 错误码', parts.length > 0 ? parts.join(' · ') : 'UNKNOWN');
    const recovery: Record<string, string> = {
      AUTH_REQUIRED: '完成对应 CLI 的登录或授权后重试当前节点。',
      PROVIDER_QUOTA_EXHAUSTED: '额度恢复后重试当前节点；已完成节点与旧 attempt 保留。',
      PROVIDER_AUTH_REQUIRED: '完成对应 CLI 的登录或授权后重试当前节点。',
      WORKER_CONFIGURATION_INVALID: '先修正 CLI、模型或产物配置；不会自动重复执行。',
      WORKER_TIMEOUT: '本次执行已达到时限；核对阶段检查点和未完成项后恢复。',
      WORKER_OUTPUT_BUDGET: '输出或日志达到预算；精简输出后从已保存的阶段产物恢复。',
      PROVIDER_TRANSIENT_FAILURE: '网络暂时失败；已执行的操作先核对结果，再重试。',
    };
    if (view.issue.errorCode && Object.hasOwn(recovery, view.issue.errorCode)) {
      appendSection(elements, '恢复条件', recovery[view.issue.errorCode]!);
    }
  }

  if (view.feishuHostFailed) {
    appendSection(
      elements,
      'Feishu host 节点失败',
      view.upstreamNonHostFinished
        ? '上游非 host 节点已完成，失败发生在 Feishu host 节点。该节点可能是通知，也可能是业务交付；请按 DAG 语义核对后再决定是否重试。'
        : '失败发生在 Feishu host 节点。该节点可能是通知，也可能是业务交付；其它业务节点状态请以节点进度为准。',
    );
  }

  if (view.uncertainHostEffectCount && view.uncertainHostEffectCount > 0) {
    appendSection(
      elements,
      '⚠️ 外部效果待核实',
      `流程已停止，但有 ${view.uncertainHostEffectCount} 个外部操作的最终状态无法确认。请在 Web 详情中核对，不要直接重试该节点。`,
    );
  }

  appendTerminalHint(elements, view);

  if (
    view.status === 'starting' ||
    view.status === 'running' ||
    view.status === 'waiting' ||
    view.status === 'blocked'
  ) {
    appendSection(elements, '停止运行', `\`/workflow cancel ${escapeMd(view.runId)}\``);
  }

  if (view.status === 'succeeded' && view.source.kind === 'ad_hoc' && options.saveActions) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '保存到本群' },
          type: 'primary',
          value: options.saveActions.chat,
        },
      ],
    });
  }

  if (terminalUrl) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '终端（手机可看）' },
          type: 'primary',
          multi_url: {
            url: terminalUrl,
            pc_url: terminalUrl,
            android_url: terminalUrl,
            ios_url: terminalUrl,
          },
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      options.workflowEntry
        ? buildWorkflowSidebarEntryV1Button(options.workflowEntry)
        : {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Web 详情（需登录）' },
            type: 'default',
            multi_url: {
              url: webDetailUrl,
              pc_url: webDetailUrl,
              android_url: webDetailUrl,
              ios_url: webDetailUrl,
            },
          },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: chrome.template,
      title: { tag: 'plain_text', content: headerTitle(view, chrome) },
    },
    elements,
  });
}

function headerTitle(
  view: V3ProgressView,
  chrome: ReturnType<typeof statusChrome>,
): string {
  const title = sanitizePlainTitle(view.title);
  return title
    ? `${chrome.emoji} ${title} · ${chrome.label}`
    : `${chrome.emoji} Workflow v3 · ${chrome.label}`;
}

function appendSection(
  elements: Array<Record<string, unknown>>,
  title: string,
  content: string,
): void {
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${title}**\n${content}` },
  });
}

function appendTerminalHint(
  elements: Array<Record<string, unknown>>,
  view: V3ProgressView,
): void {
  if (view.status !== 'succeeded') return;

  if (view.source.kind === 'ad_hoc') {
    appendSection(
      elements,
      '保存复用',
      `\`/workflow save ${escapeMd(view.runId)} [名称]\``,
    );
  } else if (view.source.kind === 'saved_definition') {
    appendSection(
      elements,
      '再次运行',
      `来源：${escapeMd(view.source.workflowId)} · v${view.source.humanVersion}\n` +
        `\`/workflow run ${escapeMd(view.source.workflowId)}\``,
    );
  }
}

function sourceLabel(source: V3ProgressView['source']): string {
  switch (source.kind) {
    case 'ad_hoc': return '即兴编排';
    case 'saved_definition': return `已保存 · ${source.workflowId} · v${source.humanVersion}`;
    case 'manual_cli': return '本地 CLI';
    case 'legacy_v3': return '旧版 v3';
  }
}

function statusChrome(status: V3ProgressView['status']): {
  emoji: string;
  label: string;
  template: string;
} {
  switch (status) {
    case 'starting': return { emoji: '⏳', label: '准备中', template: 'blue' };
    case 'running': return { emoji: '🔄', label: '运行中', template: 'blue' };
    case 'cancelling': return { emoji: '⏹', label: '取消中', template: 'orange' };
    case 'cancelled': return { emoji: '⏹', label: '已取消', template: 'grey' };
    case 'waiting': return { emoji: '⏸', label: '等待中', template: 'orange' };
    case 'blocked': return { emoji: '🚧', label: '已阻塞', template: 'orange' };
    case 'succeeded': return { emoji: '✅', label: '已完成', template: 'green' };
    case 'failed': return { emoji: '❌', label: '失败', template: 'red' };
  }
}

function loopDecisionLabel(decision: NonNullable<V3ProgressView['loops'][number]['lastDecision']>): string {
  switch (decision) {
    case 'exit': return '已退出';
    case 'continue': return '继续';
    case 'exhausted': return '轮次耗尽';
  }
}

function formatIdList(ids: readonly string[]): string {
  const visible = ids.slice(0, MAX_INLINE_IDS).map(escapeMd);
  const remaining = ids.length - visible.length;
  return `${visible.join('、')}${remaining > 0 ? ` 等 ${ids.length} 个` : ''}`;
}

function timeNote(view: V3ProgressView, now: number | undefined): string {
  const startedAt = view.timing?.startedAt;
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (!startedAt || !Number.isFinite(started)) return `更新时间：${formatBeijing(view.updatedAt)}（北京时间）`;
  const parts = [`开始 ${formatBeijing(startedAt)}`];
  const finishedAt = view.timing?.finishedAt;
  const finished = finishedAt ? Date.parse(finishedAt) : NaN;
  if (finishedAt && Number.isFinite(finished) && TERMINAL_STATUSES.has(view.status)) {
    parts.push(`结束 ${formatBeijing(finishedAt)}`, `总耗时 ${formatElapsed(finished - started)}`);
  } else if (now !== undefined) {
    parts.push(`已运行 ${formatElapsed(now - started)}`, `刷新于 ${formatBeijing(new Date(now).toISOString(), 'time')}`);
  } else {
    parts.push(`更新于 ${formatBeijing(view.updatedAt)}`);
  }
  return `${parts.join(' · ')}（北京时间）`;
}

function formatCurrentNodes(view: V3ProgressView, now: number | undefined): string {
  const active = view.timing?.active ?? [];
  if (active.length === 0) return formatIdList(view.currentNodeIds);
  const lines = view.currentNodeIds.flatMap((nodeId) => {
    const entries = active.filter((entry) => entry.nodeId === nodeId);
    return entries.length > 0 ? entries.map((entry) => formatActiveNode(entry, now)) : [escapeMd(nodeId)];
  });
  const visible = lines.slice(0, MAX_INLINE_IDS);
  return `${visible.join('\n')}${lines.length > visible.length ? `\n等 ${lines.length} 个` : ''}`;
}

function formatActiveNode(
  entry: NonNullable<V3ProgressView['timing']>['active'][number],
  now: number | undefined,
): string {
  const parts = [escapeMd(entry.bodyNodeId ? `${entry.nodeId}/${entry.bodyNodeId}` : entry.nodeId)];
  if (entry.attempt && entry.attempt > 1) parts.push(`第 ${entry.attempt} 次尝试`);
  parts.push(`${formatBeijing(entry.startedAt, 'time')} 开始`);
  const started = Date.parse(entry.startedAt);
  const elapsed = now !== undefined && Number.isFinite(started) ? `已运行 ${formatElapsed(now - started)}` : undefined;
  const limit = entry.timeoutSec ? `上限 ${formatLimit(entry.timeoutSec)}` : undefined;
  const budget = [elapsed, limit].filter(Boolean).join(' / ');
  if (budget) parts.push(budget);
  return parts.join(' · ');
}

/**
 * Asia/Shanghai has no DST, so a fixed offset keeps PATCHes/tests identical
 * across host time zones and locales.
 */
function formatBeijing(iso: string, precision: 'minute' | 'time' = 'minute'): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return escapePlainText(iso);
  const local = new Date(ms + BEIJING_OFFSET_MS).toISOString();
  return precision === 'time' ? local.slice(11, 16) : `${local.slice(5, 10)} ${local.slice(11, 16)}`;
}

/** Whole minutes, so a live card changes at most once a minute. */
function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} 天${hours > 0 ? ` ${hours} 小时` : ''}`;
  if (hours > 0) return `${hours} 小时${rest > 0 ? ` ${rest} 分钟` : ''}`;
  return `${rest} 分钟`;
}

function formatLimit(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  const parts = [
    [Math.floor(total / 3_600), '小时'],
    [Math.floor((total % 3_600) / 60), '分钟'],
    [total % 60, '秒'],
  ] as const;
  return parts.filter(([value]) => value > 0).map(([value, unit]) => `${value} ${unit}`).join(' ');
}

function sanitizePlainTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Plain text cannot inject markdown, but line/control characters can still
  // distort the header. Collapse them, then truncate by Unicode code point so
  // an emoji/surrogate pair is never cut in half.
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const chars = Array.from(normalized);
  return chars.length <= 60 ? normalized : `${chars.slice(0, 60).join('')}…`;
}

/** Escape user-controlled identifiers in Lark markdown fields. */
function escapeMd(value: string): string {
  return value.replace(/[\\*_~`\[\]<>]/g, (char) => `\\${char}`);
}

/** Plain-text card fields do not parse markdown but must not accept newlines. */
function escapePlainText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}
