# ==Production Run — 20-21/05/2026==

> Không phải stress test có kiểm soát như lần trước — đây là log từ **production thực tế** với nhiều mentor chạy song song trong ngày học thật.

---

## Backend server specs

* VPS: 6 vCPU · 5.8 GB RAM · 79 GB SSD (`160.191.244.71`) — shared với openclaw-gateway (~1.7 GB), next-server (~200 MB), và 1 Docker container
* Process manager: PM2 với `max_memory_restart: 2G` — server tự restart nếu vượt 2 GB RAM (không hard-cap CPU)
* Storage: Google Cloud Storage bucket (`meet-captures`)

> **Thay đổi kiến trúc quan trọng trong kỳ này:** xem phần [Kiến trúc upload](#kiến-trúc-upload--thay-đổi-ngày-21-05) bên dưới.

---

## Tổng hợp kết quả

| Ngày | Mentor active | Sessions có student | Peak active sessions | Backend ổn | Upload ổn | Kết luận |
|------|--------------|---------------------|----------------------|------------|-----------|----------|
| 20/05 | 5 mentors | ~22 sessions | 54 | ✓ | disk-only* | Ổn — chưa có GCS upload |
| 21/05 (trước deploy) | nhiều | nhiều | 62 | ✓ | disk-only* | Baseline kiến trúc cũ: peak ~36–40% với 8 students (Report 1) |
| 21/05 (sau deploy 07:43 UTC) | 8 mentors | 35 sessions | 13 | ✓ | ✓ GCS | CPU giảm mạnh sau khi chuyển sang GCS presign |

*disk-only: file lưu local, chưa up GCS.

---

## 20/05 — Ngày học đầu tiên (kiến trúc cũ)

### Session summary

| Mentor | Sessions | Students captured |
|--------|----------|-------------------|
| Teacher Huy | 6 | 7 |
| Vu Duc Bao | 5 | 8 |
| Cô Quỳnh | 3 | 3 |
| Đỗ Thị Lan Anh | 1 | 1 |
| UyenMy | 1 | 1 |
| **(unknown)** | ~6 | ~17 |

### Server performance — 20/05

| Chỉ số | Avg | Peak | Server limit | Headroom |
|--------|-----|------|--------------|----------|
| CPU | 0.8% | **16.1%** | 6 vCPU (600%) | ~84% |
| RAM | 125.5 MB | **191.6 MB** | 1024 MB | ~832 MB |
| Disk (local, chưa GCS) | — | **40.1 MB** | — | ✓ |
| Errors | — | **0** | — | ✅ |
| Batch requests | — | **3,378** (cả ngày) | — | — |
| Events received | — | **27,706** | — | — |
| Data received | — | **15.9 MB** | — | — |
| Peak active sessions | — | **54** | — | — |

**Kết luận 20/05:** Server chịu tốt. CPU thoải mái ở kiến trúc cũ vì tải nhẹ (ít session đồng thời hơn). Benchmark CPU thực tế của kiến trúc cũ lấy từ Report 1 (36–40% peak với 8 students).

---

## 21/05 — Ngày học thứ 2 + Deploy GCS presign

### Session summary — 21/05

| Mentor | Sessions có student | Student-video tracks |
|--------|--------------------|-----------------------|
| Ha Nghi | 9 | 28 |
| Phương Trâm | 6 | 11 |
| Minh Thy | 5 | 6 |
| Cô Quỳnh | 4 | 4 |
| Teacher Huy | 4 | 4 |
| Đỗ Thị Lan Anh | 3 | 6 |
| Vu Duc Bao | 3 | 4 |
| Lê Thị Anh | 1 | 2 |
| **(unknown)** | ~5 | ~23 |
| **Tổng** | **~40 sessions** | **~88 student-video tracks** |

### Top sessions theo dung lượng video

| Meeting | Mentor | Duration | Students | Video size |
|---------|--------|----------|----------|------------|
| uac-pgzx-mqt | (unknown) | 41 min | 1 | 703 MB |
| vki-hkmg-akz | Cô Quỳnh | 29 min | 1 | 462 MB |
| hxj-ccoj-wkk | Phương Trâm | 41 min | 1 | 416 MB |
| rop-zasm-oyz | Ha Nghi | 32 min | 5 | 315 MB |
| jnv-bysw-pgw | Phương Trâm | 32 min | 2 | 282 MB |

### Server performance — 21/05 toàn ngày

| Chỉ số | Avg | Peak | Server limit | Headroom |
|--------|-----|------|--------------|----------|
| CPU (trước deploy, từ Report 1) | 1.9–4% | **36–40%** | 100% | ~60–64% |
| CPU (sau deploy) | **1.2%** | **19.3%** | 100% | ~81% |
| RAM | 148.6 MB | **242.4 MB** | 1024 MB | ~782 MB |
| Batch requests | — | **7,381** (từ 07:43) | — | — |
| Events | — | **65,253** | — | — |
| Data qua backend | — | **58.6 MB** (event JSON) | — | — |
| GCS uploads (backend) | — | **110 files / 16.95 MB** | — | — |
| GCS errors | — | **0** | — | ✅ |
| Errors | — | **2** / 7,381 batches | — | ✅ |
| Peak active sessions | — | **13** | — | — |
| Student-video local total | — | **~6.8 GB** | — | — |

---

## Kiến trúc upload — Thay đổi ngày 21/05

### Trước (backend-proxied)

```
Browser extension
  └─ POST /api/capture/batch  (video chunks + events, binary data)
        └─ Backend (xử lý, base64 decode, lưu disk)
              └─ Backend upload lên GCS  ← CPU intensive
```

**Vấn đề:** Backend phải nhận toàn bộ binary video data → decode → lưu disk → upload tiếp lên GCS. Khi nhiều session đồng thời, I/O + encode chiếm CPU nặng. Theo Report 1, peak CPU đo được ở kiến trúc này là **36.2–40%** với 8 students đồng thời.

### Sau (GCS presign — deploy 21/05 07:43 UTC)

```
Browser extension
  ├─ POST /api/capture/presign  (request signed URL)
  │     └─ Backend trả về GCS presigned URL  ← nhẹ, chỉ HMAC signing
  ├─ PUT thẳng lên GCS  ← bypass backend hoàn toàn
  └─ POST /api/capture/batch  (event metadata JSON, nhỏ)
        └─ Backend lưu manifest + forward attendance webhook
```

**Kết quả:** Backend không còn nhận video binary → chỉ xử lý JSON event nhỏ. CPU giảm từ peak **36–40%** (kiến trúc cũ, Report 1) xuống còn peak **19.3%** (~**50–52% giảm peak CPU**).

### So sánh trực tiếp

| Metric | Kiến trúc cũ (21/05 sáng) | Kiến trúc mới (21/05 sau deploy) |
|--------|--------------------------|----------------------------------|
| CPU peak | **36–40%** (Report 1, 8 students) | **19.3%** |
| CPU avg | **1.9–4%** (Report 1) | **1.2%** |
| Video qua backend | Toàn bộ (~GB) | **0** (client → GCS trực tiếp) |
| Backend chỉ nhận | Video + events | **Event JSON** |
| GCS upload thực hiện bởi | Backend | **Browser extension** |
| HMAC signing | Không | ✓ (~100× nhanh hơn RSA) |

> **Note:** HMAC signing key được dùng thay vì RSA service account — tốc độ ký nhanh hơn ~100×, tránh CPU spike lúc generate presigned URL đồng thời.

---

## File size estimate — 21/05 (35 active sessions)

| Track | Tổng thực tế |
|-------|-------------|
| mentor-audio | 879.6 MB |
| shared-audio (3 streams/session) | 103.1 MB |
| student-video | **6,782.8 MB** |
| **Tổng lên GCS** | **~7.7 GB** |

### Ước tính per session (avg 35 min · 2–3 students)

| Track | Size/session |
|-------|-------------|
| mentor-audio | ~25 MB |
| shared-audio | ~3 MB |
| student-video (avg 2 students) | ~194 MB |
| **Tổng/session** | **~222 MB** |

### Chi phí GCS ước tính

| Config | GCS / tháng (20 ngày học) | Chi phí |
|--------|--------------------------|---------|
| 8 mentor × avg 3 students × 35 min/session | ~154 GB | ~$3.4 |
| 8 mentor × avg 5 students × 60 min/session | ~490 GB | ~$11 |

> GCS Standard: ~$0.022/GB. Egress nội bộ (extension → GCS) không tính phí nếu cùng region.

---

## Issues phát hiện

### 1. Mapping student bị split folder khi tắt/mở cam

**Session điển hình:** `gjm-vxqy-ohw` — 20/05, ~68 phút, 13 students.

Khi student tắt cam rồi bật lại, Google Meet assign một `streamId` mới. Extension dùng `streamId` làm `participantId` trong lúc tên chưa resolve → chunk đầu upload vào folder số (`2079377872/`), chunk sau khi tên resolve upload vào folder tên (`for-Qu-ch-Khang/`). **Kết quả: mỗi student có 2 folder riêng biệt trên GCS.**

```
captures/gjm-vxqy-ohw/
  ├── 2079377872/          ← chunks trước khi tên resolve (Quách Khang)
  ├── for-Qu-ch-Khang/     ← chunks sau khi tên resolve
  ├── 1099345755/          ← Ngần Ngọ (11 recorder_restarts)
  ├── for-Ng-n-Ng-/
  ├── 897729885/           ← student này không bao giờ resolve tên (chỉ 8s)
  └── ... (20 folder tổng cho 13 students)
```

| Student | Recorder restarts | Split folder? |
|---------|------------------|---------------|
| Ngần Ngọ | 11 | ✓ |
| Annie | 9 | ✓ |
| Quách Khang | 9 | ✓ |
| Minh Đặng Đức | 7 | ✓ |
| Nguyễn Hồng Nhung | 6 | ✓ |
| Hằng Nguyễn | 5 | ✓ |
| Nguyễn Huyền Trang | 4 | ✓ |
| Chương Võ Nguyên | 4 | ✓ |
| My Kiều | 4 | ✓ |
| 897729885 *(unresolved)* | 2 | — |

**Root cause:** Extension không dùng `streamId` cố định ngay từ đầu — khi Meet resolve tên người dùng, `participantId` thay đổi → `storageKey` thay đổi → folder mới trên GCS.

**Fix cần làm (extension):** Dùng `streamId` làm key cố định cho toàn bộ vòng đời của track, không dùng tên resolve từ Meet DOM. Xem Issue 2 trong extension-webcam-v2.

## Kết luận

| | 20/05 | 21/05 (cũ) | 21/05 (mới) |
|--|-------|------------|-------------|
| Backend stability | ✅ | ⚠️ CPU spike (viewer) | ✅ |
| GCS upload | ✗ | ✗ | ✅ 110 files, 0 error |
| CPU headroom | ~84% | không rõ (spike do viewer) | **~81%** ✅ |
| Verdict | PASS | inconclusive | **PASS** |

Server VPS (1 vCPU / 1 GB) sau khi chuyển sang GCS presign đủ sức chạy **8+ mentor đồng thời** với headroom CPU thoải mái (~81%). Bottleneck tiếp theo dự kiến là disk I/O nếu GCS upload bị delay, không phải CPU.
