/**
 * @file nla-drivers.js
 * @description Wave 4B animation subsystems:
 * - Sandboxed Driver Expression Parser & Evaluator (AST recursive-descent, ZERO eval/new Function)
 * - Safe Whitelisted Scene Property Resolver for Drivers
 * - Action Block Store, NLA Tracks & Strips Mixer (Replace / Add / Multiply, Influence, Solo/Mute, Scale/Repeat)
 */

import * as THREE from 'three';
import { evaluateFCurve, cloneHandlePair, normalizeExtrapolation } from '../core/fcurve-math.js';

const TWO_PI = Math.PI * 2;

const FORBIDDEN_TOKENS = new Set([
  '__proto__', 'constructor', 'prototype',
  'window', 'document', 'globalthis', 'self',
  'process', 'require', 'import', 'export',
  'eval', 'function', 'asyncfunction', 'generatorfunction',
  'fetch', 'xmlhttprequest', 'websocket',
  'localstorage', 'sessionstorage', 'indexeddb',
  'this', 'new', 'class', 'return', 'while', 'for', 'do', 'switch',
  'try', 'catch', 'throw', 'delete', 'typeof', 'void', 'with',
]);

const SAFE_MATH_CONSTANTS = Object.freeze({
  pi: Math.PI,
  PI: Math.PI,
  tau: Math.PI * 2,
  TAU: Math.PI * 2,
  e: Math.E,
  E: Math.E,
});

const SAFE_MATH_FUNCS = Object.freeze({
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  abs: Math.abs,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  clamp: (x, lo, hi) => Math.max(lo, Math.min(hi, x)),
  lerp: (a, b, t) => a + (b - a) * t,
  mix: (a, b, t) => a + (b - a) * t,
  step: (edge, x) => (x < edge ? 0 : 1),
  smoothstep: (edge0, edge1, x) => {
    const span = edge1 - edge0;
    if (Math.abs(span) < 1e-9) return x < edge0 ? 0 : 1;
    const t = Math.max(0, Math.min(1, (x - edge0) / span));
    return t * t * (3 - 2 * t);
  },
  mod: (a, b) => (b === 0 ? 0 : a - b * Math.floor(a / b)),
  radians: (deg) => (deg * Math.PI) / 180,
  degrees: (rad) => (rad * 180) / Math.PI,
});

// =========================================================================
// SANDBOXED DRIVER EXPRESSION COMPILER & EVALUATOR
// =========================================================================

