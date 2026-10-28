/** Saved Workflow execution roles are explicit goal bindings, never bot-field interpolation. */
import { isGoalNode, isLoopNode, V3_DAG_SEGMENT_RE, type V3Node } from './dag.js';
import type { BotSnapshot } from './contract.js';

export interface SavedWorkflowRole {
  nodes: string[];
  /** Canonical app identity taken from the source run's frozen bot. */
  defaultBot: string;
}
export type SavedWorkflowRoles = Record<string, SavedWorkflowRole>;
export type SavedWorkflowRoleNodes = Record<string, string[]>;
export interface ResolvedSavedWorkflowRole {
  nodes: string[];
  bot: string;
  label: string;
  cliId: BotSnapshot['cliId'];
}
export type ResolvedSavedWorkflowRoles = Record<string, ResolvedSavedWorkflowRole>;

const ROLE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (s: string): boolean => ROLE_ID.test(s) && !RESERVED.has(s);

/** Shared CLI/IM syntax. Repeated declarations may add different goals to one
 * role; a run may select each role exactly once. */
export function collectSavedWorkflowRoleArgs(
  args: readonly string[], mode: 'save' | 'run',
): { remaining: string[]; roleNodes?: SavedWorkflowRoleNodes; roleSelections?: Record<string, string> } {
  const remaining: string[] = [];
  const roleNodes: SavedWorkflowRoleNodes = Object.create(null);
  const roleSelections: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token !== '--role' && !token.startsWith('--role=')) { remaining.push(token); continue; }
    const pair = token === '--role' ? args[++i] : token.slice('--role='.length);
    const eq = pair?.indexOf('=') ?? -1;
    if (!pair || eq <= 0 || !pair.slice(eq + 1).trim()) throw new Error('--role requires role=value');
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1).trim();
    if (!validId(name)) throw new Error(`invalid role name: ${name}`);
    if (mode === 'run') {
      if (Object.hasOwn(roleSelections, name)) throw new Error(`duplicate role selection: ${name}`);
      roleSelections[name] = value;
    } else {
      const paths = roleNodes[name] ??= [];
      if (paths.includes(value)) throw new Error(`duplicate role node: ${name}=${value}`);
      paths.push(value);
    }
  }
  return { remaining,
    ...(Object.keys(roleNodes).length ? { roleNodes } : {}),
    ...(Object.keys(roleSelections).length ? { roleSelections } : {}),
  };
}

/** Paths use ids, not array positions: topGoal or loopId/bodyGoal. */
export function savedWorkflowGoalPaths(nodes: readonly V3Node[]): Map<string, V3Node> {
  const goals = new Map<string, V3Node>();
  const visit = (items: readonly V3Node[], prefix = ''): void => {
    for (const node of items) {
      if (!V3_DAG_SEGMENT_RE.test(node.id)) throw new Error(`invalid role goal path segment: ${node.id}`);
      const path = `${prefix}${node.id}`;
      if (isGoalNode(node)) {
        if (goals.has(path)) throw new Error(`ambiguous role goal path: ${path}`);
        goals.set(path, node);
      }
      if (isLoopNode(node)) visit(node.body.nodes, `${path}/`);
    }
  };
  visit(nodes);
  return goals;
}

export function validateSavedWorkflowRoles(raw: unknown, nodes: readonly V3Node[]): SavedWorkflowRoles | undefined {
  if (raw === undefined) return undefined;
  if (!record(raw) || Object.keys(raw).length === 0 || Object.keys(raw).length > 64) {
    throw new Error('roles must be a non-empty object with at most 64 roles');
  }
  const goals = savedWorkflowGoalPaths(nodes);
  const used = new Set<string>();
  const roles: SavedWorkflowRoles = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    if (!validId(name) || !record(value) || Object.keys(value).some(k => !['nodes', 'defaultBot'].includes(k))) {
      throw new Error(`invalid role declaration: ${name}`);
    }
    if (!Array.isArray(value.nodes) || !value.nodes.length || typeof value.defaultBot !== 'string' || !value.defaultBot.trim() || value.defaultBot.includes('${')) {
      throw new Error(`role ${name} requires goal nodes and a direct defaultBot`);
    }
    const paths: string[] = [];
    for (const path of value.nodes) {
      if (typeof path !== 'string' || !goals.has(path)) throw new Error(`role ${name} references unknown goal path ${String(path)}`);
      if (used.has(path)) throw new Error(`duplicate/multiple role binding for goal ${path}`);
      used.add(path); paths.push(path);
      if (goals.get(path)!.bot !== value.defaultBot) throw new Error(`role ${name} has inconsistent default bot at ${path}`);
    }
    roles[name] = { nodes: paths, defaultBot: value.defaultBot };
  }
  return roles;
}

