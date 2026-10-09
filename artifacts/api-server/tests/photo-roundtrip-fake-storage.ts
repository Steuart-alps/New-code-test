// IN-PROCESS FAKE of the Google Cloud Storage client, used only by the photo
// round trip's `--in-process-fake` mode to prove the test logic where no test
// bucket exists. It is NOT the real round trip: no Google endpoint, IAM,
// signing key or bucket CORS configuration is involved.
//
// The fake replaces only `objectStorageClient.bucket()`, so every route,
// ObjectStorageService method, content validator and ACL helper still runs.
// It also serves the browser's direct upload over HTTPS (the runner maps
// storage.googleapis.com to it inside the test browser only) with GCS-like
// signed-URL and CORS checks, and a loopback control port the test uses to
// inspect and clean up objects.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Readable } from "node:stream";

type StoredObject = {
  bytes: Buffer;
  generation: string;
  metageneration: string;
  contentType: string;
  metadata: Record<string, string>;
  updated: string;
};

type Preconditions = { ifGenerationMatch?: string | number; ifMetagenerationMatch?: string | number };

class FakeApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export type StorageRequestLog = {
  method: string;
  path: string;
  origin: string | null;
  hasCookie: boolean;
  hasCsrfHeader: boolean;
  hasAuthorization: boolean;
  status: number;
};

