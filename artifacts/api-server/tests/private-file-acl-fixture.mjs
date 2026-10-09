// Isolated provider/database doubles. No cloud credentials or application data.
import { Readable } from "node:stream";

const buckets = new Map();
export const writes = [];
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
  async execute() {
    const row = { id: writes.length + 1 };
    writes.push({ kind: "doctrack", ...row });
    return { rows: [row] };
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