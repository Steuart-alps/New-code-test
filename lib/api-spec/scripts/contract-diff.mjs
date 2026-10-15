// Compares two OpenAPI documents and lists the changes that would break a
// client built against the older one. Released clients (the phone app above
// all) keep calling the API long after a deploy, so a request the old client
// sends must still be accepted and a response must still parse the old way.
//
// Rules, per operation (method + path, path parameter names ignored):
//   - removed operation, removed 2xx response or media type: breaking
//   - request (client -> server): a parameter or body field removed, newly
//     required or narrowed (type, enum value removed, format, tighter
//     min/max/length/pattern, oneOf variant removed): breaking
//   - response (server -> client): a field removed, no longer always present,
//     or widened to a type the old client does not expect (including null):
//     breaking. New enum values or oneOf variants: warning only
//   - anything added that old clients can ignore: allowed

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"];

function resolvePointer(doc, ref) {
  if (!ref.startsWith("#/")) throw new Error(`external $ref is not supported: ${ref}`);
  let node = doc;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = node?.[key];
    if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  }
  return node;
}

function deref(doc, node) {
  let ref = null;
  const seen = new Set();
  while (node && typeof node === "object" && typeof node.$ref === "string") {
    if (seen.has(node.$ref)) throw new Error(`circular $ref: ${node.$ref}`);
    seen.add(node.$ref);
    ref = node.$ref;
    node = resolvePointer(doc, node.$ref);
  }
  return { node: node ?? {}, ref };
}

const refName = (ref) => (ref ? ref.split("/").pop() : null);

function typesOf(schema) {
  let types = null;
  if (typeof schema.type === "string") types = new Set([schema.type]);
  else if (Array.isArray(schema.type)) types = new Set(schema.type);
  else if (schema.properties || schema.additionalProperties !== undefined) types = new Set(["object"]);
  else if (schema.items) types = new Set(["array"]);
  if (types && schema.nullable === true) types.add("null");
  return types;
}

// A flattened view of a schema: $ref followed, allOf merged, `nullable` and
// `anyOf/oneOf: [X, {type: null}]` folded into the type set.
function normalize(doc, input) {
  const { node, ref } = deref(doc, input);
  const out = {
    ref,
    types: typesOf(node),
    format: node.format,
    enum: Array.isArray(node.enum) ? node.enum : node.const !== undefined ? [node.const] : null,
    properties: new Map(Object.entries(node.properties ?? {})),
    required: new Set(node.required ?? []),
    items: node.items ?? null,
    additionalProperties: node.additionalProperties,
    variants: null,
    discriminator: node.discriminator?.propertyName ?? null,
    limits: {},
    pattern: node.pattern,
  };
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (typeof node[key] === "number") out.limits[key] = node[key];
  }

  for (const part of node.allOf ?? []) {
    const merged = normalize(doc, part);
    if (merged.types) out.types = out.types ? new Set([...out.types].filter((t) => merged.types.has(t))) : merged.types;
    for (const [name, prop] of merged.properties) out.properties.set(name, prop);
    for (const name of merged.required) out.required.add(name);
    out.format ??= merged.format;
    out.enum ??= merged.enum;
    out.items ??= merged.items;
    out.pattern ??= merged.pattern;
    if (out.additionalProperties === undefined) out.additionalProperties = merged.additionalProperties;
    out.limits = { ...merged.limits, ...out.limits };
    out.variants ??= merged.variants;
    out.discriminator ??= merged.discriminator;
  }
  if ((out.properties.size > 0 || out.additionalProperties !== undefined) && !out.types) out.types = new Set(["object"]);

  const variants = node.oneOf ?? node.anyOf;
  if (Array.isArray(variants)) {
    const nonNull = variants.filter((v) => !(v && v.type === "null"));
    const nullable = nonNull.length < variants.length;
    if (nonNull.length === 1) {
      const inner = normalize(doc, nonNull[0]);
      if (nullable && inner.types) inner.types.add("null");
      if (nullable && !inner.types) inner.types = null;
      return { ...inner, ref: ref ?? inner.ref };
    }
    out.variants = nonNull;
    if (nullable) out.types = new Set([...(out.types ?? []), "null"]);
  }
  return out;
}

const typeList = (types) => (types ? [...types].sort().join(" | ") : "any");

// Is every type in `a` also accepted by `b`? (integer fits in number; no
// type at all means anything)
function typesWithin(a, b) {
  if (!b) return true;
  if (!a) return false;
  return [...a].every((t) => b.has(t) || (t === "integer" && b.has("number")));
}

const show = (value) => JSON.stringify(value);

function variantKey(doc, variant, discriminator, index) {
  const { node, ref } = deref(doc, variant);
  if (ref) return `ref:${refName(ref)}`;
  const tag = discriminator ? node.properties?.[discriminator] : null;
  if (tag && (tag.const !== undefined || tag.enum?.length === 1)) return `tag:${tag.const ?? tag.enum[0]}`;
  return `index:${index}`;
}

