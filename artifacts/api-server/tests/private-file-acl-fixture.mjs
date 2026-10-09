// Isolated provider/database doubles. No cloud credentials or application data.
import { Readable } from "node:stream";

const buckets = new Map();
export const writes = [];
// One-shot provider fault for the ACL write. Armed by the test and consumed
// by the next setMetadata call before anything is persisted, as a rejected
// GCS metadata PATCH would be. The test always clears it in cleanup.
const metadataFault = { armed: null, consumed: [] };
export function failNextSetMetadata(message = "Injected provider setMetadata failure") {
  if (metadataFault.armed) throw new Error("A setMetadata fault is already armed");
  metadataFault.armed = message;
}
export function consumedSetMetadataFaults() { return metadataFault.consumed.slice(); }
export function clearSetMetadataFault() {
  const wasArmed = metadataFault.armed !== null;
  metadataFault.armed = null;
  metadataFault.consumed.length = 0;
  return wasArmed;
}
export class File {
  constructor(bucket, name) {
    this.bucket = bucket;
    this.name = name;
    this.bytes = null;
    this.metadata = {};
  }
  async exists() { return [this.bytes !== null]; }
  async getSignedUrl(options) {
    if (options.action !== "write") throw new Error("Unexpected provider operation");
    return [`https://storage.googleapis.com/${this.bucket.name}/${this.name}?fake-signature=write`];
  }
  async save(bytes) {
    this.bytes = Buffer.from(bytes);
    this.metadata = { size: String(this.bytes.length), contentType: "application/pdf", metadata: {} };
  }
  async getMetadata() { return [structuredClone(this.metadata)]; }
  async setMetadata(update) {
    if (this.bytes === null) throw new Error("Object does not exist");
    if (metadataFault.armed !== null) {
      const message = metadataFault.armed;
      metadataFault.armed = null;
      metadataFault.consumed.push(this.name);
      throw Object.assign(new Error(message), { code: 503 });
    }
    this.metadata = {
      ...this.metadata,
      ...update,
      metadata: { ...this.metadata.metadata, ...update.metadata },
    };
  }
  createReadStream() { return Readable.from([this.bytes]); }
}
export class Storage {
  bucket(name) {
    if (name !== "acl-test") throw new Error("Test attempted to use a non-fixture bucket");
    if (!buckets.has(name)) {
      const files = new Map();
      const bucket = {
        name,
        file(objectName) {
          if (!files.has(objectName)) files.set(objectName, new File(bucket, objectName));
          return files.get(objectName);
        },
      };
      buckets.set(name, bucket);
    }
    return buckets.get(name);
  }
}
export async function putSignedUpload(url, bytes) {
  const parsed = new URL(url);
  if (parsed.hostname !== "storage.googleapis.com" || parsed.search !== "?fake-signature=write") {
    throw new Error("Not a fixture upload URL");
  }
  const [, bucketName, ...parts] = parsed.pathname.split("/");
  await new Storage().bucket(bucketName).file(parts.join("/")).save(bytes);
}
export const db = {
  // Only the two statements these routes need are understood; anything else
  // fails loudly. Reads are not counted as document writes.
  async execute(query) {
    const text = (query?.queryChunks ?? [])
      .map(chunk => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
      .join("?").replace(/\s+/g, " ").trim();
    if (/^INSERT INTO doc_track_documents\b/.test(text)) {
      const row = { id: writes.length + 1 };
      writes.push({ kind: "doctrack", ...row });
      return { rows: [row] };
    }
    // Department-scoped readers run the PAT photo boundary check; no PAT
    // photo references exist in this fixture.
    if (/^SELECT \(SELECT count\(\*\) FROM check_photos\b/.test(text)) {
      return { rows: [{ pat_refs: 0, visible_refs: 0 }] };
    }
    throw new Error(`Unexpected fixture query: ${text.slice(0, 80)}`);
  },
  insert() {
    return {
      values(values) {
        return {
          async returning() {
            const row = { id: writes.length + 1, ...values };
            writes.push({ kind: "generic", ...row });
            return [row];
          },
        };
      },
    };
  },
};