export function deriveSavedWorkflowRoles(
  declarations: SavedWorkflowRoleNodes | undefined, nodes: readonly V3Node[],
): SavedWorkflowRoles | undefined {
  if (declarations === undefined) return undefined;
  const goals = savedWorkflowGoalPaths(nodes);
  const raw: Record<string, unknown> = Object.create(null);
  for (const [name, paths] of Object.entries(declarations)) {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !goals.has(path))) {
      throw new Error(`role ${name} references unknown goal path`);
    }
    raw[name] = { nodes: paths, defaultBot: goals.get(paths[0] ?? '')?.bot ?? '' };
  }
  return validateSavedWorkflowRoles(raw, nodes);
}

const ROLE_MARKER = /\$\{roles\.([A-Za-z_][A-Za-z0-9_]{0,63})\.(label|bot|cliId)\}/g;
export function savedWorkflowRoleMarkerSpans(text: string, roles?: SavedWorkflowRoles): Array<{ start: number; length: number }> {
  const spans: Array<{ start: number; length: number }> = [];
  for (const match of text.matchAll(ROLE_MARKER)) {
    if (!roles || !Object.hasOwn(roles, match[1]!)) throw new Error(`undeclared workflow role: ${match[1]}`);
    spans.push({ start: match.index!, length: match[0].length });
  }
  return spans;
}

export function renderSavedWorkflowRoleText(text: string, roles: ResolvedSavedWorkflowRoles): string {
  return text.replace(ROLE_MARKER, (_whole, role: string, field: 'label' | 'bot' | 'cliId') => roles[role]![field]);
}

/** Recovery checks the pinned role artifact against the pinned DAG and bot
 * snapshots, never against today's mutable registry. */
export function assertResolvedSavedWorkflowRoles(
  raw: unknown, declarations: unknown, nodes: readonly V3Node[], snapshots: unknown,
): void {
  if (declarations === undefined && raw === undefined) return;
  if (!record(declarations) || !record(raw) || !record(snapshots) ||
      Object.keys(declarations).sort().join('\0') !== Object.keys(raw).sort().join('\0')) {
    throw new Error('roles.resolved.json does not match declared workflow roles');
  }
  const goals = savedWorkflowGoalPaths(nodes);
  for (const [name, declaration] of Object.entries(declarations)) {
    const role = raw[name];
    if (!record(declaration) || !record(role) || !Array.isArray(role.nodes) ||
        JSON.stringify(role.nodes) !== JSON.stringify(declaration.nodes) ||
        Object.keys(role).some(k => !['nodes', 'bot', 'label', 'cliId'].includes(k)) ||
        ['bot', 'label', 'cliId'].some(k => typeof role[k] !== 'string' || !role[k])) {
      throw new Error(`roles.resolved.json has invalid role ${name}`);
    }
    for (const path of role.nodes) {
      const node = typeof path === 'string' ? goals.get(path) : undefined;
      const snapshot = node?.bot ? snapshots[node.bot] : undefined;
      if (!node || node.bot !== role.bot || !record(snapshot) || snapshot.larkAppId !== role.bot || snapshot.cliId !== role.cliId) {
        throw new Error(`roles.resolved.json role ${name} disagrees with goal or frozen bot at ${String(path)}`);
      }
    }
  }
}

export function savedWorkflowRoleSummary(roles: ResolvedSavedWorkflowRoles | undefined): string {
  return Object.entries(roles ?? {}).map(([name, role]) => `${name}: ${role.label} (${role.bot}, ${role.cliId}) [${role.nodes.join(', ')}]`).join('\n');
}
