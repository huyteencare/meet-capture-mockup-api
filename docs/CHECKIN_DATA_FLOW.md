# Check-in Data Flow & Table Relationships

> Cập nhật: 2026-06-06

---

## Tổng quan

Hệ thống check-in dùng Chrome Extension (Meet Capture) để phát hiện học sinh/mentor vào Google Meet, tra cứu session tương ứng trong LMS, rồi ghi điểm danh vào database.

---

## Các bảng liên quan

### `extension_handle_mappings`
Bridge giữa Google identity và LMS identity.

| Field | Mô tả |
|---|---|
| `google_handle` | Google Meet user ID (`users/xxxxx`), PK |
| `student_email` | Email trong LMS (học sinh hoặc mentor) |
| `display_name` | Tên hiển thị |
| `role` | `student` hoặc `mentor` |
| `linked_by` | Email của mentor đã link |

---

### `sessions` — Mentor 1:1
Lịch buổi học 1:1 giữa mentor và học sinh.

| Field | Mô tả |
|---|---|
| `id` | PK |
| `meeting_url` | URL Google Meet, dùng để match meetCode |
| `type` | `mentor_1_1` |
| `scheduled_start` / `scheduled_end` | Khung giờ buổi học |
| `status` | `scheduled` → `in_progress` → `completed` |
| `deleted_at` | Soft delete |

---

### `meet_attendance` — Điểm danh Mentor 1:1
Ghi nhận từng lượt tham gia buổi 1:1.

| Field | Mô tả |
|---|---|
| `session_id` | FK → `sessions.id` |
| `participant_email` | Email học sinh hoặc mentor |
| `participant_type` | `student` hoặc `mentor` |
| `join_time` / `leave_time` | Thời điểm vào/ra |
| `duration_seconds` | Thời lượng tham gia |
| `meet_log_id` | `null` = ghi từ extension, non-null = từ Google Meet log API |

---

### `kns_class_sessions` — Session KNS / Life Skill
Lịch buổi học nhóm KNS (Life Skill).

| Field | Mô tả |
|---|---|
| `id` | PK |
| `class_name` | Tên lớp, ví dụ `TEST.KNS.UI.20260603.A1` |
| `meeting_url` | URL Google Meet, dùng để match meetCode |
| `session_date` | Ngày buổi học |
| `start_at` / `end_at` | Khung giờ (timestamp, UTC) — **timetable Admin filter theo `start_at`** |

---

### `kns_attendance_manual` — Điểm danh KNS (source of truth)
**Bảng chính** Admin dashboard đọc để hiển thị trạng thái điểm danh KNS.

| Field | Mô tả |
|---|---|
| `session_id` | FK → `kns_class_sessions.id` |
| `student_email` | Email học sinh |
| `attendance` | `'Attendance'` = có mặt |
| `source` | `extension` / `mentor_manual` / `kns_report` |
| `marked_at` | Thời điểm điểm danh |

---

### `kns_classin` — Classin legacy (sync target tạm thời)
Bảng cũ của hệ thống Classin. Extension đang sync sang đây để maintain compatibility.
**Dự kiến bỏ khi hoàn toàn chuyển sang Google Meet flow.**

| Field | Mô tả |
|---|---|
| `class_name` | Tên lớp (match với `kns_class_sessions.class_name`) |
| `student_email` | Email học sinh |
| `start_time` | Giờ bắt đầu (match trong window ±90 phút) |
| `attendance` | `'Attendance'` khi đã sync |

---

## Flow check-in

```
Participant vào Google Meet
        │
        ▼
Extension phát hiện (stream ID → google_handle)
        │
        ▼
extension_handle_mappings
  google_handle → student_email + role
        │
        ├── role=mentor
        │     ├── sessions match (mentor_1_1)
        │     │     ├── meet_attendance: INSERT
        │     │     └── sessions.status → 'completed'
        │     │
        │     └── kns_class_sessions match
        │           └── ok:true (acknowledge, không ghi record)
        │
        └── role=student
              ├── sessions match (mentor_1_1)
              │     └── meet_attendance: INSERT
              │
              └── kns_class_sessions match
                    ├── kns_attendance_manual: INSERT (source='extension')
                    └── kns_classin: UPDATE attendance (legacy sync)
```

---

## Source of truth — Admin dashboard

| Session type | Bảng ghi điểm danh | Điều kiện "Có mặt" |
|---|---|---|
| Mentor 1:1 | `meet_attendance` | Record tồn tại với `session_id + participant_email` |
| KNS / Life Skill | `kns_attendance_manual` | `attendance = 'Attendance'` |
| KNS (legacy) | `kns_classin` | `attendance = 'Attendance'` (synced từ extension) |

---

## Logic match session

Extension gửi `meetCode` (phần cuối URL Meet, ví dụ `hpv-ndvx-csz`). Backend tìm session bằng:

```
meeting_url LIKE '%hpv-ndvx-csz%'
```

Session được chấp nhận nếu thoả **một trong hai**:
- `observedAt` nằm trong `[start_at, end_at]` (đang diễn ra), **hoặc**
- Khoảng cách từ `start_at` đến `observedAt` ≤ **12 giờ** (gần nhất)

Session bị loại nếu:
- `deleted_at` không null
- `status` là `completed` / `cancelled`
- Cách `start_at` hơn 12 giờ

---

## Known debt / TODO

| # | Vấn đề | Mức độ |
|---|---|---|
| 1 | `kns_classin` là sync target tạm — match theo `class_name + start_time ±90 phút`, dễ miss nếu tên class hoặc giờ lệch | Medium |
| 2 | Mentor check-in KNS chỉ trả `ok:true`, không ghi record nào vào DB | Low |
| 3 | `meet_attendance.meet_log_id = null` với record từ extension — chưa gắn Google Meet log | Low |
| 4 | Chưa có bảng riêng cho attendance của mentor trong KNS sessions | Low |
