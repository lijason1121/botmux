import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { spawnTsScript, spawnSyncTsEval } from './helpers/ts-runner.js';
import { readAndValidateManifest } from '../src/workflows/v3/manifest.js';
import { DEVELOPMENT_REVIEW_RESOURCES, DEVELOPMENT_REVIEW_RESOURCE_MANIFEST_SHA256 } from '../src/workflows/v3/presets/development-review-resources.js';
import { createDevelopmentReviewPreset } from '../src/workflows/v3/presets/development-review.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = (file: string) => 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
type Input = { from: string; name: string; path: string; kind?: string };

async function mechanicalFixture(mode: 'new' | 'review' | 'continue' = 'new', changed = true, failedCheck = false, ownPr = false, checkId = 'behavior') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-rev-mechanical-'))); roots.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), run = join(root, 'fixture-run');
  mkdirSync(repo); mkdirSync(run);
  writeFileSync(join(root, 'gitconfig'), '');
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'value.txt'), 'before\n');
  git(repo, 'add', 'value.txt'); git(repo, 'commit', '-qm', 'fixture base');
  git(root, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main');
  if (mode !== 'new') {
    git(repo, 'checkout', '-qb', 'feature'); writeFileSync(join(repo, 'value.txt'), 'after\n');
    git(repo, 'commit', '-qam', 'fixture PR'); git(repo, 'push', '-q', 'origin', 'feature');
  }
  const out = (node: string) => { const p = join(run, node, 'attempts', '001', 'work'); mkdirSync(p, { recursive: true }); return p; };
  write(join(run, 'run.json'), { runId: 'fixture-run' });
  const prepared = out('prepare#001'), script = join(prepared, 'tools.mjs');
  const content = process.env.DEVREV_PUBLIC_TEXT_MUTATION === '1'
    ? DEVELOPMENT_REVIEW_RESOURCES[0]!.content.replace('function publicText(value, context) {', 'function publicText(value, context) { return String(value);')
    : DEVELOPMENT_REVIEW_RESOURCES[0]!.content;
  writeFileSync(script, content);
  const params = join(root, 'params.json'), preflight = join(root, 'preflight.json'), roles = join(root, 'roles.json');
  const target = { url: 'https://example.invalid/pull/23', author: 'fixture-author', remote: 'origin', sourceBranch: 'feature', targetBranch: 'main', headSha: git(repo, 'rev-parse', 'HEAD') };
  write(params, { params: { mode, repo_path: repo, requirement: 'Fixture task', target_branch: 'main',
    validation_commands: [{ id: checkId, argv: [process.execPath, '-e', `process.exit(${failedCheck ? 3 : 0})`], timeoutSec: 10 }] } });
  write(preflight, { schemaVersion: 1, state: 'READY', runId: 'fixture-run', repoPath: repo, targetBranch: 'main',
    repositoryAccess: true, identity: 'fixture', login: ownPr ? target.author : 'fixture-reviewer',
    worktreeAllowed: true, worktreePath: join(root, 'task'), branch: 'workflow/fixture-run', ...(mode !== 'new' ? { reviewTarget: target } : {}) });
  write(roles, Object.fromEntries(['developer', 'correctness', 'regression'].map(role => [role, { bot: 'cli_' + role, label: role, cliId: 'codex' }])));
  const tool = (operation: string, args: string[], output: string, inputs?: Input[]) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const inputsFile = join(dirname(output), 'inputs.json');
    if (inputs) write(inputsFile, { inputs });
    const options = {
      env: { ...env, BOTMUX_GOAL_OUTPUT_DIR: output, BOTMUX_GOAL_ATTEMPT_DIR: dirname(output),
        BOTMUX_GOAL_MANIFEST_PATH: join(dirname(output), 'manifest.json'), BOTMUX_GOAL_INPUTS_PATH: inputsFile },
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const id = basename(dirname(dirname(dirname(output)))).replace(/#[0-9]+$/, '');
    const goal = operation === 'authored-stage' ? createDevelopmentReviewPreset({ developer: 'cli_dev', correctness: 'cli_check', regression: 'cli_regression' }).dagTemplate.nodes.find(node => node.id === id)?.goal : undefined;
    const command = typeof goal === 'string' ? /```sh\n([\s\S]*?)\n```/.exec(goal)?.[1] : undefined;
    const child = operation === 'authored-stage'
      ? spawn('bash', ['-c', command || 'exit 99'], options)
      : spawnTsScript(script, [operation, '--expected-tools-sha', sha(script), ...args], options);
    child.stdout?.resume();
    let stderr = ''; child.stderr?.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
  });
  expect(await tool('prepare', ['--preflight', preflight, '--params', params, '--roles', roles], prepared)).toMatchObject({ code: 0, stderr: '' });
  const context = join(prepared, 'context.json'), resources = join(prepared, 'resources.json');
  const ctx = json(context);
  if (mode !== 'review' && changed) { writeFileSync(join(ctx.worktree, 'value.txt'), 'task change\n'); git(ctx.worktree, 'commit', '-qam', 'fixture change'); }
  const implemented = out('development-review-loop.i001.implement');
  expect(await tool('candidate', ['--context', context, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  const candidate = join(implemented, 'candidate.json'), validation = join(implemented, 'validation.json');
  expect(await tool('record', ['--context', context, '--candidate', candidate, '--round', '1'], implemented)).toMatchObject({ code: 0 });
  const summary = join(implemented, 'change-summary.md'); writeFileSync(summary, 'Fixture change; unverified-fixture-platform.\n');
  const reviews = Object.fromEntries(['correctness', 'regression'].map(role => {
    const path = join(root, role + '.json');
    write(path, { ...json(candidate), role, reviewerId: 'cli_' + role, decision: failedCheck ? 'changes_requested' : 'approve',
      findings: failedCheck ? [{ blocking: false, location: 'value.txt:1', impact: role + '-finding-canary', evidence: 'behavior exits 3' }] : [],
      coverage: [role + '-coverage-canary'], evidence: ['unverified-fixture-platform'],
      candidateSha256: sha(candidate), validationSha256: sha(validation), contextSha256: sha(context) });
    return [role, path];
  }));
  const preparedInputs: Input[] = [{ from: 'prepare', name: 'context', path: context }, { from: 'prepare', name: 'resources', path: resources }, { from: 'prepare', name: 'tools', path: script }];
  const gated = out('development-review-loop.i001.verify-review-gate'), release = join(gated, 'release-candidate.json');
  const gateInputs = [...preparedInputs, ...[['candidate', candidate], ['validation', validation], ['change-summary', summary]].map(([name, path]) => ({ from: 'development-review-loop.i001.implement', name: name!, path: path! })),
    ...Object.entries(reviews).map(([role, path]) => ({ from: 'development-review-loop.i001.review-' + role, name: 'review', path }))];
  const legacyGate = () => tool('gate', ['--context', context, '--resources', resources, '--expected-resources-sha', sha(resources),
    '--candidate', candidate, '--validation', validation, '--change-summary', summary, '--correctness', reviews.correctness!, '--regression', reviews.regression!, '--round', '1', '--out', join(gated, 'result.json')], gated);
  const releaseInput = { from: 'development-review-loop', name: 'release-candidate', path: release };
  const complete = out('complete#001');
  async function delivery() {
    expect(await legacyGate()).toMatchObject({ code: 0 }); expect(json(join(gated, 'result.json')).passed).toBe(true);
    const output = out('prepare-mr#001'), draft = join(output, 'mr-draft.json');
    write(draft, { repository: 'fixture/project', summary: 'Fixture validation; unverified-fixture-platform.', pushRemote: 'origin', ...(mode !== 'new' ? { existingPr: { ...target, state: 'OPEN' } } : {}) });
    writeFileSync(join(output, 'review-comment.md'), 'Fixture review notes.\n');
    writeFileSync(join(output, 'mr-title.txt'), 'Fixture change\n'); writeFileSync(join(output, 'mr-body.md'), 'Fixture validation.\n');
    expect(await tool('delivery', ['--context', context, '--release', release, '--draft', draft,
      ...(mode === 'review' ? ['--comment', join(output, 'review-comment.md')] : ['--title', join(output, 'mr-title.txt'), '--body', join(output, 'mr-body.md')])], output)).toMatchObject({ code: 0 });
    return { output, plan: join(output, 'result.json') };
  }
  return { root, repo, run, out, tool, git, prepared, preflight, params, roles, context, resources, ctx, candidate, validation, reviews,
    gated, release, preparedInputs, gateInputs, releaseInput, complete, legacyGate, delivery };
}


import { V3ProgressCardManager, type V3ProgressCardTransport } from '../src/im/lark/v3-progress-card-manager.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { artifactRef, makeAdHocRunEnvelope, publishRunEnvelopeOnce } from '../src/workflows/v3/run-envelope.js';
function noticeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devrev-notice-probe-'))); roots.push(root);
  const runId = 'probe-run', runDir = join(root, runId); mkdirSync(runDir);
  write(join(runDir, 'dag.json'), {runId, nodes: [{id:'work', type:'goal', goal:'work', depends:[], inputs:[]}]});
  write(join(runDir,'spec.json'),{schemaVersion:1,runId,title:'probe',requirement:'work',nodes:[{sketchId:'work',goal:'work',input_needs:[],expected_outputs:['out'],acceptance:'done',risk_gate:false,unknowns:[]}]});
  write(join(runDir, 'bots.snapshot.json'), {'': {larkAppId:'cli_test', cliId:'claude-code', workingDir:root}});
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({runId, createdAt:'2026-11-05T00:00:00.000Z', authorizedAt:'2026-11-05T00:00:01.000Z',
    chatBinding:{larkAppId:'cli_test',chatId:'oc_probe',ownerOpenId:'ou_owner',rootMessageId:'om_probe'},
    artifacts:{dag:artifactRef(runDir,'dag.json'), spec:artifactRef(runDir,'spec.json'), botSnapshots:artifactRef(runDir,'bots.snapshot.json')}}));
  appendEvent(join(runDir,'journal.ndjson'), {type:'runStarted',runId});
  const transport: V3ProgressCardTransport = {reply:vi.fn(async()=> 'om_progress'),send:vi.fn(async()=> 'om_progress'),patch:vi.fn(async()=>{})};
  const cards = new V3ProgressCardManager({baseDir:root, transport, pollIntervalMs:1000, buildCard:view=>JSON.stringify({status:view.status}), now:()=>new Date()});
  return {root,runDir,runId,transport,cards};
}

describe('independent devrev adversarial probes', () => {
  it('recovers a transient failure notice send on its own polling cycle', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});
    const f=noticeFixture();
    try {
      f.cards.observe(f.runId);
      await f.cards.refresh(f.runId,{allowCreate:true});
      expect(f.transport.reply).toHaveBeenCalledTimes(1);
      appendEvent(join(f.runDir,'journal.ndjson'), {type:'runFailed',failedNodeId:'work'});
      let signalDelivered!: () => void;
      const delivered = new Promise<void>(resolve => { signalDelivered = resolve; });
      vi.mocked(f.transport.reply).mockRejectedValueOnce(new Error('transient transport failure'))
        .mockImplementationOnce(async () => { signalDelivered(); return 'om_failure'; });
      expect(await f.cards.refresh(f.runId,{allowCreate:true})).toBe(false);
      expect(f.transport.reply).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await delivered;
      await f.cards.refresh(f.runId,{allowCreate:true});
      expect(f.transport.reply).toHaveBeenCalledTimes(3);
    } finally { f.cards.close(); vi.useRealTimers(); }
  });

  it.each(['日志：/home/private-owner/secret-run/build.log', 'trace:C:\\Users\\private-owner\\secret-run\\build.log', '日志=file:///home/private-owner/secret-run/build.log'])('does not leak absolute paths next to punctuation: %s', async evidence => {
    const f=await mechanicalFixture('review');
    const review=json(f.reviews.correctness!); review.decision='changes_requested';
    review.findings=[{blocking:true, location:'value.txt:1',impact:'Build fails',evidence: evidence + ' See https://example.invalid/docs/runtime#entry'}];
    write(f.reviews.correctness!,review);
    const delivered=await f.delivery(), plan=json(delivered.plan);
    expect(plan.commentBody).not.toContain('private-owner');
    expect(plan.commentBody).toContain('https://example.invalid/docs/runtime#entry');
    expect(plan.approvalSummary).not.toContain('private-owner');
  });

  it('does not silently publish private paths from the plan summary', async () => {
    const f=await mechanicalFixture('review');
    const delivered=await f.delivery(), draft=join(delivered.output,'mr-draft.json');
    write(draft,{...json(draft),summary:'Validation /home/private-owner/secret-run/build.log'});
    expect(await f.tool('delivery',['--context',f.context,'--release',f.release,'--draft',draft,'--comment',join(delivered.output,'review-comment.md')],delivered.output)).toMatchObject({code:0});
    expect(json(delivered.plan).approvalSummary).not.toContain('/home/private-owner');
  });
});

