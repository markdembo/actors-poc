// Type-aware compatibility for `actors check`.
//
// During a deploy, Workers on the previous version keep calling actors on the new one (and the
// other way round). So the new code must accept every argument the old callers could send, and
// old callers must understand every value the new code can return. This module reads each
// action's parameter and return types with the TypeScript compiler, records them as plain JSON
// (structure, not names: renaming a type alias is not a change), and compares two versions.
//
// Arguments and return values cross RPC, so they are data: primitives, literals, arrays, tuples,
// plain objects, unions and a few built-ins (Date, Map, ...). Anything else is compared by name.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const MAX_DEPTH = 10;
/** Built-ins compared by name and type arguments rather than by structure. */
const BUILTINS = new Set([
  "Date", "Map", "Set", "ReadonlyMap", "ReadonlySet", "RegExp", "Error", "ArrayBuffer", "DataView", "Blob", "File",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Request", "Response", "ReadableStream",
]);

/** Load TypeScript from the user's project. Returns null when it isn't installed. */
function loadTypeScript(root) {
  try {
    return createRequire(join(root, "package.json"))("typescript");
  } catch {
    return null;
  }
}

/**
 * Describe every action's parameter and return types.
 * Returns { types: { Actor: { action: { args: [{ t, opt }], returns } } } }, or { skipped: reason }.
 */
export function readTypes(root, actors) {
  const ts = loadTypeScript(root);
  if (!ts) return { skipped: "TypeScript isn't installed in this project" };

  const configPath = ts.findConfigFile(root, (f) => existsSync(f), "tsconfig.json");
  let options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true,
  };
  if (configPath && configPath.startsWith(root)) {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
    if (parsed) options = { ...parsed.options, noEmit: true };
  }
  const files = actors.map((a) => join(root, a.file));
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();

  const out = {};
  for (const a of actors) {
    const sf = program.getSourceFile(join(root, a.file));
    const mod = sf && checker.getSymbolAtLocation(sf);
    const sym = mod && checker.getExportsOfModule(mod).find((s) => s.name === a.name);
    if (!sym) continue;
    const actorType = checker.getTypeOfSymbolAtLocation(sym, sf);
    const config = prop(checker, actorType, "__config", sf);
    const actions = config && prop(checker, config, "actions", sf);
    if (!actions) continue;
    out[a.name] = {};
    for (const action of checker.getPropertiesOfType(actions)) {
      const fnType = checker.getTypeOfSymbolAtLocation(action, sf);
      const sig = fnType.getCallSignatures()[0];
      if (!sig) continue;
      const describe = makeDescriber(ts, checker, sf);
      const args = sig.getParameters().slice(1).map((p) => {
        const decl = p.valueDeclaration;
        const rest = decl && ts.isParameter(decl) && !!decl.dotDotDotToken;
        const opt = rest || (decl && ts.isParameter(decl) ? checker.isOptionalParameter(decl) : false);
        return { t: describe(checker.getTypeOfSymbolAtLocation(p, sf)), opt, ...(rest ? { rest: true } : {}) };
      });
      const ret = sig.getReturnType();
      out[a.name][action.name] = { args, returns: describe(checker.getAwaitedType(ret) ?? ret) };
    }
  }
  return { types: out };
}

function prop(checker, type, name, sf) {
  const p = checker.getPropertyOfType(type, name);
  return p ? checker.getTypeOfSymbolAtLocation(p, sf) : null;
}