function compareSchemas(ctx, baseInput, curInput, direction, where) {
  const base = normalize(ctx.base, baseInput);
  const cur = normalize(ctx.cur, curInput);
  if (base.ref && cur.ref) {
    const key = `${direction}|${base.ref}|${cur.ref}`;
    if (ctx.seen.has(key)) return;
    ctx.seen.add(key);
  }
  const breaking = (message) => ctx.report("breaking", where, message);
  const warning = (message) => ctx.report("warning", where, message);
  const request = direction === "request";

  if (request && !typesWithin(base.types, cur.types)) {
    const lostNull = base.types?.has("null") && !cur.types?.has("null");
    breaking(lostNull ? "no longer accepts null" : `type narrowed from ${typeList(base.types)} to ${typeList(cur.types)}`);
  }
  if (!request && !typesWithin(cur.types, base.types)) {
    const gainedNull = cur.types?.has("null") && !base.types?.has("null");
    breaking(gainedNull ? "can now be null" : `type changed from ${typeList(base.types)} to ${typeList(cur.types)}`);
  }

  if (base.format !== cur.format) {
    if (base.format && cur.format) breaking(`format changed from ${base.format} to ${cur.format}`);
    else if (request && cur.format) breaking(`now requires format ${cur.format}`);
    else if (!request && base.format) breaking(`no longer guaranteed to be format ${base.format}`);
  }

  if (base.enum || cur.enum) {
    if (request) {
      if (!cur.enum) {
        // widened to any value: fine
      } else if (!base.enum) {
        breaking(`now limited to ${cur.enum.map(show).join(", ")}`);
      } else {
        for (const value of base.enum) {
          if (!cur.enum.some((v) => Object.is(v, value))) breaking(`enum value ${show(value)} removed`);
        }
      }
    } else if (base.enum) {
      if (!cur.enum) warning("no longer limited to a fixed set of values");
      else {
        for (const value of cur.enum) {
          if (!base.enum.some((v) => Object.is(v, value))) warning(`new enum value ${show(value)} (old clients may not handle it)`);
        }
      }
    }
  }

  if (request) {
    const lower = { minimum: true, exclusiveMinimum: true, minLength: true, minItems: true };
    for (const key of new Set([...Object.keys(base.limits), ...Object.keys(cur.limits)])) {
      const was = base.limits[key];
      const now = cur.limits[key];
      if (now === undefined) continue;
      if (was === undefined) breaking(`new limit ${key}: ${now}`);
      else if (lower[key] ? now > was : now < was) breaking(`${key} tightened from ${was} to ${now}`);
    }
    if (cur.pattern && cur.pattern !== base.pattern) {
      breaking(base.pattern ? `pattern changed from ${show(base.pattern)} to ${show(cur.pattern)}` : `new pattern ${show(cur.pattern)}`);
    }
  }

  for (const [name, baseProp] of base.properties) {
    const at = `${where}.${name}`;
    const curProp = cur.properties.get(name);
    if (!curProp) {
      if (cur.additionalProperties && typeof cur.additionalProperties === "object") {
        compareSchemas(ctx, baseProp, cur.additionalProperties, direction, at);
      } else {
        ctx.report("breaking", at, request ? "field no longer accepted" : "field removed");
      }
      continue;
    }
    if (!request && base.required.has(name) && !cur.required.has(name)) {
      ctx.report("breaking", at, "no longer always present (was required)");
    }
    compareSchemas(ctx, baseProp, curProp, direction, at);
  }
  if (request) {
    for (const name of cur.required) {
      if (!base.required.has(name)) {
        ctx.report("breaking", `${where}.${name}`, base.properties.has(name) ? "now required" : "new required field");
      }
    }
    if (cur.additionalProperties === false && base.additionalProperties !== false && base.types?.has("object")) {
      breaking("no longer accepts extra fields");
    }
  }
  if (base.additionalProperties && typeof base.additionalProperties === "object") {
    if (cur.additionalProperties && typeof cur.additionalProperties === "object") {
      compareSchemas(ctx, base.additionalProperties, cur.additionalProperties, direction, `${where}{*}`);
    } else if (request && cur.additionalProperties === false) {
      breaking("no longer accepts extra keys");
    }
  }

  if (base.items && cur.items) compareSchemas(ctx, base.items, cur.items, direction, `${where}[]`);

  if (base.variants || cur.variants) {
    if (!base.variants || !cur.variants) {
      breaking(cur.variants ? "became a choice of shapes (oneOf/anyOf)" : "no longer a choice of shapes (oneOf/anyOf)");
      return;
    }
    const baseByKey = new Map(base.variants.map((v, i) => [variantKey(ctx.base, v, base.discriminator, i), v]));
    const curByKey = new Map(cur.variants.map((v, i) => [variantKey(ctx.cur, v, cur.discriminator, i), v]));
    for (const [key, variant] of baseByKey) {
      const label = key.replace(/^\w+:/, "");
      const match = curByKey.get(key);
      if (match) compareSchemas(ctx, variant, match, direction, `${where}<${label}>`);
      else if (request) breaking(`variant ${label} no longer accepted`);
    }
    if (!request) {
      for (const key of curByKey.keys()) {
        if (!baseByKey.has(key)) warning(`new variant ${key.replace(/^\w+:/, "")} (old clients may not handle it)`);
      }
    }
  }
}