import { validateDag } from '../src/workflows/v3/dag.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { runPortableWorkflow } from '../src/workflows/v3/portable-runtime.js';
import type { AgentExecutor, AttemptLeaseProvider } from '../src/workflows/v3/runtime-host-contract.js';

describe('independent repeated-restart probes', () => {
  it.each(['restart', 'cancel'] as const)('preserves valid progress across two immediate recovery attempts: %s', async mode => {
    const baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'devrev-repeat-recovery-'))); roots.push(baseDir);
    const dag=validateDag({runId:'repeat-recovery',nodes:[{id:'review',type:'goal',goal:'inspect candidate'}]});
    let count=0;
    const received: Array<Array<{from:string;path:string}>>=[];
    const executeAgent: AgentExecutor=async request=>{
      count++;
      received.push(JSON.parse(readFileSync(request.inputsPath,'utf8')).inputs);
      if(count===1) {
        const {inputHash}=JSON.parse(readFileSync(join(request.attemptDir,'checkpoint-context.json'),'utf8'));
        const text='already verified targeted behavior';
        writeFileSync(join(request.outputDir,'progress.md'),text);
        write(join(request.outputDir,'checkpoint.json'),{schemaVersion:1,status:'fail',summary:'partial',inputHash,error:{code:'CHECKPOINT_INCOMPLETE',message:'remaining',retryable:true},files:[{name:'progress',path:'progress.md',kind:'markdown',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),mime:'text/markdown'}]});
      }
      if(count<3) return {status:'fail',failureReason:'timeout',failureDetail:'node timed out after 1800s',manifestPath:request.env.BOTMUX_GOAL_MANIFEST_PATH!};
      const text='done';writeFileSync(join(request.outputDir,'report.md'),text);
      write(request.env.BOTMUX_GOAL_MANIFEST_PATH!,{schemaVersion:1,status:'ok',summary:'done',files:[{name:'report',path:'report.md',kind:'markdown',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),mime:'text/markdown'}]});
      return {status:'ok',manifestPath:request.env.BOTMUX_GOAL_MANIFEST_PATH!};
    };
    const provider: AttemptLeaseProvider={acquire:()=>({}),closeBeforeExecution:()=>{},cleanupSettled:()=>{},drainExternallyOwned:()=>({status:'closed',finalizeAfterProof:()=>{}})};
    const deps={executeAgent,attemptLeaseProvider:provider,resolveExecutionProfile:()=>({profileId:'probe',executorId:'fake-agent',workingDirectory:baseDir}),validateManifest:async(filename:string,outputDir:string)=>{try{return {ok:true,manifest:await readAndValidateManifest(filename,outputDir)}}catch(error){return {ok:false,problems:[String(error)]}}}};
    const journal=join(baseDir,dag.runId,'journal.ndjson');
    for(let stage=0;stage<2;stage++) {
      expect(await runPortableWorkflow(dag,deps,{baseDir})).toMatchObject({runStatus:'blocked'});
      // Each simulated restart retains actual dispatch/binding/progress writes,
      // and drops only outcome records the vanished process could not commit.
      writeFileSync(journal,readJournal(journal).filter(e=>!['nodeBlocked','runBlocked'].includes(e.type)).map(e=>JSON.stringify(e)).join('\n')+'\n');
    }
    expect(received[1]!.filter(i=>i.from==='checkpoint')).toHaveLength(1);
    if(mode==='cancel') appendEvent(journal,{type:'runCancelRequested',cancelRequestId:'stop',by:'user'});
    expect(await runPortableWorkflow(dag,deps,{baseDir})).toMatchObject({runStatus:mode==='cancel'?'cancelled':'succeeded'});
    expect(count).toBe(mode==='cancel'?2:3);
    if(mode==='restart') expect(received[2]!.filter(i=>i.from==='checkpoint')).toHaveLength(1);
  });
});

