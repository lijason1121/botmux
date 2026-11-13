import { describe, it, expect } from 'vitest';
import {
  buildV3GateCard,
  v3GateCardNonce,
  V3_GATE_APPROVE_ACTION,
  V3_GATE_REJECT_ACTION,
} from '../src/im/lark/v3-gate-card.js';
import { composeV3HostGatePrompt } from '../src/workflows/v3/host-bindings.js';

function parse(card: string): any {
  return JSON.parse(card);
}

/** collect all button `value` objects in the card. */
function buttonValues(card: any): any[] {
  const out: any[] = [];
  for (const el of card.elements ?? []) {
    if (el.tag === 'action') {
      for (const a of el.actions ?? []) {
        if (a.value) out.push(a.value);
      }
    }
  }
  return out;
}

describe('v3-gate-card — buildV3GateCard', () => {
  const base = { runId: 'demo-260603-1700', waitId: 'send-gate', nodeId: 'send', prompt: '要对外发送，批准？' };

  it('pending 卡：blue header + 通过/拒绝按钮带 {action,runId,waitId,nonce}', () => {
    const card = parse(buildV3GateCard(base));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('需要审批');
    const vals = buttonValues(card);
    const approve = vals.find((v) => v.action === V3_GATE_APPROVE_ACTION);
    const reject = vals.find((v) => v.action === V3_GATE_REJECT_ACTION);
    expect(approve).toEqual({
      action: V3_GATE_APPROVE_ACTION, runId: base.runId, waitId: base.waitId, nodeId: base.nodeId,
      nonce: v3GateCardNonce(base.runId, base.waitId), selected: 'approve',
    });
    expect(reject).toMatchObject({ action: V3_GATE_REJECT_ACTION, runId: base.runId, waitId: base.waitId, selected: 'reject' });
  });

  it('不展示冗余的 Run/节点字段，审批回调仍绑定同一个 run 和节点', () => {
    const card = parse(buildV3GateCard(base));
    const body = JSON.stringify(card.elements.filter((el: any) => el.tag !== 'action'));
    expect(body).not.toContain(base.runId);
    expect(body).not.toContain(base.nodeId);
    expect(buttonValues(card).every(value => value.runId === base.runId && value.nodeId === base.nodeId)).toBe(true);
  });

  it('custom options：每个 option 渲染按钮，approveOptions 映射 primary/approve action', () => {
    const card = parse(buildV3GateCard({
      ...base,
      options: ['ship', 'hold', 'cancel'],
      approveOptions: ['ship'],
    }));
    const actionEl = card.elements.find((el: any) => el.tag === 'action' && el.actions?.some((a: any) => a.value?.selected === 'ship'));
    const buttons = actionEl.actions;
    expect(buttons.map((b: any) => b.value.selected)).toEqual(['ship', 'hold', 'cancel']);
    expect(buttons[0].type).toBe('primary');
    expect(buttons[0].value.action).toBe(V3_GATE_APPROVE_ACTION);
    expect(buttons[1].type).toBe('danger');
    expect(buttons[1].value.action).toBe(V3_GATE_REJECT_ACTION);
  });

  it('resolution=approved → green header、无 approve/reject 按钮（冻结防重复点）', () => {
    const card = parse(buildV3GateCard({ ...base, resolution: { kind: 'approved', by: 'ou_user' } }));
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('已通过');
    const vals = buttonValues(card);
    expect(vals.some((v) => v.action === V3_GATE_APPROVE_ACTION || v.action === V3_GATE_REJECT_ACTION)).toBe(false);
  });

  it('resolution=rejected → red header + 已拒绝', () => {
    const card = parse(buildV3GateCard({ ...base, resolution: { kind: 'rejected' } }));
    expect(card.header.template).toBe('red');
    expect(card.header.title.content).toContain('已拒绝');
  });

  it('resolution 的 authored option 也只作为 plain_text 渲染', () => {
    const selected = '<at id=all></at>';
    const card = parse(buildV3GateCard({
      ...base,
      resolution: { kind: 'approved', selected },
    }));
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'plain_text' && String(el.text.content).includes(selected),
    )).toBe(true);
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  it('显式 nonce 透传到按钮 value', () => {
    const card = parse(buildV3GateCard({ ...base, nonce: 'custom-nonce' }));
    const approve = buttonValues(card).find((v) => v.action === V3_GATE_APPROVE_ACTION);
    expect(approve.nonce).toBe('custom-nonce');
  });

  it('prompt 作为 plain_text 渲染，Lark tag 不会在审批前触发通知', () => {
    const prompt = '危险 *bold* `code` [x] <at id=all></at>';
    const card = parse(buildV3GateCard({ ...base, prompt }));
    const promptDiv = (card.elements as any[]).find(
      (el) => el.tag === 'div' && el.text?.tag === 'plain_text' && el.text.content === prompt,
    );
    expect(promptDiv).toBeTruthy();
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  it('host 长 prompt 也独立完整展示冻结 hash，并单独截断预览', () => {
    const inputHash = `sha256:${'a'.repeat(64)}`;
    const card = parse(buildV3GateCard({
      ...base,
      prompt: composeV3HostGatePrompt('很长'.repeat(400), [
        'Executor: feishu-send',
        `Frozen input hash: ${inputHash}`,
        '{"content":"hello"}',
      ].join('\n')),
      hostApproval: {
        attemptId: 'send#001/attempts/001',
        approvalDigest: `sha256:${'b'.repeat(64)}`,
        inputHash,
      },
    }));
    const rendered = JSON.stringify(card);
    expect(rendered).toContain(inputHash);
    expect(rendered).toContain('冻结输入 Hash（本次批准对象）');
    expect(rendered).toContain('Executor: feishu-send');
    expect(rendered).toContain('{\\"content\\":\\"hello\\"}');
    expect(rendered).toContain('截断，完整见 Web 详情');
  });

  it('host 冻结预览作为 plain_text 渲染，不把上游 Lark tag 当卡片语法', () => {
    const inputHash = `sha256:${'c'.repeat(64)}`;
    const maliciousPreview = '{"content":"<at id=all></at> 批准前不可通知"}';
    const card = parse(buildV3GateCard({
      ...base,
      prompt: composeV3HostGatePrompt('批准发送？', maliciousPreview),
      hostApproval: {
        attemptId: 'send#001/attempts/001',
        approvalDigest: `sha256:${'d'.repeat(64)}`,
        inputHash,
      },
    }));
    const previewDiv = (card.elements as any[]).find(
      (el) => el.text?.tag === 'plain_text' && String(el.text.content).includes(maliciousPreview),
    );
    expect(previewDiv).toBeTruthy();
    expect((card.elements as any[]).some(
      (el) => el.text?.tag === 'lark_md' && String(el.text.content).includes('<at id=all>'),
    )).toBe(false);
  });

  const publication = (notes = '', repository = 'example/project') => [
    `仓库：${repository}`, '动作：推送修复到原 PR 源分支',
    'PR/MR：https://github.com/example/project/pull/23', '分支：fix/hooks → master',
    '推送远端：origin', `提交：${'a'.repeat(40)}`, `基线：${'b'.repeat(40)}`,
    ...(notes ? [notes] : []),
    `变更与验证：${'验证证据。'.repeat(150)}`, '标题：修复 hook',
    '正文：\n- 安装前检查\n\n| 检查 | 结果 |\n| --- | --- |\n| 本地推送 | 通过 |\n<at id=all></at>',
    '批准范围：仅上述候选的推送及 PR/MR 交付；不含合并、部署。',
  ].join('\n');
  const withContext = (text: string) => ({
    ...base,
    nodeId: 'create-mr',
    prompt: `批准发布？\n\n[BOTMUX_GATE_CONTEXT_V1]\n${JSON.stringify({ text, sha256: `sha256:${'c'.repeat(64)}` })}`,
  });

  it('publication 首屏保留发布目标与范围，长材料完整折叠且不改变审批按钮绑定', () => {
    const material = publication();
    const input = withContext(material);
    const card = parse(buildV3GateCard(input));
    const panel = card.elements.find((el: any) => el.tag === 'collapsible_panel');
    expect(panel?.expanded).toBe(false);
    expect(panel.elements.some((el: any) => el.text?.content === material)).toBe(true);
    const visible = JSON.stringify(card.elements.filter((el: any) => el.tag !== 'collapsible_panel'));
    for (const value of ['example/project', 'https://github.com/example/project/pull/23', 'fix/hooks → master', 'origin', 'a'.repeat(12)]) {
      expect(visible).toContain(value);
    }
    expect(visible).toContain(material.split('\n').at(-1));
    expect(visible).not.toContain('验证证据。'.repeat(150));
    expect(visible).not.toContain('| 本地推送 |');
    const link = card.elements.flatMap((el: any) => el.actions ?? []).find((a: any) =>
      a.multi_url?.url === 'https://github.com/example/project/pull/23');
    expect(link?.tag).toBe('button');
    expect(link.value).toBeUndefined();
    expect(link.multi_url.pc_url).toBe(link.multi_url.url);
    expect(link.multi_url.android_url).toBe(link.multi_url.url);
    expect(link.multi_url.ios_url).toBe(link.multi_url.url);
    const visibleText = (nodes: any[]): string => nodes.map(node =>
      node.tag === 'collapsible_panel' ? '' :
        [node.text?.content ?? '', ...(node.fields ?? []).map((field: any) => field.text?.content ?? '')].join('\n')).join('\n');
    expect(visibleText(card.elements)).not.toContain(link.multi_url.url);
    expect(JSON.stringify(card)).toContain(`sha256:${'c'.repeat(64)}`);
    expect(buttonValues(card)).toEqual(buttonValues(parse(buildV3GateCard({ ...input, prompt: '批准发布？' }))));
  });

  it('只有有效 HTTPS PR/MR 地址生成跳转按钮，新建目标和不安全地址保留原文', () => {
    for (const destination of ['新建', 'javascript:alert(1)', 'https://user:password@example.invalid/pr/1', 'not a URL']) {
      const material = publication().replace('https://github.com/example/project/pull/23', destination);
      const card = parse(buildV3GateCard(withContext(material)));
      const urls = card.elements.flatMap((el: any) => el.actions ?? []).filter((a: any) => a.multi_url);
      expect(urls).toHaveLength(1); // Only the existing Web detail link.
      expect(JSON.stringify(card)).toContain(destination);
    }
  });

  it('publication 警告保持展开；字段与折叠正文中的 Lark 标签全部惰性展示', () => {
    const warning = '注意：本地主分支已前进，合并前请确认无冲突。';
    const material = publication(warning, '<at id=all></at>');
    const card = parse(buildV3GateCard(withContext(material)));
    expect(card.elements.some((el: any) => el.text?.tag === 'plain_text' && el.text.content === warning)).toBe(true);
    const visit = (value: any): any[] => value && typeof value === 'object'
      ? [value, ...Object.values(value).flatMap(visit)] : [];
    const tagged = visit(card).filter(node => typeof node.content === 'string' && node.content.includes('<at id=all>'));
    expect(tagged.length).toBeGreaterThan(1);
    expect(tagged.every(node => node.tag === 'plain_text')).toBe(true);
  });

  it('不能完整识别的审批材料原样展示，已决审批也保留完整材料且无操作按钮', () => {
    const malformed = publication().replace('推送远端：origin\n', '');
    const fallback = parse(buildV3GateCard(withContext(malformed)));
    expect(fallback.elements.some((el: any) => el.text?.content === malformed)).toBe(true);
    expect(fallback.elements.some((el: any) => el.tag === 'collapsible_panel')).toBe(false);
    for (const kind of ['approved', 'rejected', 'voided'] as const) {
      const card = parse(buildV3GateCard({ ...withContext(publication()), resolution: { kind } }));
      expect(buttonValues(card)).toEqual([]);
      expect(card.elements.find((el: any) => el.tag === 'collapsible_panel').elements[0].text.content).toBe(publication());
    }
  });

  it('v3GateCardNonce 稳定（同 run+wait 一致）', () => {
    expect(v3GateCardNonce('r', 'w')).toBe(v3GateCardNonce('r', 'w'));
    expect(v3GateCardNonce('r', 'w')).not.toBe(v3GateCardNonce('r', 'w2'));
  });
});
