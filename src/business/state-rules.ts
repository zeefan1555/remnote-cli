import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { INSPECT_FIELDS, type InspectField } from './state-inspect.js';

export const RULE_OPS = [
  'equals',
  'contains',
  'startsWith',
  'regex',
  'notContains',
  'count',
  'all',
  'any',
  'none',
  'hashEquals',
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface StateRule {
  id: string;
  path: string;
  op: RuleOp;
  expect?: unknown;
  /** Partial object filter applied before count, all, any, and none. */
  match?: Record<string, unknown>;
  /** UTF-8 file compared to the selected string. A single trailing newline is removed. */
  baseline?: string;
}

export interface StateRulesFile {
  schemaVersion: 1;
  remIds?: string[];
  descendants?: number;
  fields?: InspectField[];
  summary?: boolean;
  rules: StateRule[];
}

export interface RuleResult {
  id: string;
  status: 'pass' | 'fail';
  actual: unknown;
  expected: unknown;
}

export interface RuleReport {
  ok: boolean;
  /** Underlying inspect `complete` flag. Absent on a hand-written document means no read failure was recorded. */
  complete: boolean;
  /** Top-level inspect errors plus each Rem's field errors. */
  errors: unknown[];
  rules: RuleResult[];
}

type Step =
  | { kind: 'prop'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'filter'; key: string; value: string }
  | { kind: 'wildcard' };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseRulePath(path: string): Step[] {
  if (typeof path !== 'string' || !path || path.length > 500) fail(`Invalid rule path: ${path}`);
  const steps: Step[] = [];
  let index = 0;
  while (index < path.length) {
    if (path[index] === '.') {
      index += 1;
      if (index >= path.length || path[index] === '.') fail(`Invalid rule path: ${path}`);
    }
    if (path[index] === '[') {
      const end = path.indexOf(']', index);
      if (end < 0) fail(`Invalid rule path: ${path}`);
      const inner = path.slice(index + 1, end).trim();
      if (inner === '*') steps.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(inner)) steps.push({ kind: 'index', index: Number(inner) });
      else {
        const eq = inner.indexOf('=');
        if (eq <= 0) fail(`Invalid rule path: ${path}`);
        const key = inner.slice(0, eq);
        let value = inner.slice(eq + 1);
        if (
          (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
          (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        )
          value = value.slice(1, -1);
        if (!IDENTIFIER.test(key) || RESERVED.has(key)) fail(`Invalid rule path: ${path}`);
        steps.push({ kind: 'filter', key, value });
      }
      index = end + 1;
      continue;
    }
    const match = IDENTIFIER_PREFIX.exec(path.slice(index));
    if (!match || RESERVED.has(match[0])) fail(`Invalid rule path: ${path}`);
    steps.push({ kind: 'prop', name: match[0] });
    index += match[0].length;
  }
  if (steps.length === 0) fail(`Invalid rule path: ${path}`);
  return steps;
}

function readProp(value: unknown, name: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, name)) return undefined;
  return value[name];
}

function filterEquals(item: unknown, key: string, value: string): boolean {
  if (!isPlainObject(item) || !Object.hasOwn(item, key)) return false;
  const actual = item[key];
  if (typeof actual === 'number' || typeof actual === 'boolean') return String(actual) === value;
  return actual === value;
}

/**
 * Select a value. A property step after an array maps that property. A filter keeps an array.
 * `[*]` visits every element and flattens one nested array, so `rems[*].tags[*].name` is a flat list.
 */
export function selectRulePath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const step of parseRulePath(path)) {
    if (current === undefined || current === null) return undefined;
    if (step.kind === 'wildcard') {
      if (!Array.isArray(current)) return undefined;
      current = current.flatMap((item) => (Array.isArray(item) ? item : [item]));
      continue;
    }
    if (step.kind === 'prop') {
      current = Array.isArray(current)
        ? current.map((item) => readProp(item, step.name))
        : readProp(current, step.name);
    } else if (step.kind === 'index') {
      if (!Array.isArray(current) || step.index >= current.length) return undefined;
      current = current[step.index];
    } else if (!Array.isArray(current)) return undefined;
    else current = current.filter((item) => filterEquals(item, step.key, step.value));
  }
  return current;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
      )
    );
  }
  return false;
}