function tokenizeExpression(source) {
  if (typeof source !== 'string') {
    throw new Error('Driver expression must be a string');
  }
  const src = source.trim();
  if (!src) {
    throw new Error('Driver expression cannot be empty');
  }
  if (src.length > 512) {
    throw new Error('Driver expression exceeds maximum length (512 chars)');
  }

  // Reject unsafe characters immediately
  if (/[;[\]{}`\\$"'@]/.test(src)) {
    throw new Error('Disallowed syntax character in driver expression');
  }

  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Two-character operators
    const two = src.slice(i, i + 2);
    if (two === '**' || two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ type: 'op', value: two === '**' ? '^' : two });
      i += 2;
      continue;
    }

    // Reject single '=' assignment
    if (ch === '=') {
      throw new Error('Assignment "=" is not allowed in driver expressions');
    }

    // Numbers: 123, 3.14, .5, 1e-4
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let start = i;
      while (i < n && src[i] >= '0' && src[i] <= '9') i++;
      if (i < n && src[i] === '.') {
        i++;
        while (i < n && src[i] >= '0' && src[i] <= '9') i++;
      }
      if (i < n && (src[i] === 'e' || src[i] === 'E')) {
        i++;
        if (i < n && (src[i] === '+' || src[i] === '-')) i++;
        const expStart = i;
        while (i < n && src[i] >= '0' && src[i] <= '9') i++;
        if (i === expStart) throw new Error(`Malformed exponent near index ${start}`);
      }
      const num = Number(src.slice(start, i));
      if (!Number.isFinite(num)) throw new Error(`Invalid numeric literal at index ${start}`);
      tokens.push({ type: 'num', value: num });
      continue;
    }

    // Identifiers (variables or math functions)
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      while (i < n && ((src[i] >= 'a' && src[i] <= 'z') || (src[i] >= 'A' && src[i] <= 'Z') || (src[i] >= '0' && src[i] <= '9') || src[i] === '_')) {
        i++;
      }
      const ident = src.slice(start, i);
      if (FORBIDDEN_TOKENS.has(ident.toLowerCase())) {
        throw new Error(`Forbidden identifier "${ident}" in driver expression`);
      }
      // Disallow chained property dereferencing like obj.foo
      if (i < n && src[i] === '.') {
        throw new Error(`Direct member access ".${src.slice(i + 1, i + 12)}" is disallowed; bind a Driver Variable instead`);
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }

    if ('+-*/%^<>!?:(),'.includes(ch)) {
      if (ch === '(' || ch === ')' || ch === ',') {
        tokens.push({ type: 'punct', value: ch });
      } else {
        tokens.push({ type: 'op', value: ch });
      }
      i++;
      continue;
    }

    throw new Error(`Unexpected character "${ch}" in driver expression`);
  }

  return tokens;
}

export function compileDriverExpression(source) {
  const tokens = tokenizeExpression(source);
  let pos = 0;

  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++];

  function parseTernary() {
    let cond = parseOr();
    if (peek()?.type === 'op' && peek().value === '?') {
      consume();
      const thenBranch = parseTernary();
      if (!(peek()?.type === 'op' && peek().value === ':')) {
        throw new Error('Expected ":" in conditional ternary expression');
      }
      consume();
      const elseBranch = parseTernary();
      return { kind: 'ternary', cond, thenBranch, elseBranch };
    }
    return cond;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === 'op' && peek().value === '||') {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd() {
    let left = parseEquality();
    while (peek()?.type === 'op' && peek().value === '&&') {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseEquality() };
    }
    return left;
  }

  function parseEquality() {
    let left = parseRelational();
    while (peek()?.type === 'op' && (peek().value === '==' || peek().value === '!=')) {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseRelational() };
    }
    return left;
  }

  function parseRelational() {
    let left = parseAdd();
    while (peek()?.type === 'op' && ['<', '<=', '>', '>='].includes(peek().value)) {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseAdd() };
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseMul() };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek()?.type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = consume().value;
      left = { kind: 'bin', op, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.type === 'op' && ['+', '-', '!'].includes(peek().value)) {
      const op = consume().value;
      return { kind: 'unary', op, arg: parseUnary() };
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek()?.type === 'op' && peek().value === '^') {
      consume();
      return { kind: 'bin', op: '^', left: base, right: parseUnary() };
    }
    return base;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of driver expression');

    if (tok.type === 'num') {
      consume();
      return { kind: 'lit', value: tok.value };
    }

    if (tok.type === 'punct' && tok.value === '(') {
      consume();
      const expr = parseTernary();
      if (!(peek()?.type === 'punct' && peek().value === ')')) {
        throw new Error('Missing closing ")"');
      }
      consume();
      return expr;
    }

    if (tok.type === 'ident') {
      consume();
      const name = tok.value;
      if (peek()?.type === 'punct' && peek().value === '(') {
        consume();
        const fn = SAFE_MATH_FUNCS[name];
        if (!fn) {
          throw new Error(`Unknown or disallowed math function "${name}()"`);
        }
        const args = [];
        if (!(peek()?.type === 'punct' && peek().value === ')')) {
          while (true) {
            args.push(parseTernary());
            if (peek()?.type === 'punct' && peek().value === ',') {
              consume();
            } else {
              break;
            }
          }
        }
        if (!(peek()?.type === 'punct' && peek().value === ')')) {
          throw new Error(`Expected ")" after arguments to ${name}()`);
        }
        consume();
        return { kind: 'call', name, fn, args };
      }
      return { kind: 'var', name };
    }

    throw new Error(`Unexpected token "${tok.value}" in driver expression`);
  }

  const ast = parseTernary();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing token "${tokens[pos].value}"`);
  }
  return ast;
}

