import { createHash } from 'node:crypto';
import { canonicalJsonStringify, type SavedWorkflowRevisionDraft } from '../library-schema.js';
import { createDevelopmentReviewPreset, type DevelopmentReviewDefaultBots } from './development-review.js';

// Complete canonical previous drafts, with only their three bot IDs normalized. Never
// recognize a customized workflow by its name, node IDs or a partial shape.
// Earlier embedded tools contained non-ASCII text, so Bun and Node produced different
// bytes for the same build; both variants of those builds are listed.
const PREVIOUS_DRAFT_SHA256 = new Set([
  '39dcea56c89de7f3912216512e39ac4fcb873d81820c3b3314bd0c5dbccee178',
  '302296bb7d391f25315b71f21e20c7e93ead65155f97d92f8df78b633726eacd',
  '983e803a7ce70baec19dcd759cf557e4b133747d453447947a8940cc5486cb56',
  '4c6da8a39deacceb4d050ce1c4ed3940b115bff967f599b277e0246e5bd5e5d7',
  '22b2d3126fbe267db96a872de51d954c15f8d6535bf91ba06b8fd6014b0ac6fc',
  'b6bbebfd95baf3980c64ee195c8ef072257a7185f06a106968cbb007305d8f7e',
  '17d8452a966011acc59f3b0226d14734c5fc20779b7df67424f7cf323cfa8190',
  '9b99b94f57d9a5ce37b067ee26f63d77798e1dfbbc3c793685e35dff95483394',
  'b5647a21da51ef16dd2bf6396a1ff3d3cdfd60512692f14867643d51062cb8aa',
  '14ff1be4bc09497644c5aef07fd33131bc957447f7ae96811bdae2cf8e1ed134',
  '97114d9726341b447e6c5678fad48f0762087011bc284f646f20de3efaa50f08',
  '571851320d9174b17e3df81dd6d6bf5d24c8427266677315ebd426a770e3c58c',
  'edbc4b2e13f3da7d5fe20340f4b70f6f165090978c479d980f1605b5892c0b2b',
  '7b8be424c1439511f81d5085d851b0a3d88ca922e0e5b931e6ccbf428974064e',
  '697c5c81005e9c15d31f2f8612a49b9658addcc6c0a7db7ab50e01b264a8db9d',
  '8c29f5875e10b2d12dfc7fcc21990b0ce6228782605ca9d89c76c35b2cf3d6e4',
  '770561eb84b3e92536af5f34678e3dfa51370c57409f9aadde65e6bb14150aad',
]);

export function upgradeDevelopmentReviewPreset(draft: SavedWorkflowRevisionDraft): SavedWorkflowRevisionDraft | undefined {
  const names = ['developer', 'correctness', 'regression'] as const;
  const defaults = Object.fromEntries(names.map(name => [name, draft.roles?.[name]?.defaultBot]));
  if (names.some(name => !defaults[name]) || defaults.developer === defaults.correctness || defaults.developer === defaults.regression) return undefined;
  const substitutions = new Map(names.map(name => [defaults[name], `cli_${name}`]));
  const normalized = JSON.parse(JSON.stringify(draft), (_key, value: unknown) =>
    typeof value === 'string' ? substitutions.get(value) ?? value : value);
  if (!PREVIOUS_DRAFT_SHA256.has(createHash('sha256').update(canonicalJsonStringify(normalized)).digest('hex'))) return undefined;
  return createDevelopmentReviewPreset(defaults as unknown as DevelopmentReviewDefaultBots);
}