function makeDescriber(ts, checker, sf) {
  const F = ts.TypeFlags;
  const stack = new Set();
  const describe = (type, depth = 0) => {
    const f = type.flags;
    if (f & (F.Any | F.Unknown | F.TypeParameter)) return { k: "any" };
    if (f & F.Never) return { k: "never" };
    if (f & F.StringLiteral) return { k: "lit", v: type.value };
    if (f & F.NumberLiteral) return { k: "lit", v: type.value };
    if (f & F.BooleanLiteral) return { k: "lit", v: type.intrinsicName === "true" };
    if (f & (F.String | F.TemplateLiteral | F.StringMapping)) return { k: "string" };
    if (f & F.Number) return { k: "number" };
    if (f & F.Boolean) return { k: "boolean" };
    if (f & (F.BigInt | F.BigIntLiteral)) return { k: "bigint" };
    if (f & F.Null) return { k: "null" };
    if (f & (F.Undefined | F.Void)) return { k: "undefined" };
    if (f & F.Union) return union(type.types.map((t) => describe(t, depth + 1)));
    const name = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    if (depth > MAX_DEPTH || stack.has(type)) return { k: "ref", name }; // recursive or very deep
    stack.add(type);
    try {
      if (checker.isTupleType(type)) {
        const target = type.target;
        return {
          k: "tuple",
          items: checker.getTypeArguments(type).map((t, i) => ({
            t: describe(t, depth + 1),
            opt: !!(target.elementFlags?.[i] & (ts.ElementFlags.Optional | ts.ElementFlags.Rest)),
          })),
        };
      }
      if (checker.isArrayType(type)) return { k: "array", of: describe(checker.getTypeArguments(type)[0], depth + 1) };
      const symName = type.getSymbol()?.getName();
      if (symName && BUILTINS.has(symName)) {
        const args = type.aliasTypeArguments ?? (type.target ? checker.getTypeArguments(type) : []);
        return { k: "ref", name: symName, args: args.map((t) => describe(t, depth + 1)) };
      }
      if (type.getCallSignatures().length || type.getConstructSignatures().length) return { k: "ref", name };
      if (f & (F.Object | F.Intersection)) {
        const props = {};
        for (const p of checker.getPropertiesOfType(type)) {
          props[p.name] = {
            t: describe(checker.getTypeOfSymbolAtLocation(p, sf), depth + 1),
            opt: !!(p.flags & ts.SymbolFlags.Optional),
          };
        }
        const index = checker.getIndexInfosOfType(type).find((i) => i.keyType.flags & (F.String | F.Number));
        return { k: "object", props, ...(index ? { index: describe(index.type, depth + 1) } : {}) };
      }
      return { k: "ref", name };
    } finally {
      stack.delete(type);
    }
  };
  return describe;
}

/** Flatten nested unions, merge true | false into boolean, sort for a stable lock file. */
function union(members) {
  const flat = members.flatMap((m) => (m.k === "union" ? m.of : [m]));
  const hasTrue = flat.some((m) => m.k === "lit" && m.v === true);
  const hasFalse = flat.some((m) => m.k === "lit" && m.v === false);
  let of = flat;
  if (hasTrue && hasFalse) of = [...flat.filter((m) => !(m.k === "lit" && typeof m.v === "boolean")), { k: "boolean" }];
  if (of.some((m) => m.k === "any")) return { k: "any" };
  const seen = new Map();
  for (const m of of) seen.set(JSON.stringify(m), m);
  const unique = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m);
  return unique.length === 1 ? unique[0] : { k: "union", of: unique };
}

// ───────────────────────────── comparison ─────────────────────────────

/** A short TypeScript-like rendering for error messages. */
export function printType(t, depth = 0) {
  if (!t) return "?";
  switch (t.k) {
    case "lit": return JSON.stringify(t.v);
    case "union": return t.of.map((m) => printType(m, depth)).join(" | ");
    case "array": return `${t.of.k === "union" ? `(${printType(t.of, depth)})` : printType(t.of, depth)}[]`;
    case "tuple": return `[${t.items.map((i) => printType(i.t, depth) + (i.opt ? "?" : "")).join(", ")}]`;
    case "ref": return t.args?.length ? `${t.name}<${t.args.map((a) => printType(a, depth)).join(", ")}>` : t.name;
    case "object": {
      if (depth > 1) return "{…}";
      const props = Object.entries(t.props).map(([k, p]) => `${k}${p.opt ? "?" : ""}: ${printType(p.t, depth + 1)}`);
      if (t.index) props.push(`[key: string]: ${printType(t.index, depth + 1)}`);
      return `{ ${props.join("; ")} }`;
    }
    default: return t.k;
  }
}

/**
 * Can every value of type `a` be used where `b` is expected?
 * Returns null when it can, or a reason. `any` on either side is treated as compatible (unknown).
 */