function operations(doc) {
  const ops = new Map();
  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const { node: item } = deref(doc, rawItem);
    for (const method of METHODS) {
      if (!item[method]) continue;
      const key = `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;
      ops.set(key, { method: method.toUpperCase(), path, op: item[method], shared: item.parameters ?? [] });
    }
  }
  return ops;
}

function parameters(doc, entry) {
  const byKey = new Map();
  const pathParams = [];
  for (const raw of [...entry.shared, ...(entry.op.parameters ?? [])]) {
    const { node } = deref(doc, raw);
    if (node.in === "path") continue;
    const name = node.in === "header" ? String(node.name).toLowerCase() : node.name;
    byKey.set(`${node.in}:${name}`, node);
  }
  // Path parameters are matched by position, so renaming {id} to {siteId} is fine.
  const names = [...entry.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const all = [...entry.shared, ...(entry.op.parameters ?? [])].map((raw) => deref(doc, raw).node);
  for (const name of names) pathParams.push(all.find((p) => p.in === "path" && p.name === name) ?? { name, schema: {} });
  return { byKey, pathParams };
}

function compareContent(ctx, baseContent, curContent, direction, where) {
  for (const [mediaType, baseMedia] of Object.entries(baseContent ?? {})) {
    const curMedia = curContent?.[mediaType];
    if (!curMedia) {
      ctx.report("breaking", where, `${mediaType} no longer ${direction === "request" ? "accepted" : "returned"}`);
      continue;
    }
    if (baseMedia.schema && curMedia.schema) {
      compareSchemas(ctx, baseMedia.schema, curMedia.schema, direction, where);
    }
  }
}

export function compareContracts(baseDoc, curDoc) {
  const findings = [];
  const ctx = {
    base: baseDoc,
    cur: curDoc,
    seen: new Set(),
    operation: "",
    report(level, where, message) {
      findings.push({ level, operation: ctx.operation, where, message });
    },
  };

  const baseOps = operations(baseDoc);
  const curOps = operations(curDoc);
  for (const [key, baseEntry] of baseOps) {
    ctx.operation = `${baseEntry.method} ${baseEntry.path}${baseEntry.op.operationId ? ` (${baseEntry.op.operationId})` : ""}`;
    ctx.seen.clear();
    const curEntry = curOps.get(key);
    if (!curEntry) {
      ctx.report("breaking", "", "operation removed");
      continue;
    }

    const baseParams = parameters(baseDoc, baseEntry);
    const curParams = parameters(curDoc, curEntry);
    baseParams.pathParams.forEach((param, i) => {
      compareSchemas(ctx, param.schema ?? {}, curParams.pathParams[i]?.schema ?? {}, "request", `path parameter ${param.name}`);
    });
    for (const [paramKey, baseParam] of baseParams.byKey) {
      const where = `${baseParam.in} parameter ${baseParam.name}`;
      const curParam = curParams.byKey.get(paramKey);
      if (!curParam) {
        ctx.report("breaking", where, "parameter removed");
        continue;
      }
      if (curParam.required && !baseParam.required) ctx.report("breaking", where, "now required");
      compareSchemas(ctx, baseParam.schema ?? {}, curParam.schema ?? {}, "request", where);
    }
    for (const [paramKey, curParam] of curParams.byKey) {
      if (!baseParams.byKey.has(paramKey) && curParam.required) {
        ctx.report("breaking", `${curParam.in} parameter ${curParam.name}`, "new required parameter");
      }
    }

    const baseBody = baseEntry.op.requestBody ? deref(baseDoc, baseEntry.op.requestBody).node : null;
    const curBody = curEntry.op.requestBody ? deref(curDoc, curEntry.op.requestBody).node : null;
    if (curBody?.required && !baseBody?.required) {
      ctx.report("breaking", "request body", baseBody ? "now required" : "new required request body");
    }
    if (baseBody) {
      if (!curBody) ctx.report("breaking", "request body", "no longer accepted");
      else compareContent(ctx, baseBody.content, curBody.content, "request", "request body");
    }

    const curResponses = curEntry.op.responses ?? {};
    for (const [status, rawResponse] of Object.entries(baseEntry.op.responses ?? {})) {
      const where = `response ${status}`;
      const baseResponse = deref(baseDoc, rawResponse).node;
      const curRaw = curResponses[status];
      if (!curRaw) {
        if (/^2/.test(status)) ctx.report("breaking", where, "response removed");
        continue;
      }
      const curResponse = deref(curDoc, curRaw).node;
      compareContent(ctx, baseResponse.content, curResponse.content, "response", where);
    }
  }

  return {
    breaking: findings.filter((f) => f.level === "breaking"),
    warnings: findings.filter((f) => f.level === "warning"),
  };
}

export function formatFinding(finding) {
  const where = finding.where ? ` ${finding.where}` : "";
  return `${finding.operation}${where}: ${finding.message}`;
}
