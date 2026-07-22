import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type KeyMaterial = Buffer | string;

interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export function normalizeKey(material: KeyMaterial): Buffer {
  if (Buffer.isBuffer(material)) {
    if (material.length === 32) return Buffer.from(material);
    return createHash("sha256").update(material).digest();
  }

  const trimmed = material.trim();
  if (/^[a-f\d]{64}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32 && decoded.toString("base64").replace(/=+$/u, "") === trimmed.replace(/=+$/u, "")) {
      return decoded;
    }
  } catch {
    // Fall through to a deterministic passphrase-derived key.
  }

  return createHash("sha256").update(material, "utf8").digest();
}

export function loadOrCreateKey(databasePath: string, supplied?: KeyMaterial): Buffer {
  if (supplied !== undefined) return normalizeKey(supplied);

  const environmentKey = process.env.MEMORYD_ENCRYPTION_KEY;
  if (environmentKey) return normalizeKey(environmentKey);
  if (databasePath === ":memory:") return randomBytes(32);

  const keyPath = `${databasePath}.key`;
  if (existsSync(keyPath)) return normalizeKey(readFileSync(keyPath));

  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(32);
  try {
    writeFileSync(keyPath, generated, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (existsSync(keyPath)) return normalizeKey(readFileSync(keyPath));
    throw error;
  }
}

export function encryptJson(value: unknown, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptJson<T>(encoded: string, key: Buffer, aad: string): T {
  const envelope = JSON.parse(encoded) as Partial<EncryptedEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.alg !== "aes-256-gcm" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("Unsupported or malformed encrypted payload");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}