export function assignable(a, b, path = "") {
  const at = path ? ` at ${path}` : "";
  if (!a || !b || a.k === "any" || b.k === "any" || a.k === "never") return null;
  if (a.k === "union") {
    for (const m of a.of) {
      const r = assignable(m, b, path);
      if (r) return r;
    }
    return null;
  }
  if (b.k === "union") {
    // Prefer a member of the same kind, so the reason points at the real difference.
    const same = b.of.filter((m) => m.k === a.k || (a.k === "lit" && ["string", "number", "boolean"].includes(m.k)));
    for (const m of b.of) if (!assignable(a, m, path)) return null;
    if (same.length === 1) return assignable(a, same[0], path);
    return `${printType(a)} is not allowed by ${printType(b)}${at}`;
  }
  const no = () => `${printType(a)} is not ${printType(b)}${at}`;
  switch (b.k) {
    case "string": case "number": case "boolean": case "bigint":
      return a.k === b.k || (a.k === "lit" && typeof a.v === b.k) ? null : no();
    case "null": case "undefined": case "never":
      return a.k === b.k ? null : no();
    case "lit":
      return a.k === "lit" && a.v === b.v ? null : no();
    case "array":
      if (a.k === "array") return assignable(a.of, b.of, `${path}[]`);
      if (a.k === "tuple") {
        for (const [i, item] of a.items.entries()) {
          const r = assignable(item.t, b.of, `${path}[${i}]`);
          if (r) return r;
        }
        return null;
      }
      return no();
    case "tuple": {
      if (a.k !== "tuple") return no();
      for (const [i, item] of b.items.entries()) {
        const mine = a.items[i];
        if (!mine) {
          if (!item.opt) return `element ${i} is missing${at}`;
          continue;
        }
        if (mine.opt && !item.opt) return `element ${i} became required${at}`;
        const r = assignable(mine.t, item.t, `${path}[${i}]`);
        if (r) return r;
      }
      return a.items.length > b.items.length ? `${printType(a)} has more elements than ${printType(b)}${at}` : null;
    }
    case "ref":
      if (a.k !== "ref" || a.name !== b.name) return no();
      for (const [i, arg] of (b.args ?? []).entries()) {
        // Type arguments of built-ins (Map<K, V>...) are compared both ways: they must not change.
        const r = assignable(a.args?.[i], arg, path) ?? assignable(arg, a.args?.[i], path);
        if (r) return r;
      }
      return null;
    case "object": {
      if (a.k !== "object") return no();
      for (const [key, p] of Object.entries(b.props)) {
        const where = path ? `${path}.${key}` : key;
        const mine = a.props[key];
        if (!mine) {
          if (p.opt) continue;
          if (a.index) {
            const r = assignable(a.index, p.t, where);
            if (r) return r;
            continue;
          }
          return `property "${where}" is missing`;
        }
        if (mine.opt && !p.opt) return `property "${where}" became required`;
        const r = assignable(mine.t, p.t, where);
        if (r) return r;
      }
      if (b.index) {
        for (const [key, p] of Object.entries(a.props)) {
          const r = assignable(p.t, b.index, path ? `${path}.${key}` : key);
          if (r) return r;
        }
        if (a.index) return assignable(a.index, b.index, `${path}[key]`);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Breaking changes for one action between the shipped version (`before`) and this one (`after`).
 * Each is { args, returns } as produced by readTypes.
 */
export function compareAction(label, before, after) {
  const problems = [];
  const n = Math.max(before.args.length, after.args.length);
  for (let i = 0; i < n; i++) {
    const old = before.args[i];
    const now = after.args[i];
    const which = `argument ${i + 1}`;
    if (!old) {
      if (!now.opt) problems.push(`${label}: new required ${which} (${printType(now.t)}). Callers on the previous version don't send it; make it optional.`);
      continue;
    }
    if (!now) {
      if (!old.rest) problems.push(`${label}: ${which} was removed. Callers on the previous version still send it.`);
      continue;
    }
    if (old.opt && !now.opt) {
      problems.push(`${label}: ${which} became required. Callers on the previous version may leave it out.`);
      continue;
    }
    const sent = old.opt ? { k: "union", of: [old.t, { k: "undefined" }] } : old.t;
    const accepted = now.opt ? { k: "union", of: [now.t, { k: "undefined" }] } : now.t;
    const r = assignable(sent, accepted);
    if (r) {
      problems.push(
        `${label}: ${which} changed from ${printType(old.t)} to ${printType(now.t)} (${r}). ` +
          "Callers on the previous version still send the old shape.",
      );
    }
  }
  const r = assignable(after.returns, before.returns);
  if (r) {
    problems.push(
      `${label}: return type changed from ${printType(before.returns)} to ${printType(after.returns)} (${r}). ` +
        "Callers on the previous version still expect the old shape.",
    );
  }
  return problems;
}
