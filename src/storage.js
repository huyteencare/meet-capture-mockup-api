// Storage abstraction — supports 'supabase' and 's3'
// Switch provider via STORAGE_PROVIDER env var ('supabase' | 's3', default: 's3')

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile, rm } from "node:fs/promises";

const PROVIDER = process.env.STORAGE_PROVIDER || "s3";

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

const S3_BUCKET = process.env.S3_BUCKET || "teencare-meet-captures";
const s3Client = PROVIDER === "s3"
  ? new S3Client({ region: process.env.AWS_REGION || "ap-southeast-1" })
  : null;

const s3 = {
  async generateUploadUrl(storageKey, mimeType = "video/webm", expiresIn = 300) {
    const url = await getSignedUrl(
      s3Client,
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: storageKey, ContentType: mimeType }),
      { expiresIn },
    );
    return { uploadUrl: url, storageKey };
  },

  async generateDownloadUrl(storageKey, expiresIn = 3600) {
    return getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: S3_BUCKET, Key: storageKey }),
      { expiresIn },
    );
  },

  async uploadFileAndDelete(localPath, storageKey) {
    const body = await readFile(localPath);
    await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: storageKey, Body: body }));
    await rm(localPath);
    return body.length;
  },

  isConfigured() {
    return Boolean(S3_BUCKET);
  },
};

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "meet-captures";

// 'captures/meeting/session/...' → 'meeting/session/...'
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
    // data.url is a relative path — construct full URL
    const uploadUrl = `${SUPABASE_URL}/storage/v1${data.url}`;
    return { uploadUrl, storageKey };
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
      {
        method: "POST",
        headers: { ...supabaseHeaders(), "Content-Type": mimeType },
        body,
      },
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
// Exports
// ---------------------------------------------------------------------------

const provider = PROVIDER === "supabase" ? supabase : s3;

export const generateUploadUrl = (storageKey, mimeType, expiresIn) =>
  provider.generateUploadUrl(storageKey, mimeType, expiresIn);

export const generateDownloadUrl = (storageKey, expiresIn) =>
  provider.generateDownloadUrl(storageKey, expiresIn);

export const uploadFileAndDelete = (localPath, storageKey) =>
  provider.uploadFileAndDelete(localPath, storageKey);

export const isConfigured = () => provider.isConfigured();