export function evaluateDriverAST(node, env = {}) {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'var': {
      const name = node.name;
      if (Object.prototype.hasOwnProperty.call(env, name)) {
        const v = Number(env[name]);
        return Number.isFinite(v) ? v : 0;
      }
      if (Object.prototype.hasOwnProperty.call(SAFE_MATH_CONSTANTS, name)) {
        return SAFE_MATH_CONSTANTS[name];
      }
      return 0;
    }
    case 'unary': {
      const a = evaluateDriverAST(node.arg, env);
      if (node.op === '-') return -a;
      if (node.op === '+') return +a;
      return a ? 0 : 1;
    }
    case 'call': {
      const args = node.args.map((a) => evaluateDriverAST(a, env));
      const res = node.fn(...args);
      return Number.isFinite(res) ? res : 0;
    }
    case 'ternary': {
      const c = evaluateDriverAST(node.cond, env);
      return c ? evaluateDriverAST(node.thenBranch, env) : evaluateDriverAST(node.elseBranch, env);
    }
    case 'bin': {
      if (node.op === '&&') {
        const l = evaluateDriverAST(node.left, env);
        return l ? (evaluateDriverAST(node.right, env) ? 1 : 0) : 0;
      }
      if (node.op === '||') {
        const l = evaluateDriverAST(node.left, env);
        return l ? 1 : (evaluateDriverAST(node.right, env) ? 1 : 0);
      }
      const l = evaluateDriverAST(node.left, env);
      const r = evaluateDriverAST(node.right, env);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return Math.abs(r) < 1e-12 ? 0 : l / r;
        case '%': return Math.abs(r) < 1e-12 ? 0 : l % r;
        case '^': return Math.pow(l, r);
        case '<': return l < r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return Math.abs(l - r) < 1e-9 ? 1 : 0;
        case '!=': return Math.abs(l - r) >= 1e-9 ? 1 : 0;
        default: return 0;
      }
    }
    default:
      return 0;
  }
}

export function evaluateDriverExpression(source, env = {}) {
  const ast = compileDriverExpression(source);
  return evaluateDriverAST(ast, env);
}

// =========================================================================
// SAFE SCENE PROPERTY READ/WRITE FOR DRIVERS
// =========================================================================

const ALLOWED_VEC_PROPS = new Set(['position', 'rotation', 'scale']);
const ALLOWED_AXES = new Set(['x', 'y', 'z']);
const ALLOWED_SCALAR_PROPS = new Set(['intensity', 'distance', 'decay', 'angle', 'penumbra', 'fov', 'zoom', 'near', 'far']);
const ALLOWED_MAT_PROPS = new Set(['opacity', 'roughness', 'metalness', 'emissiveIntensity', 'transmission', 'ior']);

function findTargetTargetNode(obj, boneName = null) {
  if (!obj) return null;
  if (boneName && typeof obj.getObjectByName === 'function') {
    const bone = obj.getObjectByName(boneName);
    if (bone) return bone;
  }
  return obj;
}

export function resolveNumericProperty(obj, path, boneName = null) {
  const target = findTargetTargetNode(obj, boneName);
  if (!target || typeof path !== 'string') return 0;
  const parts = path.split('.');
  if (parts.length === 2 && ALLOWED_VEC_PROPS.has(parts[0]) && ALLOWED_AXES.has(parts[1])) {
    const v = Number(target[parts[0]]?.[parts[1]]);
    return Number.isFinite(v) ? v : 0;
  }
  if (parts.length === 1 && ALLOWED_SCALAR_PROPS.has(parts[0])) {
    const v = Number(target[parts[0]]);
    return Number.isFinite(v) ? v : 0;
  }
  if (parts.length === 2 && parts[0] === 'material' && ALLOWED_MAT_PROPS.has(parts[1])) {
    const mat = Array.isArray(target.material) ? target.material[0] : target.material;
    const v = Number(mat?.[parts[1]]);
    return Number.isFinite(v) ? v : 0;
  }
  if (parts.length === 2 && parts[0] === 'morphTargetInfluences' && Array.isArray(target.morphTargetInfluences)) {
    const idx = Number.parseInt(parts[1], 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < target.morphTargetInfluences.length) {
      const v = Number(target.morphTargetInfluences[idx]);
      return Number.isFinite(v) ? v : 0;
    }
  }
  if (parts.length === 2 && parts[0] === 'userData' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1]) && !FORBIDDEN_TOKENS.has(parts[1].toLowerCase())) {
    const v = Number(target.userData?.[parts[1]]);
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}

