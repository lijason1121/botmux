/** Reviewed, self-contained presets have authored provenance, never a fake run. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { BotConfig } from '../../bot-registry.js';
import { withFileLock } from '../../utils/file-lock.js';
import { botToSnapshot, resolveBotConfig } from './bot-resolve.js';
import { isV3SupportedCli } from './contract.js';
import {
  collectSavedWorkflowReusableTextWarnings, SavedWorkflowUnsafeLiteralError,
} from './library-materialize.js';
import { canonicalJsonStringify, normalizeSavedWorkflowLookupKey } from './library-schema.js';
import {
  listVisibleSavedWorkflows, loadVisibleSavedWorkflow, requireActorContext,
  type SavedWorkflowActorContext,
} from './library-service.js';
import { createSavedWorkflow, type SavedWorkflowWriteResult } from './library-store.js';
import { createDevelopmentReviewPreset } from './presets/development-review.js';

export const DEVELOPMENT_REVIEW_PRESET = 'development-review';

export interface CreatePresetSavedWorkflowInput {
  dataDir: string;
  context: SavedWorkflowActorContext;
  presetId: string;
  displayName?: string;
  roleSelections: Record<string, string>;
  bots: BotConfig[];
}

export type CreatePresetSavedWorkflowResult = SavedWorkflowWriteResult & {
  created: boolean;
  origin: 'authored_preset';
};

/** Explicit creation publishes only the reviewed builtin, in this caller's chat.
 * Exact-save, distillation and global-publication authority remain separate. */
export async function createPresetSavedWorkflow(
  input: CreatePresetSavedWorkflowInput,
): Promise<CreatePresetSavedWorkflowResult> {
  const context = requireActorContext(input.context, { requireChat: true });
  if (input.presetId !== DEVELOPMENT_REVIEW_PRESET) throw new Error(`Unknown workflow preset: ${input.presetId}`);
  const names = ['developer', 'correctness', 'regression'] as const;
  if (Object.keys(input.roleSelections).some(name => !names.includes(name as typeof names[number]))) {
    throw new Error('development-review only declares developer, correctness and regression roles');
  }
  const bots = Object.fromEntries(names.map(name => {
    const selector = input.roleSelections[name];
    if (!selector?.trim()) throw new Error(`Missing workflow role: ${name}`);
    const bot = botToSnapshot(resolveBotConfig(selector, input.bots));
    if (!isV3SupportedCli(bot.cliId)) throw new Error(`Role ${name} uses unsupported CLI ${bot.cliId}`);
    return [name, bot.larkAppId];
  })) as Record<typeof names[number], string>;
  if (new Set(Object.values(bots)).size !== names.length) {
    throw new Error('Development and independent review roles require three distinct bots');
  }
  const revision = createDevelopmentReviewPreset(bots);
  const warnings: string[] = [];
  collectSavedWorkflowReusableTextWarnings(revision, 'preset', warnings);
  if (warnings.length) throw new SavedWorkflowUnsafeLiteralError(warnings);
  const displayName = input.displayName?.trim() || '通用开发评审';
  const nameKey = normalizeSavedWorkflowLookupKey(displayName);
  // Serialize retries by authenticated identity/chat/name. Never overwrite an
  // existing definition, including another member's same-name workflow.
  const lockKey = createHash('sha256').update(canonicalJsonStringify([
    context.actor, context.chatId, nameKey,
  ])).digest('hex');
  await fs.mkdir(input.dataDir, { recursive: true, mode: 0o700 });
  return withFileLock(join(input.dataDir, `.workflow-preset-${lockKey}`), async () => {
    const listed = await listVisibleSavedWorkflows({ dataDir: input.dataDir, context });
    const matches = listed.entries.filter(entry => normalizeSavedWorkflowLookupKey(entry.displayName) === nameKey);
    if (matches.length) {
      if (matches.length !== 1) throw new Error(`Workflow name is ambiguous: ${displayName}`);
      const loaded = await loadVisibleSavedWorkflow({ dataDir: input.dataDir, ref: matches[0]!.workflowId, context });
      const { workflowId: _id, humanVersion: _version, createdAt: _at, createdBy: _by, ...draft } = loaded.revision.payload;
      if (loaded.metadata.owner.openId !== context.actor.openId ||
          loaded.metadata.owner.larkAppId !== context.actor.larkAppId ||
          loaded.metadata.scope.kind !== 'chat' || loaded.metadata.status !== 'active' ||
          canonicalJsonStringify(draft) !== canonicalJsonStringify(revision)) {
        throw new Error(`Workflow name already exists with a different definition: ${displayName}`);
      }
      return { ...loaded, created: false, origin: 'authored_preset' as const };
    }
    const result = await createSavedWorkflow(input.dataDir, {
      displayName, owner: context.actor, scope: { kind: 'chat', chatId: context.chatId! },
      revision, publish: true,
    });
    return { ...result, created: true, origin: 'authored_preset' as const };
  });
}