/** Partial match: listed object keys must match; arrays and scalars must be equal. */
export function matchesRulePattern(item: unknown, pattern: unknown): boolean {
  if (isPlainObject(pattern)) {
    if (!isPlainObject(item)) return false;
    return Object.entries(pattern).every(([key, expected]) =>
      matchesRulePattern(Object.hasOwn(item, key) ? item[key] : undefined, expected)
    );
  }
  return deepEqual(item, pattern);
}

function present(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function parseStateRulesFile(value: unknown): StateRulesFile {
  if (!isPlainObject(value)) fail('Rules file must be a JSON object');
  if (value.schemaVersion !== 1) fail('schemaVersion must equal 1');
  const allowed = ['schemaVersion', 'remIds', 'descendants', 'fields', 'summary', 'rules'];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unknown rules field: ${key}`);
  if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 200)
    fail('Expected 1 through 200 rules');
  if (value.remIds !== undefined) {
    if (
      !Array.isArray(value.remIds) ||
      value.remIds.length < 1 ||
      value.remIds.length > 100 ||
      value.remIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256)
    )
      fail('Invalid remIds');
    if (new Set(value.remIds).size !== value.remIds.length) fail('Duplicate Rem IDs');
  }
  if (
    value.descendants !== undefined &&
    (!Number.isInteger(value.descendants) ||
      (value.descendants as number) < 0 ||
      (value.descendants as number) > 20)
  )
    fail('Invalid descendants');
  if (value.fields !== undefined) {
    if (
      !Array.isArray(value.fields) ||
      value.fields.length < 1 ||
      value.fields.some((field) => !INSPECT_FIELDS.includes(field as InspectField))
    )
      fail('Invalid fields');
  }
  if (value.summary !== undefined && typeof value.summary !== 'boolean') fail('Invalid summary');
  const ids = new Set<string>();
  const rules = value.rules.map((rule) => parseRule(rule, ids));
  return {
    schemaVersion: 1,
    ...(value.remIds ? { remIds: value.remIds as string[] } : {}),
    ...(value.descendants !== undefined ? { descendants: value.descendants as number } : {}),
    ...(value.fields ? { fields: value.fields as InspectField[] } : {}),
    ...(value.summary !== undefined ? { summary: value.summary as boolean } : {}),
    rules,
  };
}

function parseRule(value: unknown, ids: Set<string>): StateRule {
  if (!isPlainObject(value)) fail('Each rule must be an object');
  const allowed = ['id', 'path', 'op', 'expect', 'match', 'baseline'];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`Unknown rule field: ${key}`);
  const id = value.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200 || id !== id.trim())
    fail('Each rule needs an id');
  if (ids.has(id)) fail(`Duplicate rule id: ${id}`);
  ids.add(id);
  if (typeof value.path !== 'string') fail(`Rule ${id} needs a path`);
  parseRulePath(value.path);
  if (typeof value.op !== 'string' || !RULE_OPS.includes(value.op as RuleOp))
    fail(`Rule ${id} has an unknown op`);
  const op = value.op as RuleOp;
  if (value.match !== undefined && !isPlainObject(value.match))
    fail(`Rule ${id} match must be an object`);
  if (value.match !== undefined && !['count', 'all', 'any', 'none'].includes(op))
    fail(`Rule ${id} does not use match`);
  if (
    value.baseline !== undefined &&
    (typeof value.baseline !== 'string' || !value.baseline.trim())
  )
    fail(`Rule ${id} baseline must be a path`);
  if (op === 'hashEquals') {
    if (value.baseline !== undefined && value.expect !== undefined)
      fail(`Rule ${id} uses baseline or expect, not both`);
    if (value.baseline === undefined && typeof value.expect !== 'string')
      fail(`Rule ${id} needs a string expect or a baseline file`);
  } else if (op === 'count') {
    if (typeof value.expect !== 'number' || !Number.isInteger(value.expect) || value.expect < 0)
      fail(`Rule ${id} count expects a non-negative integer`);
  } else if (!Object.hasOwn(value, 'expect')) fail(`Rule ${id} needs expect`);
  if (op === 'regex') {
    if (typeof value.expect !== 'string') fail(`Rule ${id} regex expects a string`);
    try {
      RegExp(value.expect);
    } catch {
      fail(`Rule ${id} has an invalid regex`);
    }
  }
  return {
    id,
    path: value.path,
    op,
    ...(Object.hasOwn(value, 'expect') ? { expect: value.expect } : {}),
    ...(value.match ? { match: value.match } : {}),
    ...(typeof value.baseline === 'string' ? { baseline: value.baseline } : {}),
  };
}

async function baselineText(baseDir: string, relative: string): Promise<string> {
  if (relative.includes('\0')) fail('Invalid baseline path');
  const full = isAbsolute(relative) ? relative : join(baseDir, relative);
  const buffer = await readFile(full);
  if (buffer.byteLength > 1024 * 1024) fail('Baseline file exceeds 1 MB');
  let text = buffer.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return text;
}

function readErrorKey(value: unknown): string {
  if (!isPlainObject(value)) return JSON.stringify(value);
  return JSON.stringify({
    id: value.id ?? null,
    field: value.field ?? null,
    message: value.message ?? null,
  });
}

function collectReadErrors(document: unknown): unknown[] {
  if (!isPlainObject(document)) return [{ message: 'Inspect document is not an object' }];
  const errors: unknown[] = [];
  const seen = new Set<string>();
  const push = (error: unknown) => {
    const key = readErrorKey(error);
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(error);
  };
  if (Array.isArray(document.errors)) for (const error of document.errors) push(error);
  if (Array.isArray(document.rems)) {
    for (const rem of document.rems) {
      if (!isPlainObject(rem) || !Array.isArray(rem.errors)) continue;
      const id = typeof rem.id === 'string' ? rem.id : undefined;
      for (const error of rem.errors)
        push(
          isPlainObject(error)
            ? { ...(id ? { id } : {}), ...error }
            : { ...(id ? { id } : {}), message: String(error) }
        );
    }
  }
  return errors;
}

function readComplete(document: unknown): boolean {
  if (!isPlainObject(document)) return false;
  if (typeof document.complete === 'boolean') return document.complete;
  return true;
}

function filtered(selected: unknown, match: Record<string, unknown> | undefined): unknown {
  if (!match) return selected;
  if (!Array.isArray(selected)) return undefined;
  return selected.filter((item) => matchesRulePattern(item, match));
}

export async function evaluateRules(
  document: unknown,
  rules: StateRule[],
  baseDir: string
): Promise<RuleReport> {
  const errors = collectReadErrors(document);
  const complete = readComplete(document);
  const results: RuleResult[] = [];
  for (const rule of rules) {
    const selected = filtered(selectRulePath(document, rule.path), rule.match);
    const expected =
      rule.op === 'hashEquals' && rule.baseline !== undefined
        ? await baselineText(baseDir, rule.baseline)
        : present(rule.expect);
    let pass = false;
    let actual: unknown = present(selected);
    if (selected !== undefined) {
      if (rule.op === 'equals' || rule.op === 'hashEquals') pass = deepEqual(selected, expected);
      else if (
        (rule.op === 'contains' || rule.op === 'notContains') &&
        typeof selected === 'string' &&
        typeof expected === 'string'
      )
        pass = rule.op === 'contains' ? selected.includes(expected) : !selected.includes(expected);
      else if ((rule.op === 'contains' || rule.op === 'notContains') && Array.isArray(selected)) {
        const found = selected.some((item) => deepEqual(item, expected));
        pass = rule.op === 'contains' ? found : !found;
      } else if (rule.op === 'startsWith')
        pass =
          typeof selected === 'string' &&
          typeof expected === 'string' &&
          selected.startsWith(expected);
      else if (rule.op === 'regex')
        pass = typeof selected === 'string' && new RegExp(String(rule.expect)).test(selected);
      else if (rule.op === 'count') {
        actual =
          typeof selected === 'number'
            ? selected
            : Array.isArray(selected)
              ? selected.length
              : null;
        pass = actual === expected;
      } else if (Array.isArray(selected)) {
        const items = selected;
        if (rule.op === 'all')
          pass = items.length > 0 && items.every((item) => matchesRulePattern(item, rule.expect));
        else if (rule.op === 'any')
          pass = items.some((item) => matchesRulePattern(item, rule.expect));
        else pass = items.every((item) => !matchesRulePattern(item, rule.expect));
      }
    } else if (rule.op === 'count') actual = null;
    results.push({ id: rule.id, status: pass ? 'pass' : 'fail', actual, expected });
  }
  const rulesOk = results.every((result) => result.status === 'pass');
  return {
    ok: rulesOk && complete && errors.length === 0,
    complete,
    errors,
    rules: results,
  };
}