export function applyNumericProperty(obj, path, rawValue, boneName = null) {
  const target = findTargetTargetNode(obj, boneName);
  if (!target || typeof path !== 'string' || !Number.isFinite(rawValue)) return false;
  const parts = path.split('.');
  if (parts.length === 2 && ALLOWED_VEC_PROPS.has(parts[0]) && ALLOWED_AXES.has(parts[1])) {
    if (!target[parts[0]]) return false;
    target[parts[0]][parts[1]] = rawValue;
    target.updateMatrixWorld?.(true);
    return true;
  }
  if (parts.length === 1 && ALLOWED_SCALAR_PROPS.has(parts[0]) && parts[0] in target) {
    target[parts[0]] = rawValue;
    target.updateProjectionMatrix?.();
    return true;
  }
  if (parts.length === 2 && parts[0] === 'material' && ALLOWED_MAT_PROPS.has(parts[1])) {
    const mat = Array.isArray(target.material) ? target.material[0] : target.material;
    if (!mat) return false;
    mat[parts[1]] = rawValue;
    if (parts[1] === 'opacity' && rawValue < 1 && !mat.transparent) {
      mat.transparent = true;
    }
    return true;
  }
  if (parts.length === 2 && parts[0] === 'morphTargetInfluences' && Array.isArray(target.morphTargetInfluences)) {
    const idx = Number.parseInt(parts[1], 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < target.morphTargetInfluences.length) {
      target.morphTargetInfluences[idx] = Math.max(0, Math.min(1, rawValue));
      return true;
    }
  }
  if (parts.length === 2 && parts[0] === 'userData' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1]) && !FORBIDDEN_TOKENS.has(parts[1].toLowerCase())) {
    target.userData = target.userData || {};
    target.userData[parts[1]] = rawValue;
    return true;
  }
  return false;
}

export class DriverManager {
  constructor(options = {}) {
    this.sceneManager = options.sceneManager || null;
    this.drivers = []; // Array<{ id, targetUuid, targetUserId, targetName, boneName, targetPath, expression, enabled, variables, lastValue, lastError }>
    this._compiledCache = new Map();
  }

