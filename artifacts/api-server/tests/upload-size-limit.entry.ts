// Pure upload size-limit check: ObjectStorageService against an in-memory
// bucket. No database, network or credentials.
import { objectStorageClient, ObjectStorageService } from "../src/lib/objectStorage";
import { UploadTooLargeError, maxUploadBytes } from "../src/lib/uploadValidation";

export const BUCKET = "upload-size-limit-test-bucket";
type FakeObject = { size: number; contentType: string; metadata: Record<string, string>; generation: string };
export const objects = new Map<string, FakeObject>();

class FakeFile {
  constructor(public bucket: any, public name: string) {}
  private get object(): FakeObject {
    const object = objects.get(this.name);
    if (!object) throw Object.assign(new Error(`No such object: ${this.name}`), { code: 404 });
    return object;
  }
  async exists() { return [objects.has(this.name)]; }
  async getMetadata() {
    const o = this.object;
    return [{ name: this.name, size: String(o.size), contentType: o.contentType, generation: o.generation, metageneration: "1", metadata: { ...o.metadata } }];
  }
  async setMetadata(update: { metadata?: Record<string, string>; contentType?: string }) {
    const o = this.object;
    Object.assign(o.metadata, update.metadata ?? {});
    if (update.contentType) o.contentType = update.contentType;
    return [{}];
  }
  async delete() { objects.delete(this.name); return [{}]; }
}

(objectStorageClient as any).bucket = (name: string) => {
  if (name !== BUCKET) throw new Error(`Only ${BUCKET} is served`);
  const bucket: any = { name };
  bucket.file = (objectName: string) => new FakeFile(bucket, objectName);
  return bucket;
};

export function put(name: string, size: number, contentType = "application/pdf"): void {
  objects.set(name, { size, contentType, metadata: {}, generation: "1" });
}

export { ObjectStorageService, UploadTooLargeError, maxUploadBytes };
