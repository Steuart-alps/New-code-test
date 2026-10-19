// Static inventory of the API's Express routes with their full mounted paths.
//
// Reads src/app.ts and every module it reaches with the TypeScript parser (no
// server, database or environment needed) and follows `.use()` mounts from
// `app` down through routers, imported routers and router factories (functions
// that build and return a Router, such as crudFor or
// createMonitoringPlanRouter). Each route comes back with its method, full
// path, declaring file and line, and the middleware named along the way.
//
// Route checks that only need one file (see viewer-route-policy.mjs) can key
// routes the same way: "<file> <METHOD> <path>".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);

function isRouterCreation(node) {
  if (!node || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === "Router")
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router");
}

function literalText(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return null;
}

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  const withoutJs = base.replace(/\.js$/, ".ts");
  return existsSync(withoutJs) ? withoutJs : null;
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
      && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
      return current.parent.name.text;
    }
    if (ts.isFunctionLike(current)) return "<anonymous>";
  }
  return null;
}

function parseModule(file) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const module = {
    file,
    sourceFile,
    imports: new Map(), // local name -> { file, name: "default" | export name }
    exports: new Map(), // export name -> local name
    routers: new Set(), // top-level Router() variables
    factories: new Map(), // function name -> local Router() variable it returns
    calls: [], // { receiver, scope, method, args, line }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const target = resolveModule(file, node.moduleSpecifier.text);
      const clause = node.importClause;
      if (target && clause.name) module.imports.set(clause.name.text, { file: target, name: "default" });
      if (target && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          module.imports.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
        }
      }
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      module.exports.set("default", node.expression.text);
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        module.exports.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isRouterCreation(node.initializer)) {
      const owner = enclosingFunctionName(node);
      if (owner) module.factories.set(owner, node.name.text);
      else module.routers.add(node.name.text);
    }
    if ((ts.isVariableStatement(node) || ts.isFunctionDeclaration(node))
      && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const names = ts.isFunctionDeclaration(node)
        ? [node.name?.text]
        : node.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : null));
      const isDefault = node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      for (const name of names.filter(Boolean)) module.exports.set(isDefault ? "default" : name, name);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)) {
      const method = node.expression.name.text;
      if (method === "use" || ROUTE_METHODS.has(method)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        module.calls.push({
          receiver: node.expression.expression.text,
          scope: enclosingFunctionName(node),
          method,
          args: [...node.arguments],
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return module;
}

function joinPaths(prefix, suffix) {
  const joined = `${prefix}/${suffix}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

/**
 * @param {string} appFile absolute path of src/app.ts
 * @param {{ appName?: string }} options
 */
export function discoverRoutes(appFile, { appName = "app" } = {}) {
  const srcDir = path.dirname(appFile);
  const modules = new Map();
  const load = (file) => {
    if (!modules.has(file)) modules.set(file, parseModule(file));
    return modules.get(file);
  };
  const rel = (file) => path.relative(srcDir, file);

  // A router node is "<file>#<local var>" or "<file>#fn:<factory>"; the app is "<file>#app".
  const nodeFor = (module, receiver, scope) => {
    if (module.file === appFile && receiver === appName && !scope) return `${module.file}#app`;
    if (scope && module.factories.get(scope) === receiver) return `${module.file}#fn:${scope}`;
    if (!scope && module.routers.has(receiver)) return `${module.file}#${receiver}`;
    return null;
  };

  const resolveExport = (file, name, seen = new Set()) => {
    const key = `${file}:${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const module = load(file);
    const local = module.exports.get(name);
    if (!local) return null;
    if (module.routers.has(local)) return `${file}#${local}`;
    if (module.factories.has(local)) return `${file}#fn:${local}`;
    const imported = module.imports.get(local);
    return imported ? resolveExport(imported.file, imported.name, seen) : null;
  };

  // What a `.use()` argument mounts, if it is a router.
  const resolveMounted = (module, arg, scope) => {
    if (ts.isIdentifier(arg)) {
      const name = arg.text;
      if (scope && module.factories.get(scope) === name) return `${module.file}#fn:${scope}`;
      if (module.routers.has(name)) return `${module.file}#${name}`;
      const imported = module.imports.get(name);
      if (imported) return resolveExport(imported.file, imported.name);
      return null;
    }
    if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
      const name = arg.expression.text;
      if (module.factories.has(name)) return `${module.file}#fn:${name}`;
      const imported = module.imports.get(name);
      if (imported) return resolveExport(imported.file, imported.name);
    }
    return null;
  };

  const nodes = new Map(); // node -> { routes: [], mounts: [] }
  const nodeEntry = (id) => {
    if (!nodes.has(id)) nodes.set(id, { routes: [], mounts: [] });
    return nodes.get(id);
  };
  const problems = [];

  const pending = [appFile];
  const scanned = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (scanned.has(file)) continue;
    scanned.add(file);
    const module = load(file);
    for (const imported of module.imports.values()) pending.push(imported.file);

    for (const call of module.calls) {
      const node = nodeFor(module, call.receiver, call.scope);
      if (!node) continue;
      const entry = nodeEntry(node);
      const where = `${rel(file)}:${call.line}`;
      const text = (arg) => arg.getText(module.sourceFile).replace(/\s+/g, " ");
      if (call.method === "use") {
        const prefix = literalText(call.args[0]);
        const rest = prefix === null ? call.args : call.args.slice(1);
        if (call.args[0] && prefix === null && !ts.isIdentifier(call.args[0]) && !ts.isCallExpression(call.args[0])
          && !ts.isArrowFunction(call.args[0]) && !ts.isFunctionExpression(call.args[0])) {
          problems.push(`${where}: .use() with a non-literal path (${text(call.args[0])}) cannot be inventoried`);
        }
        const middleware = [];
        for (const arg of rest) {
          const child = resolveMounted(module, arg, call.scope);
          if (child) entry.mounts.push({ prefix: prefix ?? "", child, middleware: [...middleware], where });
          else middleware.push(text(arg));
        }
        continue;
      }
      const routePath = literalText(call.args[0]);
      if (routePath === null) {
        problems.push(`${where}: ${call.method.toUpperCase()} route with a non-literal path (${call.args[0] ? text(call.args[0]) : "none"})`);
        continue;
      }
      entry.routes.push({
        method: call.method.toUpperCase(),
        path: routePath,
        file: rel(file),
        line: call.line,
        receiver: call.receiver,
        middleware: call.args.slice(1, -1).map(text),
      });
    }
  }

  const routes = [];
  const reached = new Set();
  const walk = (id, prefix, middleware, stack) => {
    if (stack.includes(id)) {
      problems.push(`router mount cycle: ${[...stack, id].map((n) => rel(n)).join(" -> ")}`);
      return;
    }
    reached.add(id);
    const entry = nodes.get(id);
    if (!entry) return;
    for (const route of entry.routes) {
      routes.push({ ...route, fullPath: joinPaths(prefix, route.path), mountMiddleware: middleware });
    }
    for (const mount of entry.mounts) {
      walk(mount.child, joinPaths(prefix, mount.prefix), [...middleware, ...mount.middleware], [...stack, id]);
    }
  };
  walk(`${appFile}#app`, "/", [], []);

  const unmounted = [...nodes.entries()]
    .filter(([id, entry]) => !reached.has(id) && entry.routes.length > 0)
    .map(([id, entry]) => ({ router: rel(id.split("#")[0]) + "#" + id.split("#")[1], routes: entry.routes }));

  return { routes, unmounted, problems };
}