  _genId() {
    return `drv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  _resolveObject(idOrUuid, fallbackName = null) {
    if (!idOrUuid && !fallbackName) return null;
    let found = null;
    if (this.sceneManager && typeof this.sceneManager.traverseObjects === 'function') {
      this.sceneManager.traverseObjects((o) => {
        if (found) return;
        if ((idOrUuid && (o.uuid === idOrUuid || o.userData?.id === idOrUuid)) || (fallbackName && o.name === fallbackName)) {
          found = o;
        }
      });
    }
    return found;
  }

  compileDriver(drv) {
    try {
      const ast = compileDriverExpression(drv.expression || '0');
      this._compiledCache.set(drv.id, ast);
      drv.lastError = null;
      return ast;
    } catch (err) {
      this._compiledCache.delete(drv.id);
      drv.lastError = err.message;
      return null;
    }
  }

  addDriver({
    targetObject = null,
    targetUuid = null,
    boneName = null,
    targetPath = 'position.y',
    expression = 'sin(frame * 0.1)',
    variables = [],
    enabled = true,
  } = {}) {
    const obj = targetObject || this._resolveObject(targetUuid);
    if (!obj) throw new Error('Target object not found for driver');

    // Validate expression up front
    const ast = compileDriverExpression(expression);

    // Replace existing driver targeting identical (targetUuid, boneName, targetPath)
    const cleanBone = boneName || null;
    const existingIdx = this.drivers.findIndex(
      (d) => d.targetUuid === obj.uuid && d.boneName === cleanBone && d.targetPath === targetPath
    );

    const record = {
      id: existingIdx >= 0 ? this.drivers[existingIdx].id : this._genId(),
      targetUuid: obj.uuid,
      targetUserId: obj.userData?.id || obj.uuid,
      targetName: obj.name || 'Object',
      boneName: cleanBone,
      targetPath,
      expression: String(expression).trim(),
      enabled: enabled !== false,
      variables: (variables || []).map((v) => ({
        name: String(v.name || 'var').replace(/[^A-Za-z0-9_]/g, '_'),
        objectUuid: v.object?.uuid || v.objectUuid || obj.uuid,
        objectUserId: v.object?.userData?.id || v.objectUserId || v.objectUuid || obj.userData?.id || obj.uuid,
        objectName: v.object?.name || v.objectName || null,
        boneName: v.boneName || null,
        propertyPath: String(v.propertyPath || 'position.x'),
      })),
      lastValue: 0,
      lastError: null,
    };

    if (existingIdx >= 0) {
      this.drivers[existingIdx] = record;
    } else {
      this.drivers.push(record);
    }
    this._compiledCache.set(record.id, ast);
    return record;
  }

  updateDriver(id, patch = {}) {
    const drv = this.drivers.find((d) => d.id === id);
    if (!drv) return null;
    if (patch.targetPath !== undefined) drv.targetPath = String(patch.targetPath);
    if (patch.boneName !== undefined) drv.boneName = patch.boneName || null;
    if (patch.enabled !== undefined) drv.enabled = !!patch.enabled;
    if (Array.isArray(patch.variables)) {
      drv.variables = patch.variables.map((v) => ({
        name: String(v.name || 'var').replace(/[^A-Za-z0-9_]/g, '_'),
        objectUuid: v.object?.uuid || v.objectUuid || drv.targetUuid,
        objectUserId: v.object?.userData?.id || v.objectUserId || v.objectUuid || drv.targetUserId,
        objectName: v.object?.name || v.objectName || null,
        boneName: v.boneName || null,
        propertyPath: String(v.propertyPath || 'position.x'),
      }));
    }
    if (patch.expression !== undefined) {
      drv.expression = String(patch.expression).trim();
      this.compileDriver(drv);
    }
    return drv;
  }

  removeDriver(id) {
    const idx = this.drivers.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.drivers.splice(idx, 1);
    this._compiledCache.delete(id);
    return true;
  }

  getDriversForObject(obj) {
    if (!obj) return [];
    return this.drivers.filter((d) => d.targetUuid === obj.uuid || (d.targetUserId && d.targetUserId === obj.userData?.id));
  }

  evaluateAll(context = {}) {
    if (this.drivers.length === 0) return 0;
    const frame = Number.isFinite(context.frame) ? context.frame : 0;
    const fps = Number.isFinite(context.fps) && context.fps > 0 ? context.fps : 30;
    const time = Number.isFinite(context.time) ? context.time : frame / fps;

    let applied = 0;
    for (const drv of this.drivers) {
      if (!drv.enabled) continue;
      let ast = this._compiledCache.get(drv.id);
      if (!ast) {
        ast = this.compileDriver(drv);
        if (!ast) continue;
      }

      const targetObj = this._resolveObject(drv.targetUuid, drv.targetName) || this._resolveObject(drv.targetUserId, drv.targetName);
      if (!targetObj) continue;
      drv.targetUuid = targetObj.uuid;

      const env = { frame, time, fps };
      for (const v of drv.variables || []) {
        const srcObj = this._resolveObject(v.objectUuid, v.objectName) || this._resolveObject(v.objectUserId, v.objectName);
        if (srcObj) v.objectUuid = srcObj.uuid;
        env[v.name] = srcObj ? resolveNumericProperty(srcObj, v.propertyPath, v.boneName) : 0;
      }

      const val = evaluateDriverAST(ast, env);
      drv.lastValue = val;
      if (Number.isFinite(val)) {
        if (applyNumericProperty(targetObj, drv.targetPath, val, drv.boneName)) {
          applied++;
        }
      }
    }
    return applied;
  }

  toJSON() {
    return this.drivers.map((d) => ({
      id: d.id,
      targetUserId: d.targetUserId || d.targetUuid,
      targetName: d.targetName,
      boneName: d.boneName || null,
      targetPath: d.targetPath,
      expression: d.expression,
      enabled: d.enabled !== false,
      variables: (d.variables || []).map((v) => ({ ...v })),
    }));
  }

  fromJSON(list, resolveById = null) {
    this.drivers = [];
    this._compiledCache.clear();
    if (!Array.isArray(list)) return;

    for (const raw of list) {
      if (!raw || !raw.expression || !raw.targetPath) continue;
      const targetObj = (resolveById ? resolveById(raw.targetUserId) : null) ||
        this._resolveObject(raw.targetUserId, raw.targetName);
      if (!targetObj) continue;

      const vars = (raw.variables || []).map((v) => {
        const srcObj = (resolveById ? resolveById(v.objectUserId) : null) ||
          this._resolveObject(v.objectUserId || v.objectUuid, v.objectName);
        return {
          name: String(v.name || 'var'),
          objectUuid: srcObj?.uuid || v.objectUuid || targetObj.uuid,
          objectUserId: srcObj?.userData?.id || v.objectUserId || v.objectUuid || targetObj.userData?.id || targetObj.uuid,
          objectName: srcObj?.name || v.objectName || null,
          boneName: v.boneName || null,
          propertyPath: String(v.propertyPath || 'position.x'),
        };
      });

      const rec = {
        id: raw.id || this._genId(),
        targetUuid: targetObj.uuid,
        targetUserId: targetObj.userData?.id || raw.targetUserId || targetObj.uuid,
        targetName: targetObj.name || raw.targetName || 'Object',
        boneName: raw.boneName || null,
        targetPath: String(raw.targetPath),
        expression: String(raw.expression),
        enabled: raw.enabled !== false,
        variables: vars,
        lastValue: 0,
        lastError: null,
      };
      this.compileDriver(rec);
      this.drivers.push(rec);
    }
  }
}

// =========================================================================
// ACTION STORAGE & NLA STRIP MIXER
// =========================================================================

function cloneKeyframeList(kfs = []) {
  return (kfs || []).map((k) => {
    const out = {
      frame: k.frame,
      interpolation: k.interpolation || 'smooth',
      position: k.position ? { ...k.position } : null,
      rotation: k.rotation ? { ...k.rotation } : null,
      scale: k.scale ? { ...k.scale } : null,
    };
    if (k.handles) {
      out.handles = {};
      for (const [ch, h] of Object.entries(k.handles)) {
        const c = cloneHandlePair(h);
        if (c) out.handles[ch] = c;
      }
    }
    return out;
  });
}

function cloneBoneTracksList(boneTracks = []) {
  const arr = boneTracks instanceof Map ? Array.from(boneTracks.values()) : (Array.isArray(boneTracks) ? boneTracks : []);
  return arr.map((bt) => ({
    boneName: bt.boneName,
    rotationTrack: (bt.rotationTrack || []).map((k) => {
      const copy = {
        frame: k.frame,
        interpolation: k.interpolation || 'smooth',
        quaternion: k.quaternion ? { ...k.quaternion } : null,
        euler: k.euler ? { ...k.euler } : null,
      };
      if (k.eulerModified) copy.eulerModified = true;
      if (k.handles) {
        copy.handles = {};
        for (const [ch, h] of Object.entries(k.handles)) {
          const c = cloneHandlePair(h);
          if (c) copy.handles[ch] = c;
        }
      }
      return copy;
    }),
    positionTrack: (bt.positionTrack || []).map((k) => {
      const copy = {
        frame: k.frame,
        interpolation: k.interpolation || 'smooth',
        position: k.position ? { ...k.position } : null,
      };
      if (k.handles) {
        copy.handles = {};
        for (const [ch, h] of Object.entries(k.handles)) {
          const c = cloneHandlePair(h);
          if (c) copy.handles[ch] = c;
        }
      }
      return copy;
    }),
  }));
}

export function cloneActionData(action) {
  const fcurveMeta = {};
  if (action?.fcurveMeta && typeof action.fcurveMeta === 'object') {
    for (const [k, v] of Object.entries(action.fcurveMeta)) {
      fcurveMeta[k] = { extrapolation: normalizeExtrapolation(v?.extrapolation) };
    }
  }
  return {
    id: action.id,
    name: action.name,
    fakeUser: !!action.fakeUser,
    keyframes: cloneKeyframeList(action.keyframes || []),
    fcurveMeta,
    boneTracks: cloneBoneTracksList(action.boneTracks || []),
    rangeStart: Number.isFinite(action.rangeStart) ? action.rangeStart : 0,
    rangeEnd: Number.isFinite(action.rangeEnd) ? action.rangeEnd : 30,
    createdAt: action.createdAt || Date.now(),
  };
}

export function computeActionRange(action) {
  let minF = Infinity;
  let maxF = -Infinity;
  for (const k of action?.keyframes || []) {
    if (k.frame < minF) minF = k.frame;
    if (k.frame > maxF) maxF = k.frame;
  }
  for (const bt of action?.boneTracks || []) {
    for (const k of bt.rotationTrack || []) {
      if (k.frame < minF) minF = k.frame;
      if (k.frame > maxF) maxF = k.frame;
    }
    for (const k of bt.positionTrack || []) {
      if (k.frame < minF) minF = k.frame;
      if (k.frame > maxF) maxF = k.frame;
    }
  }
  if (!Number.isFinite(minF) || !Number.isFinite(maxF)) return { start: 0, end: 20 };
  if (Math.abs(maxF - minF) < 1e-3) return { start: minF, end: minF + 10 };
  return { start: minF, end: maxF };
}

function shortestAngleDiff(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

function sampleActionChannelPose(action, actionFrame, defaultInterpolation = 'smooth') {
  const out = {
    position: null,
    rotation: null,
    scale: null,
    bones: null,
  };
  if (!action) return out;
  const meta = action.fcurveMeta || {};

  const makePt = (k, val, chKey) => {
    const h = k.handles?.[chKey];
    return {
      frame: k.frame,
      val,
      interpolation: k.interpolation || defaultInterpolation,
      hl: h?.hl || null,
      hr: h?.hr || null,
      handleType: h?.type || 'auto_clamped',
    };
  };

  if (Array.isArray(action.keyframes) && action.keyframes.length > 0) {
    const evalGroup = (prop, unwrap) => {
      const res = {};
      let hasAny = false;
      for (const axis of ['x', 'y', 'z']) {
        const ch = `${prop}.${axis}`;
        const pts = [];
        for (const k of action.keyframes) {
          if (k[prop] && Number.isFinite(k[prop][axis])) {
            pts.push(makePt(k, k[prop][axis], ch));
          }
        }
        if (pts.length > 0) {
          res[axis] = evaluateFCurve(pts, actionFrame, {
            defaultInterpolation,
            extrapolation: meta[ch]?.extrapolation || 'constant',
            unwrapAngles: unwrap,
          });
          hasAny = true;
        }
      }
      return hasAny ? res : null;
    };

    out.position = evalGroup('position', false);
    out.rotation = evalGroup('rotation', true);
    out.scale = evalGroup('scale', false);
  }

  if (Array.isArray(action.boneTracks) && action.boneTracks.length > 0) {
    out.bones = new Map();
    for (const bt of action.boneTracks) {
      const bPrefix = `bone:${bt.boneName}:`;
      const bPose = { position: null, rotation: null };

      if (Array.isArray(bt.positionTrack) && bt.positionTrack.length > 0) {
        const res = {};
        let any = false;
        for (const axis of ['x', 'y', 'z']) {
          const pts = [];
          for (const pk of bt.positionTrack) {
            if (pk.position && Number.isFinite(pk.position[axis])) {
              pts.push(makePt(pk, pk.position[axis], `position.${axis}`));
            }
          }
          if (pts.length > 0) {
            res[axis] = evaluateFCurve(pts, actionFrame, {
              defaultInterpolation,
              extrapolation: meta[bPrefix + `position.${axis}`]?.extrapolation || 'constant',
            });
            any = true;
          }
        }
        if (any) bPose.position = res;
      }

      if (Array.isArray(bt.rotationTrack) && bt.rotationTrack.length > 0) {
        const res = {};
        let any = false;
        for (const axis of ['x', 'y', 'z']) {
          const pts = [];
          for (const rk of bt.rotationTrack) {
            let e = rk.euler;
            if (!e && rk.quaternion) {
              const tmp = new THREE.Euler().setFromQuaternion(
                new THREE.Quaternion(rk.quaternion.x, rk.quaternion.y, rk.quaternion.z, rk.quaternion.w)
              );
              e = { x: tmp.x, y: tmp.y, z: tmp.z };
            }
            if (e && Number.isFinite(e[axis])) {
              pts.push(makePt(rk, e[axis], `rotation.${axis}`));
            }
          }
          if (pts.length > 0) {
            res[axis] = evaluateFCurve(pts, actionFrame, {
              defaultInterpolation,
              extrapolation: meta[bPrefix + `rotation.${axis}`]?.extrapolation || 'constant',
              unwrapAngles: true,
            });
            any = true;
          }
        }
        if (any) bPose.rotation = res;
      }

      if (bPose.position || bPose.rotation) {
        out.bones.set(bt.boneName, bPose);
      }
    }
  }

  return out;
}

function blendPoseGroup(acc, sample, prop, blendMode, influence) {
  if (!sample) return acc;
  const w = Math.max(0, Math.min(1, influence));
  if (w <= 0) return acc;

  const isRot = prop === 'rotation';
  const isScale = prop === 'scale';
  const out = acc ? { ...acc } : {};

  for (const axis of ['x', 'y', 'z']) {
    const sv = sample[axis];
    if (!Number.isFinite(sv)) continue;
    const base = Number.isFinite(out[axis]) ? out[axis] : (isScale ? 1 : 0);

    if (blendMode === 'add') {
      out[axis] = base + w * sv;
    } else if (blendMode === 'multiply') {
      const target = base * sv;
      out[axis] = base + w * (target - base);
    } else {
      // 'replace'
      if (!Number.isFinite(out[axis])) {
        out[axis] = w >= 0.999 ? sv : ((isScale ? 1 : 0) + w * (sv - (isScale ? 1 : 0)));
      } else if (isRot) {
        out[axis] = base + w * shortestAngleDiff(base, sv);
      } else {
        out[axis] = base + w * (sv - base);
      }
    }
  }
  return out;
}

/**
 * Evaluates a stack of NLA tracks for one object bottom-to-top at the given frame.
 * Returns { contributed: boolean, position, rotation, scale, bones } or null if no strip hit.
 */
export function evaluateNLATracks(tracks, actionLookup, frame, defaultInterpolation = 'smooth') {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  const anySolo = tracks.some((t) => t.solo && !t.muted);
  const acc = {
    contributed: false,
    position: null,
    rotation: null,
    scale: null,
    bones: new Map(),
  };

  for (const nlaTrack of tracks) {
    if (!nlaTrack || nlaTrack.muted) continue;
    if (anySolo && !nlaTrack.solo) continue;

    for (const strip of nlaTrack.strips || []) {
      const action = actionLookup(strip.actionId);
      if (!action) continue;

      const startF = Number(strip.startFrame) || 0;
      const repeat = Math.max(0.01, Number(strip.repeat) || 1);
      const scale = Math.max(0.01, Number(strip.scale) || 1);
      const aRange = computeActionRange(action);
      const aStart = Number.isFinite(strip.actionStart) ? strip.actionStart : aRange.start;
      const aEnd = Number.isFinite(strip.actionEnd) ? strip.actionEnd : aRange.end;
      const aSpan = Math.max(1e-4, aEnd - aStart);
      const endF = Number.isFinite(strip.endFrame) ? strip.endFrame : (startF + aSpan * scale * repeat);
      const stripSpan = Math.max(1e-4, endF - startF);
      const extrap = strip.extrapolate || 'nothing';

      let localFrame = null;
      if (frame < startF) {
        if (extrap === 'hold') localFrame = aStart;
        else continue;
      } else if (frame > endF) {
        if (extrap === 'hold' || extrap === 'hold_forward') localFrame = aEnd;
        else continue;
      } else {
        const norm = (frame - startF) / stripSpan;
        if (norm >= 1 - 1e-6) {
          localFrame = aEnd;
        } else {
          const cyc = norm * repeat;
          const phase = cyc - Math.floor(cyc);
          localFrame = aStart + phase * aSpan;
        }
      }

      const blendMode = strip.blendMode || 'replace';
      const influence = Number.isFinite(strip.influence) ? strip.influence : 1.0;
      const sampled = sampleActionChannelPose(action, localFrame, defaultInterpolation);

      if (sampled.position) {
        acc.position = blendPoseGroup(acc.position, sampled.position, 'position', blendMode, influence);
        acc.contributed = true;
      }
      if (sampled.rotation) {
        acc.rotation = blendPoseGroup(acc.rotation, sampled.rotation, 'rotation', blendMode, influence);
        acc.contributed = true;
      }
      if (sampled.scale) {
        acc.scale = blendPoseGroup(acc.scale, sampled.scale, 'scale', blendMode, influence);
        acc.contributed = true;
      }
      if (sampled.bones) {
        for (const [bName, bPose] of sampled.bones.entries()) {
          const prev = acc.bones.get(bName) || { position: null, rotation: null };
          if (bPose.position) prev.position = blendPoseGroup(prev.position, bPose.position, 'position', blendMode, influence);
          if (bPose.rotation) prev.rotation = blendPoseGroup(prev.rotation, bPose.rotation, 'rotation', blendMode, influence);
          acc.bones.set(bName, prev);
          acc.contributed = true;
        }
      }
    }
  }

  return acc.contributed ? acc : null;
}
