# Infrastructure & Architecture

## Overview

Meet Capture records per-student audio/video from Google Meet sessions. The extension runs in the mentor's Chrome browser and uploads video chunks directly to GCS. Backend is a lightweight Node.js/Express server — its job is to generate HMAC presigned URLs, receive event metadata, and maintain session manifests on disk.

---

## Architecture — Current (Direct GCS Upload)

```
┌─────────────────────────────────────────────────────┐
│  Chrome Extension (Mentor's browser)                │
│                                                     │
│  MediaRecorder → chunks every ~8s                   │
│                                                     │
│  1. POST /api/capture/presign  ──────────────────┐  │
│     { meetingId, sessionId, chunks[] }            │  │
│                                                   │  │
│  3. PUT binary directly ──────────────────────┐  │  │
│     (presigned URL, bypasses backend)         │  │  │
│                                               │  │  │
│  4. POST /api/capture/batch ───────────────┐  │  │  │
│     { storageKey, byteSize, metadata }     │  │  │  │
└────────────────────────────────────────────┼──┼──┘  │
                                             │  │
                                             ▼  ▼
┌──────────────────────┐      ┌──────────────────────┐
│  VPS — Node.js/PM2   │  2.  │  Google Cloud        │
│  160.191.244.71      │◄─────│  Storage             │
│                      │ HMAC │                      │
│  • Generate HMAC     │ sign │  bucket:             │
│    presigned URLs    │      │  meet-captures       │
│  • Save event JSON   │      │                      │
│    metadata to disk  │      │  captures/           │
│  • Session manifests │      │    {meetingId}/      │
│  • Benchmark logging │      │      {sessionId}/    │
│  • GET /api/sessions │      │        participants/ │
│                      │      │        mentor-audio/ │
│  PM2 max_memory: 2G  │      │        shared-audio/ │
└──────────────────────┘      └──────────────────────┘
```

## Fallback

Nếu presign fail hoặc GCS PUT fail, extension tự fallback sang base64 path — không mất data.

```
try {
  presign → PUT to GCS → POST metadata   // direct=true
} catch {
  POST base64 to /api/capture/batch      // direct=false, legacy path
}
```

---

## Server

**Host:** VPS `160.191.244.71`
**OS:** Ubuntu (KVM)
**Specs:** 6 vCPU · 5.8 GB RAM · 79 GB SSD

Shared với các service khác trên cùng VPS:

| Service | RAM usage | Notes |
|---------|-----------|-------|
| openclaw-gateway | ~1.7 GB | service chính, uptime từ tháng 4 |
| next-server | ~200 MB | |
| doisoatdata (Docker) | ~100 MB | Python/FastAPI, port 5000 |
| nginx | nhỏ | reverse proxy |
| **meet-capture-api** | ~130 MB | PM2, port 8787 |

**Process manager:** PM2 với `max_memory_restart: 2G` — tự restart nếu vượt 2 GB RAM. Không có hard CPU cap.

Effective headroom cho meet-capture-api: **~2–2.5 GB RAM**, toàn bộ CPU (shared).

---

## GCS Configuration

**Bucket:** `meet-captures`
**Region:** asia-southeast1 (Singapore)
**Signing:** HMAC key (~100× nhanh hơn RSA service account)

**CORS policy** (cho phép Chrome extension PUT trực tiếp từ meet.google.com):

```json
[{
  "origin": ["https://meet.google.com"],
  "method": ["PUT"],
  "responseHeader": ["Content-Type", "Content-Length"],
  "maxAgeSeconds": 3600
}]
```

### GCS folder structure

```
captures/
  {meetingId}/
    {sessionId}/
      participants/
        {streamId}/            ← dùng streamId, không dùng tên (tránh split folder)
          video/
            chunk-{index}-{timestamp}.webm
      mentor-audio/
        chunk-{index}-{timestamp}.webm
      shared-audio/
        {streamId}/
          chunk-{index}-{timestamp}.webm
      manifest.json
```

> **Known issue:** Extension hiện vẫn dùng `participantId` (tên resolve từ Meet DOM) thay vì `streamId` cố định → cùng 1 student có thể tạo 2 folder (1 số + 1 tên) khi tắt/mở cam. Fix cần ở extension repo.

---

## Cost Estimate

**Assumptions:** 8 mentor × avg 3 sessions/ngày × 20 ngày/tháng = ~480 sessions/tháng. Avg 35 phút, 2–3 students/session.

### GCS Storage

| Track | Size/session | 480 sessions/tháng |
|-------|-------------|-------------------|
| mentor-audio | ~25 MB | ~12 GB |
| shared-audio | ~3 MB | ~1.5 GB |
| student-video (avg 2 students) | ~194 MB | ~93 GB |
| **Tổng** | **~222 MB** | **~107 GB** |

| Item | Calculation | Cost/tháng |
|------|-------------|------------|
| Storage | 107 GB × $0.022 | ~$2.4 |
| PUT requests | 480 × ~500 chunks × $0.005/10K | ~$0.12 |
| **GCS total** | | **~$2.5** |

### VPS

VPS dùng chung với các service khác — chi phí meet-capture-api không tính riêng.

---

## Scaling Thresholds

| Sessions/ngày | Concurrent peak | Recommendation |
|---------------|-----------------|----------------|
| ≤ 50 | ~10–15 | VPS hiện tại ổn |
| 50–150 | ~30–40 | Tăng RAM VPS hoặc tách riêng process |
| 150+ | 50+ | Dedicated VPS hoặc horizontal scaling |

Bottleneck dự kiến tiếp theo: **disk I/O** nếu GCS upload bị delay và file queue lên (không phải CPU — đã giải quyết qua direct upload).