describe('independent notification-window probes', () => {
  it('coalesces concurrent failure polling while transport is unresolved', async () => {
    const f=noticeFixture();
    try {
      await f.cards.refresh(f.runId,{allowCreate:true});
      appendEvent(join(f.runDir,'journal.ndjson'),{type:'runFailed',failedNodeId:'work'});
      let signalEntered!:()=>void, release!: (id:string)=>void;
      const entered=new Promise<void>(resolve=>{signalEntered=resolve});
      const delivery=new Promise<string>(resolve=>{release=resolve});
      vi.mocked(f.transport.reply).mockImplementationOnce(async()=>{signalEntered();return delivery});
      const pending=f.cards.refresh(f.runId,{allowCreate:true});
      await entered;
      const queued=Array.from({length:50},()=>f.cards.refresh(f.runId,{allowCreate:true}));
      expect(queued.every(p=>p===pending)).toBe(true);
      expect(f.transport.reply).toHaveBeenCalledTimes(2);
      release('om_failure');
      expect(await pending).toBe(true);
      expect(f.transport.reply).toHaveBeenCalledTimes(2);
    } finally {f.cards.close()}
  });

  it('does not repeat an uncertain accepted failure notice beyond provider dedupe TTL', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-05T00:05:00Z'));
    const f=noticeFixture();
    try {
      await f.cards.refresh(f.runId,{allowCreate:true});
      appendEvent(join(f.runDir,'journal.ndjson'),{type:'runFailed',failedNodeId:'work'});
      vi.mocked(f.transport.reply).mockRejectedValueOnce(new Error('accepted but receipt lost'));
      expect(await f.cards.refresh(f.runId,{allowCreate:true})).toBe(false);
      vi.setSystemTime(new Date('2026-11-05T01:05:00Z'));
      await f.cards.coldAttach('cli_test');
      expect(f.transport.reply).toHaveBeenCalledTimes(2);
      expect(json(join(f.runDir,'lark-failure-notice.json')).delivery).toBe('uncertain');
    } finally {f.cards.close();vi.useRealTimers()}
  });
});

