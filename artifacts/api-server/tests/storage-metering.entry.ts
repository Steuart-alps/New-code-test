// Real API (routes, sessions, tenant checks, SQL metering) for the storage
// pricing and download metering suite. Only two external services are
// replaced: the Google Cloud Storage bucket (an in-memory fake that streams
// objects in chunks, so partial and aborted downloads can be observed) and the
// Stripe subscription lookup used by the storage cost estimate (see
// storage-metering-billing.stub.ts, swapped in by the suite's bundler).
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import app, { markApplicationReady } from "../src/app";
import { pool } from "@workspace/db";
import { objectStorageClient, ObjectOwnershipError, ObjectStorageService } from "../src/lib/objectStorage";
import {
  createDownloadMeter,
  createDownloadToken,
  getMonthlyDownloadBytes,
  recordDownloadBytes,
  resolveDownloadToken,
  utcMonth,
} from "../src/lib/downloadUsage";
import { setTestSubscription, stripeLookups } from "./storage-metering-billing.stub";

if (process.env.NODE_ENV !== "test" || process.env.FRESH_SCHEMA_TEST !== "1") {
  throw new Error("This entry point is only for the isolated storage metering suite");
}

export const BUCKET = "storage-metering-test-bucket";

type FakeObject = {
  size: number;
  bytes?: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  /** Bytes per emitted chunk when streamed. */
  chunkSize: number;
  /** Pause between chunks, so a client can disconnect mid-stream. */
  chunkDelayMs: number;
  /** Provider stream fails after this many bytes. */
  failAfterBytes?: number;
};

const objects = new Map<string, FakeObject>();
/** Reads started against the fake provider, with the bytes each one emitted. */
export const providerReads: Array<{ name: string; emitted: number; finished: boolean }> = [];

export function putObject(name: string, options: {
  size?: number;
  bytes?: Buffer;
  owner?: string;
  visibility?: "private" | "public";
  contentType?: string;
  chunkSize?: number;
  chunkDelayMs?: number;
  failAfterBytes?: number;
}): void {
  const size = options.bytes ? options.bytes.length : options.size ?? 0;
  objects.set(name, {
    size,
    bytes: options.bytes,
    contentType: options.contentType ?? "application/octet-stream",
    metadata: options.owner === undefined ? {} : {
      "custom:aclPolicy": JSON.stringify({ owner: options.owner, visibility: options.visibility ?? "private" }),
    },
    chunkSize: options.chunkSize ?? 64 * 1024,
    chunkDelayMs: options.chunkDelayMs ?? 0,
    failAfterBytes: options.failAfterBytes,
  });
}

export function clearObjects(prefix: string): void {
  for (const name of [...objects.keys()]) if (name.startsWith(prefix)) objects.delete(name);
}

class FakeFile {
  constructor(public bucket: { name: string }, public name: string) {}
  private require(): FakeObject {
    const object = objects.get(this.name);
    if (!object) throw Object.assign(new Error(`No such object: ${this.name}`), { code: 404 });
    return object;
  }
  async exists(): Promise<[boolean]> { return [objects.has(this.name)]; }
  async getMetadata() {
    const object = this.require();
    return [{ name: this.name, size: String(object.size), contentType: object.contentType, metadata: { ...object.metadata } }];
  }
  createReadStream(range?: { start?: number; end?: number }) {
    const object = this.require();
    if (!object.bytes) throw new Error(`Fake object ${this.name} has a size but no content to stream`);
    const start = range?.start ?? 0;
    const end = range?.end === undefined ? object.bytes.length : range.end + 1;
    const body = object.bytes.subarray(start, end);
    const read = { name: this.name, emitted: 0, finished: false };
    providerReads.push(read);
    async function* chunks() {
      for (let offset = 0; offset < body.length; offset += object.chunkSize) {
        if (object.failAfterBytes !== undefined && read.emitted >= object.failAfterBytes) {
          throw new Error("Simulated provider stream failure");
        }
        if (offset > 0 && object.chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, object.chunkDelayMs));
        const chunk = Buffer.from(body.subarray(offset, offset + object.chunkSize));
        read.emitted += chunk.length;
        yield chunk;
      }
      read.finished = true;
    }
    return Readable.from(chunks(), { objectMode: false });
  }
}

(objectStorageClient as any).bucket = (name: string) => {
  if (name !== BUCKET) throw new Error(`Storage metering fake only serves ${BUCKET}, not ${name}`);
  const bucket = {
    name,
    file: (objectName: string) => new FakeFile(bucket, objectName),
    exists: async () => [true],
    getFiles: async (opts?: { prefix?: string }) => [
      [...objects.keys()].filter((key) => key.startsWith(opts?.prefix ?? "")).map((key) => new FakeFile(bucket, key)),
    ],
  };
  return bucket;
};

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  markApplicationReady();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { void pool.end().then(() => resolve()); });
    }),
  };
}

export {
  pool,
  ObjectStorageService,
  ObjectOwnershipError,
  createDownloadMeter,
  createDownloadToken,
  getMonthlyDownloadBytes,
  recordDownloadBytes,
  resolveDownloadToken,
  utcMonth,
  setTestSubscription,
  stripeLookups,
};
