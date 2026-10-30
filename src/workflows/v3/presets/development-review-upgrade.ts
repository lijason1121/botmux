import { createHash } from 'node:crypto';
import { canonicalJsonStringify, type SavedWorkflowRevisionDraft } from '../library-schema.js';
import { createDevelopmentReviewPreset, type DevelopmentReviewDefaultBots } from './development-review.js';

// Complete canonical previous drafts, with only their three bot IDs normalized. Never
// recognize a customized workflow by its name, node IDs or a partial shape.
// Earlier embedded tools contained non-ASCII text, so Bun and Node produced different
// bytes for the same build; both variants of those builds are listed.
const PREVIOUS_DRAFT_SHA256 = new Set([
  '9b99b94f57d9a5ce37b067ee26f63d77798e1dfbbc3c793685e35dff95483394',
  'b5647a21da51ef16dd2bf6396a1ff3d3cdfd60512692f14867643d51062cb8aa',
  '14ff1be4bc09497644c5aef07fd33131bc957447f7ae96811bdae2cf8e1ed134',
  '97114d9726341b447e6c5678fad48f0762087011bc284f646f20de3efaa50f08',
  '571851320d9174b17e3df81dd6d6bf5d24c8427266677315ebd426a770e3c58c',
]);

export function upgradeDevelopmentReviewPreset(draft: SavedWorkflowRevisionDraft): SavedWorkflowRevisionDraft | undefined {
  const names = ['developer', 'correctness', 'regression'] as const;
  const defaults = Object.fromEntries(names.map(name => [name, draft.roles?.[name]?.defaultBot]));
  if (names.some(name => !defaults[name]) || new Set(Object.values(defaults)).size !== 3) return undefined;
  const substitutions = new Map(names.map(name => [defaults[name], `cli_${name}`]));
  const normalized = JSON.parse(JSON.stringify(draft), (_key, value: unknown) =>
    typeof value === 'string' ? substitutions.get(value) ?? value : value);
  if (!PREVIOUS_DRAFT_SHA256.has(createHash('sha256').update(canonicalJsonStringify(normalized)).digest('hex'))) return undefined;
  return createDevelopmentReviewPreset(defaults as unknown as DevelopmentReviewDefaultBots);
}