describe('independent cold-attach retry probe', () => {
  it('keeps retrying a persisted pending notice if its first cold-attach send also fails', async () => {
    vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});
    const f=noticeFixture();
    const cold=new V3ProgressCardManager({baseDir:f.root,transport:f.transport,pollIntervalMs:1000,buildCard:view=>JSON.stringify({status:view.status}),now:()=>new Date()});
    try {
      await f.cards.refresh(f.runId,{allowCreate:true});
      appendEvent(join(f.runDir,'journal.ndjson'),{type:'runFailed',failedNodeId:'work'});
      let signalDelivered!:()=>void; const delivered=new Promise<void>(resolve=>{signalDelivered=resolve});
      vi.mocked(f.transport.reply).mockRejectedValueOnce(new Error('receipt lost')).mockRejectedValueOnce(new Error('still offline')).mockImplementationOnce(async()=>{signalDelivered();return 'om_failure'});
      expect(await f.cards.refresh(f.runId,{allowCreate:true})).toBe(false);
      f.cards.close();
      await cold.coldAttach('cli_test');
      expect(f.transport.reply).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await delivered;
      await cold.refresh(f.runId,{allowCreate:true});
      expect(f.transport.reply).toHaveBeenCalledTimes(4);
      expect(vi.mocked(f.transport.reply).mock.calls.slice(1).map(call=>call[3])).toEqual(Array(3).fill(vi.mocked(f.transport.reply).mock.calls[1]![3]));
    } finally {f.cards.close();cold.close();vi.useRealTimers()}
  });
});