export function installInProcessFakeStorage(
  client: { bucket: (name: string) => unknown },
  options: {
    bucketName: string;
    corsOrigin: string;
    uploadPort: number;
    controlPort: number;
    tlsCertFile: string;
    tlsKeyFile: string;
  },
) {
  const objects = new Map<string, StoredObject>();
  const requestLog: StorageRequestLog[] = [];
  const signingKey = randomBytes(32);
  let generationCounter = Date.now() * 1000;
  const nextGeneration = () => String(++generationCounter);

  const requireBucket = (name: string) => {
    if (name !== options.bucketName) throw new Error(`In-process fake storage only serves ${options.bucketName}, not ${name}`);
  };
  const signature = (method: string, bucket: string, name: string, contentType: string, expiresAt: number) =>
    createHmac("sha256", signingKey).update(`${method}\n/${bucket}/${name}\n${contentType}\n${expiresAt}`).digest("hex");

  function checkPreconditions(existing: StoredObject | undefined, pre?: Preconditions) {
    if (!pre) return;
    if (pre.ifGenerationMatch !== undefined) {
      const expected = String(pre.ifGenerationMatch);
      if (expected === "0" ? existing !== undefined : existing?.generation !== expected) {
        throw new FakeApiError(412, "Precondition failed (generation)");
      }
    }
    if (pre.ifMetagenerationMatch !== undefined && existing?.metageneration !== String(pre.ifMetagenerationMatch)) {
      throw new FakeApiError(412, "Precondition failed (metageneration)");
    }
  }

  class FakeFile {
    constructor(
      public bucket: FakeBucket,
      public name: string,
      private pinnedGeneration?: string,
      private preconditions?: Preconditions,
    ) {}

    private key() { return `${this.bucket.name}/${this.name}`; }
    private current(): StoredObject | undefined {
      const object = objects.get(this.key());
      if (!object) return undefined;
      if (this.pinnedGeneration && object.generation !== this.pinnedGeneration) return undefined;
      return object;
    }
    private require(): StoredObject {
      const object = this.current();
      if (!object) throw new FakeApiError(404, `No such object: ${this.key()}`);
      return object;
    }
    private describe(object: StoredObject) {
      return {
        bucket: this.bucket.name,
        name: this.name,
        generation: object.generation,
        metageneration: object.metageneration,
        size: String(object.bytes.length),
        contentType: object.contentType,
        updated: object.updated,
        metadata: { ...object.metadata },
      };
    }

    async exists(): Promise<[boolean]> { return [Boolean(this.current())]; }
    async getMetadata(): Promise<[ReturnType<FakeFile["describe"]>]> { return [this.describe(this.require())]; }

    async setMetadata(update: { contentType?: string; metadata?: Record<string, string | null> }, opts?: { preconditionOpts?: Preconditions }) {
      const object = this.require();
      checkPreconditions(object, opts?.preconditionOpts ?? this.preconditions);
      if (update.contentType) object.contentType = update.contentType;
      for (const [key, value] of Object.entries(update.metadata ?? {})) {
        if (value === null) delete object.metadata[key];
        else object.metadata[key] = String(value);
      }
      object.metageneration = String(Number(object.metageneration) + 1);
      object.updated = new Date().toISOString();
      return [this.describe(object)];
    }

    async download(opts?: { start?: number; end?: number }): Promise<[Buffer]> {
      const object = this.require();
      checkPreconditions(object, this.preconditions);
      const start = opts?.start ?? 0;
      const end = opts?.end === undefined ? object.bytes.length : opts.end + 1;
      return [Buffer.from(object.bytes.subarray(start, end))];
    }

    createReadStream(range?: { start?: number; end?: number }) {
      const object = this.require();
      const start = range?.start ?? 0;
      const end = range?.end === undefined ? object.bytes.length : range.end + 1;
      return Readable.from([Buffer.from(object.bytes.subarray(start, end))]);
    }

    async save(bytes: Buffer, opts?: { contentType?: string; preconditionOpts?: Preconditions }) {
      checkPreconditions(objects.get(this.key()), opts?.preconditionOpts);
      objects.set(this.key(), {
        bytes: Buffer.from(bytes),
        generation: nextGeneration(),
        metageneration: "1",
        contentType: opts?.contentType ?? "application/octet-stream",
        metadata: {},
        updated: new Date().toISOString(),
      });
    }

    async copy(destination: FakeFile, opts?: { preconditionOpts?: Preconditions }) {
      const source = this.require();
      checkPreconditions(source, this.preconditions);
      await destination.save(source.bytes, { contentType: source.contentType, preconditionOpts: opts?.preconditionOpts });
      return [destination];
    }

    async delete(opts?: { ignoreNotFound?: boolean }) {
      const object = this.current();
      if (!object) {
        if (opts?.ignoreNotFound) return [];
        throw new FakeApiError(404, `No such object: ${this.key()}`);
      }
      objects.delete(this.key());
      return [];
    }

    async getSignedUrl(config: { action: string; expires: number; contentType?: string }): Promise<[string]> {
      const method = config.action === "write" ? "PUT" : config.action === "delete" ? "DELETE" : "GET";
      const expiresAt = Math.floor(Number(config.expires) / 1000);
      const contentType = config.contentType ?? "";
      const url = new URL(`https://storage.googleapis.com/${this.bucket.name}/${this.name}`);
      url.searchParams.set("X-Goog-Algorithm", "FAKE-HMAC-SHA256");
      url.searchParams.set("X-Goog-Expires-At", String(expiresAt));
      url.searchParams.set("X-Goog-SignedHeaders", contentType ? "content-type;host" : "host");
      url.searchParams.set("X-Goog-Signature", signature(method, this.bucket.name, this.name, contentType, expiresAt));
      return [url.toString()];
    }
  }

  class FakeBucket {
    constructor(public name: string) { requireBucket(name); }
    file(name: string, opts?: { generation?: string | number; preconditionOpts?: Preconditions }) {
      return new FakeFile(this, name, opts?.generation === undefined ? undefined : String(opts.generation), opts?.preconditionOpts);
    }
    async exists(): Promise<[boolean]> { return [true]; }
    async getFiles(opts?: { prefix?: string }) {
      const prefix = `${this.name}/${opts?.prefix ?? ""}`;
      return [[...objects.keys()].filter(key => key.startsWith(prefix)).map(key => this.file(key.slice(this.name.length + 1)))];
    }
  }

  client.bucket = (name: string) => new FakeBucket(name);

  // ── Browser-facing upload endpoint (HTTPS, GCS-like CORS + signed URLs) ──
  function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (origin !== options.corsOrigin) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    return true;
  }

  function handleUpload(req: IncomingMessage, res: ServerResponse, body: Buffer) {
    const url = new URL(req.url ?? "/", "https://storage.googleapis.com");
    if (req.method === "OPTIONS") {
      const requestedMethod = String(req.headers["access-control-request-method"] ?? "");
      const requestedHeaders = String(req.headers["access-control-request-headers"] ?? "")
        .split(",").map(header => header.trim().toLowerCase()).filter(Boolean);
      if (!applyCors(req, res) || requestedMethod !== "PUT" || requestedHeaders.some(header => header !== "content-type")) {
        res.removeHeader("Access-Control-Allow-Origin");
        return 403;
      }
      res.setHeader("Access-Control-Allow-Methods", "PUT");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "60");
      return 200;
    }
    applyCors(req, res);
    if (req.method !== "PUT") return 405;
    const [, bucket, ...rest] = url.pathname.split("/");
    const name = rest.join("/");
    if (bucket !== options.bucketName || !name) return 404;
    const expiresAt = Number(url.searchParams.get("X-Goog-Expires-At"));
    const contentType = String(req.headers["content-type"] ?? "");
    const signedContentType = url.searchParams.get("X-Goog-SignedHeaders")?.includes("content-type") ? contentType : "";
    const supplied = Buffer.from(url.searchParams.get("X-Goog-Signature") ?? "", "hex");
    const expected = Buffer.from(signature("PUT", bucket, name, signedContentType, expiresAt), "hex");
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return 400;
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return 403;
    objects.set(`${bucket}/${name}`, {
      bytes: body,
      generation: nextGeneration(),
      metageneration: "1",
      contentType,
      metadata: {},
      updated: new Date().toISOString(),
    });
    return 200;
  }

  const uploadServer = createHttpsServer(
    { cert: readFileSync(options.tlsCertFile), key: readFileSync(options.tlsKeyFile) },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const status = handleUpload(req, res, Buffer.concat(chunks));
        requestLog.push({
          method: req.method ?? "",
          path: new URL(req.url ?? "/", "https://storage.googleapis.com").pathname,
          origin: req.headers.origin ?? null,
          hasCookie: Boolean(req.headers.cookie),
          hasCsrfHeader: req.headers["x-csrf-token"] !== undefined,
          hasAuthorization: req.headers.authorization !== undefined,
          status,
        });
        res.statusCode = status;
        res.end();
      });
    },
  );
  uploadServer.listen(options.uploadPort, "127.0.0.1");

  // ── Loopback control endpoint for the test's bucket inspector ──
  const controlServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const prefix = url.searchParams.get("prefix") ?? "";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const matching = () => [...objects.entries()].filter(([key]) => key.startsWith(`${options.bucketName}/${prefix}`));
    if (url.pathname === "/objects" && req.method === "GET") {
      return send(200, matching().map(([key, object]) => ({
        name: key.slice(options.bucketName.length + 1),
        contentType: object.contentType,
        size: object.bytes.length,
        metadata: object.metadata,
        sha256: createHash("sha256").update(object.bytes).digest("hex"),
      })));
    }
    if (url.pathname === "/objects" && req.method === "DELETE") {
      const keys = matching().map(([key]) => key);
      keys.forEach(key => objects.delete(key));
      return send(200, { deleted: keys.length });
    }
    if (url.pathname === "/requests" && req.method === "GET") return send(200, requestLog);
    send(404, { error: "not found" });
  });
  controlServer.listen(options.controlPort, "127.0.0.1");
}
