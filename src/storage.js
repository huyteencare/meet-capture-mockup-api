// Storage abstraction — supports 'supabase', 'gcs'
// Switch provider via STORAGE_PROVIDER env var ('supabase' | 'gcs', default: 'gcs')

import { Storage as GCSStorage } from "@google-cloud/storage";
import { createHash, createHmac } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

const PROVIDER = process.env.STORAGE_PROVIDER || "gcs";

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "meet-captures";

const toSupabasePath = (storageKey) =>
  storageKey.startsWith("captures/") ? storageKey.slice("captures/".length) : storageKey;

const supabaseHeaders = () => ({
  Authorization: `Bearer ${SUPABASE_KEY}`,
  apikey: SUPABASE_KEY,
});

const supabase = {
  async generateUploadUrl(storageKey, _mimeType = "video/webm", _expiresIn = 300) {
    const filePath = toSupabasePath(storageKey);
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/${SUPABASE_BUCKET}/${filePath}`,
      { method: "POST", headers: supabaseHeaders() },
    );
    if (!res.ok) throw new Error(`Supabase presign failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}`, storageKey };
  },

  async generateDownloadUrl(storageKey, expiresIn = 3600) {
    const filePath = toSupabasePath(storageKey);
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${SUPABASE_BUCKET}/${filePath}`,
      {
        method: "POST",
        headers: { ...supabaseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!res.ok) throw new Error(`Supabase sign failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  },

  async uploadFileAndDelete(localPath, storageKey) {
    const filePath = toSupabasePath(storageKey);
    const body = await readFile(localPath);
    const mimeType = localPath.endsWith(".webm")
      ? (localPath.includes("audio") ? "audio/webm" : "video/webm")
      : "application/octet-stream";
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${filePath}`,
      { method: "POST", headers: { ...supabaseHeaders(), "Content-Type": mimeType }, body },
    );
    if (!res.ok) throw new Error(`Supabase upload failed: ${res.status} ${await res.text()}`);
    await rm(localPath);
    return body.length;
  },

  isConfigured() {
    return Boolean(SUPABASE_URL && SUPABASE_KEY);
  },
};

// ---------------------------------------------------------------------------
// Google Cloud Storage
// ---------------------------------------------------------------------------

const GCS_BUCKET = process.env.GCS_BUCKET || "meet-captures";
const GCS_KEY_FILE = process.env.GCS_KEY_FILE || "";
const GCS_HMAC_ACCESS_KEY = process.env.GCS_HMAC_ACCESS_KEY || "";
const GCS_HMAC_SECRET = process.env.GCS_HMAC_SECRET || "";
const GCS_S3_HOST = "storage.googleapis.com";

// HMAC-SHA256 signing (AWS4 format, GCS S3-compatible API) — ~100x faster than RSA
function hmacSignedUrl(bucket, objectKey, mimeType, expiresInSeconds) {
  const now = new Date();
  const datetime = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const date = datetime.slice(0, 8);
  const credential = `${GCS_HMAC_ACCESS_KEY}/${date}/auto/s3/aws4_request`;
  const signedHeaders = "content-type;host";

  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": datetime,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  }).toString();

  const canonicalRequest = [
    "PUT",
    `/${bucket}/${objectKey}`,
    queryParams,
    `content-type:${mimeType}\nhost:${GCS_S3_HOST}\n`,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const hashedCanonical = createHash("sha256").update(canonicalRequest).digest("hex");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    `${date}/auto/s3/aws4_request`,
    hashedCanonical,
  ].join("\n");

  const signingKey = [date, "auto", "s3", "aws4_request"].reduce(
    (key, data) => createHmac("sha256", key).update(data).digest(),
    `AWS4${GCS_HMAC_SECRET}`,
  );

  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `https://${GCS_S3_HOST}/${bucket}/${objectKey}?${queryParams}&X-Amz-Signature=${signature}`;
}

const gcsClient = PROVIDER === "gcs" && GCS_KEY_FILE
  ? new GCSStorage({ keyFilename: GCS_KEY_FILE })
  : null;

const gcs = {
  async generateUploadUrl(storageKey, mimeType = "video/webm", expiresIn = 300) {
    if (GCS_HMAC_ACCESS_KEY && GCS_HMAC_SECRET) {
      return { uploadUrl: hmacSignedUrl(GCS_BUCKET, storageKey, mimeType, expiresIn), storageKey };
    }
    const [url] = await gcsClient.bucket(GCS_BUCKET).file(storageKey).getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + expiresIn * 1000,
      contentType: mimeType,
    });
    return { uploadUrl: url, storageKey };
  },

  async generateDownloadUrl(storageKey, expiresIn = 3600) {
    const [url] = await gcsClient.bucket(GCS_BUCKET).file(storageKey).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresIn * 1000,
    });
    return url;
  },

  async uploadFileAndDelete(localPath, storageKey) {
    const body = await readFile(localPath);
    const mimeType = localPath.endsWith(".webm")
      ? (localPath.includes("audio") ? "audio/webm" : "video/webm")
      : "application/octet-stream";
    await gcsClient.bucket(GCS_BUCKET).file(storageKey).save(body, { contentType: mimeType });
    await rm(localPath);
    return body.length;
  },

  isConfigured() {
    return Boolean(GCS_BUCKET && (GCS_HMAC_ACCESS_KEY || GCS_KEY_FILE));
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const provider = PROVIDER === "supabase" ? supabase : gcs;

export const generateUploadUrl = (storageKey, mimeType, expiresIn) =>
  provider.generateUploadUrl(storageKey, mimeType, expiresIn);

export const generateDownloadUrl = (storageKey, expiresIn) =>
  provider.generateDownloadUrl(storageKey, expiresIn);

export const uploadFileAndDelete = (localPath, storageKey) =>
  provider.uploadFileAndDelete(localPath, storageKey);

export const isConfigured = () => provider.isConfigured();