describe('independent dependency provenance probe', () => {
  it('derives required installed packages at the independent gate rather than trusting names from validation', async () => {
    const f=await mechanicalFixture('new');
    write(join(f.ctx.worktree,'package.json'),{dependencies:{missing:'1.0.0'}});
    writeFileSync(join(f.ctx.worktree,'bun.lock'),'fixture-lock');
    writeFileSync(join(f.ctx.worktree,'.gitignore'),'node_modules\n');
    mkdirSync(join(f.ctx.worktree,'node_modules'));
    f.git(f.ctx.worktree,'add','package.json','bun.lock','.gitignore');
    f.git(f.ctx.worktree,'commit','-qm','candidate dependency change');
    expect(await f.tool('candidate',['--context',f.context,'--round','1'],dirname(f.candidate))).toMatchObject({code:0});
    const candidate=json(f.candidate), validation=json(f.validation);
    const files=['bun.lock','package.json'];
    Object.assign(validation,candidate,{candidateSha256:sha(f.candidate),dependencies:{state:'ready',source:f.ctx.worktree,modules:realpathSync(join(f.ctx.worktree,'node_modules')),files,names:[],inputsSha256:'sha256:'+createHash('sha256').update(JSON.stringify(files.map(file=>[file,sha(join(f.ctx.worktree,file))]))).digest('hex')}});
    for(const check of validation.checks){check.headBefore=candidate.headSha;check.headAfter=candidate.headSha}
    write(f.validation,validation);
    for(const role of ['correctness','regression']){
      const file=f.reviews[role]!;write(file,{...json(file),...candidate,candidateSha256:sha(f.candidate),validationSha256:sha(f.validation)});
    }
    expect(await f.legacyGate()).toMatchObject({code:0});
    expect(json(join(f.gated,'result.json')).passed).toBe(false);
  });
});
