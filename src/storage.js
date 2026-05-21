// Storage abstraction — supports 'supabase', 'gcs'
// Switch provider via STORAGE_PROVIDER env var ('supabase' | 'gcs', default: 'gcs')

import { Storage as GCSStorage } from "@google-cloud/storage";
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

const gcsClient = PROVIDER === "gcs"
  ? new GCSStorage({ keyFilename: GCS_KEY_FILE })
  : null;

const gcs = {
  async generateUploadUrl(storageKey, mimeType = "video/webm", expiresIn = 300) {
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
    return Boolean(GCS_BUCKET && GCS_KEY_FILE);
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
