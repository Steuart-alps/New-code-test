import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const workspace = await mkdtemp(path.join("/tmp", "complytrack-api-codegen-"));

const findInstalledOrval = async () => {
  const pnpmStore = path.join(root, "node_modules/.pnpm");
  const packages = (await readdir(pnpmStore))
    .filter((name) => name.startsWith("orval@"))
    .sort();

  for (const packageDirectory of packages) {
    const candidate = path.join(pnpmStore, packageDirectory, "node_modules/orval");
    try {
      await access(path.join(candidate, "dist/bin/orval.mjs"));
      return candidate;
    } catch {
      // Try the next installed pnpm package variant.
    }
  }

  throw new Error("could not find an installed Orval package under node_modules/.pnpm");
};

const copy = async (source, destination) => {
  await cp(path.join(root, source), path.join(workspace, destination), { recursive: true });
};

const run = async (args, cwd) => {
  try {
    await execFileAsync("pnpm", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = error && typeof error === "object"
      ? [error.stdout, error.stderr].filter(Boolean).join("\n")
      : "";
    throw new Error(
      `command failed in ${path.relative(workspace, cwd)}: pnpm ${args.join(" ")}\n${detail}\n${output}`,
      {
        cause: error,
      },
    );
  }
};

const runOrval = async (cwd, orvalPackage) => {
  const executable = path.join(orvalPackage, "dist/bin/orval.mjs");
  try {
    await execFileAsync(process.execPath, [executable, "--config", "./orval.config.ts"], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = error && typeof error === "object"
      ? [error.stdout, error.stderr].filter(Boolean).join("\n")
      : "";
    throw new Error(`command failed in lib/api-spec: ${process.execPath} ${executable} --config ./orval.config.ts\n${detail}\n${output}`, {
      cause: error,
    });
  }
};

const snapshot = async (directory, prefix = "") => {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = new Map();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [file, digest] of await snapshot(fullPath, relative)) {
        result.set(file, digest);
      }
    } else if (entry.isFile()) {
      result.set(relative, createHash("sha256").update(await readFile(fullPath)).digest("hex"));
    }
  }

  return result;
};

const diffSnapshots = (before, after) => {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .sort()
    .filter((file) => before.get(file) !== after.get(file))
    .map((file) => `${file}: ${before.get(file) ? "changed" : "added"}${after.get(file) ? "" : " / removed"}`);
};

try {
  const orvalPackage = await findInstalledOrval();
  await copy("tsconfig.base.json", "tsconfig.base.json");
  await copy("lib/api-spec/openapi.yaml", "lib/api-spec/openapi.yaml");
  await copy("lib/api-spec/orval.config.ts", "lib/api-spec/orval.config.ts");
  await copy("lib/api-spec/package.json", "lib/api-spec/package.json");
  await copy("lib/api-client-react/src", "lib/api-client-react/src");
  await copy("lib/api-client-react/tsconfig.json", "lib/api-client-react/tsconfig.json");
  await copy("lib/api-client-react/package.json", "lib/api-client-react/package.json");
  await copy("lib/api-zod/src", "lib/api-zod/src");
  await copy("lib/api-zod/tsconfig.json", "lib/api-zod/tsconfig.json");
  await copy("lib/api-zod/package.json", "lib/api-zod/package.json");
  await symlink(path.join(root, "node_modules"), path.join(workspace, "node_modules"), "dir");
  await symlink(
    path.join(root, "lib/api-client-react/node_modules"),
    path.join(workspace, "lib/api-client-react/node_modules"),
    "dir",
  );
  await symlink(
    path.join(root, "lib/api-zod/node_modules"),
    path.join(workspace, "lib/api-zod/node_modules"),
    "dir",
  );
  await mkdir(path.join(workspace, "lib/api-spec/node_modules"), { recursive: true });
  await symlink(orvalPackage, path.join(workspace, "lib/api-spec/node_modules/orval"), "dir");

  const apiSpec = path.join(workspace, "lib/api-spec");
  const apiClient = path.join(workspace, "lib/api-client-react");
  const apiZod = path.join(workspace, "lib/api-zod");
  const generated = [
    ["api-client-react", path.join(apiClient, "src/generated")],
    ["api-zod", path.join(apiZod, "src/generated")],
  ];

  const first = new Map();
  const committed = new Map();
  for (const [name, directory] of generated) {
    for (const [file, digest] of await snapshot(directory)) committed.set(`${name}/${file}`, digest);
  }

  await runOrval(apiSpec, orvalPackage);
  for (const [name, directory] of generated) {
    for (const [file, digest] of await snapshot(directory)) first.set(`${name}/${file}`, digest);
  }

  const committedDifferences = diffSnapshots(committed, first);
  if (committedDifferences.length > 0) {
    throw new Error(
      `checked-in generated output is out of date with the OpenAPI contract:\n${committedDifferences.join("\n")}\n` +
      "Run the api-spec codegen command and commit the generated client/schema changes.",
    );
  }

  await runOrval(apiSpec, orvalPackage);
  const second = new Map();
  for (const [name, directory] of generated) {
    for (const [file, digest] of await snapshot(directory)) second.set(`${name}/${file}`, digest);
  }

  const differences = diffSnapshots(first, second);
  if (differences.length > 0) {
    throw new Error(
      `generated output changed on the second run; Orval output is not deterministic:\n${differences.join("\n")}`,
    );
  }

  try {
    await run(["exec", "tsc", "-p", "tsconfig.json", "--noEmit"], apiClient);
    await run(["exec", "tsc", "-p", "tsconfig.json", "--noEmit"], apiZod);
  } catch (error) {
    throw new Error(`generated API client/schema typecheck failed; inspect the contract or generator output.\n${error}`, {
      cause: error,
    });
  }

  console.log("API codegen is deterministic and generated client/schema packages typecheck cleanly.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}