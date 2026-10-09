import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const codegenLock = "/tmp/complytrack-api-codegen.lock";

const run = async (args, cwd, options = {}) => {
  try {
    await execFileAsync("pnpm", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = error && typeof error === "object"
      ? [error.stdout, error.stderr].filter(Boolean).join("\n")
      : "";
    throw new Error(
      `command failed in ${path.relative(root, cwd)}: pnpm ${args.join(" ")}\n${detail}\n${output}`,
      { cause: error },
    );
  }
};

const runCodegen = async () => {
  try {
    await execFileAsync("flock", [
      "-x",
      codegenLock,
      "pnpm",
      "--dir",
      "lib/api-spec",
      "run",
      "codegen",
    ], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = error && typeof error === "object"
      ? [error.stdout, error.stderr].filter(Boolean).join("\n")
      : "";
    throw new Error(`command failed: pnpm --dir lib/api-spec run codegen\n${detail}\n${output}`, {
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
  const apiClient = path.join(root, "lib/api-client-react");
  const apiZod = path.join(root, "lib/api-zod");
  const generated = [
    ["api-client-react", path.join(apiClient, "src/generated")],
    ["api-zod", path.join(apiZod, "src/generated")],
  ];
  const manualBarrels = [
    ["api-client-react/src/index.ts", path.join(apiClient, "src/index.ts")],
    ["api-zod/src/index.ts", path.join(apiZod, "src/index.ts")],
  ];

  const first = new Map();
  const committed = new Map();
  for (const [name, directory] of generated) {
    for (const [file, digest] of await snapshot(directory)) committed.set(`${name}/${file}`, digest);
  }
  const manualBefore = new Map();
  for (const [name, file] of manualBarrels) {
    manualBefore.set(name, createHash("sha256").update(await readFile(file)).digest("hex"));
  }

  await runCodegen();
  for (const [name, directory] of generated) {
    for (const [file, digest] of await snapshot(directory)) first.set(`${name}/${file}`, digest);
  }
  const manualAfterFirst = new Map();
  for (const [name, file] of manualBarrels) {
    manualAfterFirst.set(name, createHash("sha256").update(await readFile(file)).digest("hex"));
  }
  const changedManualBarrels = diffSnapshots(manualBefore, manualAfterFirst);
  if (changedManualBarrels.length > 0) {
    throw new Error(
      `manual API barrel exports changed during codegen:\n${changedManualBarrels.join("\n")}`,
    );
  }

  const committedDifferences = diffSnapshots(committed, first);
  if (committedDifferences.length > 0) {
    throw new Error(
      `checked-in generated output is out of date with the OpenAPI contract:\n${committedDifferences.join("\n")}\n` +
      "Run the api-spec codegen command and commit the generated client/schema changes.",
    );
  }

  await runCodegen();
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
}