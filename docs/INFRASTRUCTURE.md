# Infrastructure & Architecture

## Overview

Meet Capture records per-student audio/video from Google Meet sessions. The extension runs in the mentor's Chrome browser and streams binary chunks to storage. Backend is a lightweight Node.js/Express server on EC2 — its only job after the direct-S3 migration is to handle metadata and generate pre-signed URLs.

---

## Architecture — Current (Direct S3 Upload)

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
│     (pre-signed URL, no backend involved)     │  │  │
│                                               │  │  │
│  4. POST /api/capture/batch ───────────────┐  │  │  │
│     { s3Key, byteSize, metadata }          │  │  │  │
└────────────────────────────────────────────┼──┼──┘  │
                                             │  │     │
                                             ▼  ▼     │
┌──────────────────────┐      ┌──────────────────────┐
│  EC2 — Node.js/PM2   │  2.  │  Amazon S3           │
│                      │◄─────│                      │
│  • Generate pre-     │  pre-│  teencare-meet-      │
│    signed PUT URLs   │  sign│  captures            │
│  • Save event JSON   │      │                      │
│    metadata to disk  │      │  captures/           │
│  • Session manifests │      │    {meetingId}/      │
│  • Benchmark logging │      │      {sessionId}/    │
│  • GET /api/sessions │      │        participants/ │
│                      │      │        mentor-audio/ │
│  t3.small            │      │        shared-audio/ │
│  ap-southeast-1      │      │                      │
└──────────────────────┘      │  Lifecycle: 30 days  │
                              └──────────────────────┘
```

## Fallback

If presign fails or any S3 PUT fails, the extension automatically falls back to the legacy base64 path — no data loss.

```
try {
  presign → PUT to S3 → POST metadata   // direct=true
} catch {
  POST base64 to /api/capture/batch     // direct=false, legacy path
}
```

---

## AWS Configuration

### S3 Bucket — `teencare-meet-captures`

**Region:** ap-southeast-1 (Singapore)

**CORS policy** (allows Chrome extension to PUT directly from meet.google.com):

```json
[{
  "AllowedHeaders": ["Content-Type", "Content-Length"],
  "AllowedMethods": ["PUT"],
  "AllowedOrigins": ["https://meet.google.com"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

**Lifecycle rule** — auto-delete after 30 days:

```json
{
  "Rules": [{
    "ID": "auto-delete-captures",
    "Filter": { "Prefix": "captures/" },
    "Status": "Enabled",
    "Expiration": { "Days": 30 }
  }]
}
```

To change retention period:
```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket teencare-meet-captures \
  --lifecycle-configuration '{"Rules":[{"ID":"auto-delete-captures","Filter":{"Prefix":"captures/"},"Status":"Enabled","Expiration":{"Days":60}}]}'
```

### S3 Key Structure

```
captures/
  {meetingId}/
    {sessionId}/
      participants/
        {participantName}/
          video/
            chunk-{index}-{timestamp}-{streamId}-{seq}.webm
      mentor-audio/
        chunk-{index}-{timestamp}-{streamId}-{seq}.webm
      shared-audio/
        {streamId}/
          chunk-{index}-{timestamp}-{streamId}-{seq}.webm
      manifest.json
```

---

## Cost Estimate

**Assumptions:** 250 sessions/day × 30 days = 7,500 sessions/month. Session duration ~1 hour. Direct S3 upload (binary never touches EC2). 30-day lifecycle on `captures/`.

### S3 — 1:1 class (1 student per session, no shared-audio)

Each session: ~0.26 GB storage, ~900 S3 PUTs (2 streams × 450 batch cycles/hr).

| Item | Calculation | Cost/month |
|---|---|---|
| Storage | 7,500 sessions × 0.26 GB = 1,950 GB × $0.023 | ~$45 |
| PUT requests | 7,500 × 900 = 6.75M × $0.005/1K | ~$34 |
| GET requests (review) | ~10% access | ~$1 |
| **S3 total** | | **~$80** |

### EC2

EC2 cost is the same regardless of session type — backend only handles small JSON after direct-S3 migration.

| Instance | On-demand | 1-yr reserved |
|---|---|---|
| t3.small (current) | ~$15/mo | ~$9/mo |
| t3.micro (viable after direct-S3) | ~$7.50/mo | ~$4.50/mo |

### Total — 250 sessions/day

| Config | S3 | EC2 | Monthly total |
|---|---|---|---|
| 250 1:1 sessions (1 student) | ~$80 | ~$15 | **~$95** |

---

## Why Not Serverless (Lambda)

Serverless (Lambda + API Gateway + DynamoDB) would cost ~$8/mo in compute but requires a full rewrite:

| Issue | Current | Lambda needs |
|---|---|---|
| Session state | in-memory Map | DynamoDB |
| Event files | local disk JSON | DynamoDB or S3 |
| Benchmark CSV | `setInterval` write | CloudWatch / separate Lambda |
| Session listing | fs scan | DynamoDB query |

Savings vs EC2 t3.small: ~$7/mo. Not worth the migration effort at current scale.

**Revisit at:** 1000+ sessions/day where EC2 needs vertical scaling ($60–120/mo range) while Lambda cost stays flat.

---

## Scaling Thresholds

| Sessions/day | Concurrent peak | Recommendation |
|---|---|---|
| ≤ 250 | ~31 | t3.small or t3.micro, direct S3 |
| 250–500 | ~63 | t3.medium, consider reserved |
| 500–1000 | ~125 | t3.large or horizontal scaling |
| 1000+ | 125+ | Evaluate serverless migration |
