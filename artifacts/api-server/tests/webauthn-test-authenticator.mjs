// Software WebAuthn authenticator for API tests. It produces the same JSON a
// browser's navigator.credentials.create()/get() hands to @simplewebauthn's
// browser helpers: "none" attestation with an ES256 (P-256) key, so the real
// server-side verification in src/routes/auth.ts runs unmodified.
import crypto from "node:crypto";

const b64url = (value) => Buffer.from(value).toString("base64url");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest();

// Minimal CBOR encoder: unsigned/negative integers, text, byte strings, maps.
function cborHead(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(value, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(value, 1);
  return head;
}

function cbor(value) {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value] : Object.entries(value);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

export class TestAuthenticator {
  constructor({ origin }) {
    this.origin = origin;
    this.credentialId = crypto.randomBytes(32);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicJwk = publicKey.export({ format: "jwk" });
    this.counter = 0;
    this.userHandle = undefined;
  }

  get id() {
    return b64url(this.credentialId);
  }

  #clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: origin ?? this.origin, crossOrigin: false }));
  }

  #authData(rpId, flags, extra = Buffer.alloc(0)) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, extra]);
  }

  /** Answer server registration options (PublicKeyCredentialCreationOptionsJSON). */
  createCredential(options, { origin } = {}) {
    this.userHandle = options.user?.id;
    const coseKey = new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(this.publicJwk.x, "base64url")],
      [-3, Buffer.from(this.publicJwk.y, "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attestedCredential = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, cbor(coseKey)]);
    const authData = this.#authData(
      options.rp.id,
      FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_CREDENTIAL,
      attestedCredential,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.#clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64url(cbor({ fmt: "none", attStmt: {}, authData })),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /**
   * Answer server authentication options (PublicKeyCredentialRequestOptionsJSON).
   * `claimId` signs with this authenticator's key while presenting another
   * credential id, to model a forged assertion.
   */
  getAssertion(options, { claimId, origin } = {}) {
    this.counter += 1;
    const clientDataJSON = this.#clientData("webauthn.get", options.challenge, origin);
    const authenticatorData = this.#authData(options.rpId, FLAG_USER_PRESENT | FLAG_USER_VERIFIED);
    const signature = crypto.sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    const id = claimId ?? this.id;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
