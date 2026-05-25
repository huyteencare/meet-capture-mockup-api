# Export Audio Guide

Export audio từ meeting session ra file `.mp3` để chia sẻ.

## Yêu cầu

- Node.js ≥ 20 — không cần `npm install` gì thêm
- ffmpeg (`brew install ffmpeg` trên Mac / `apt install ffmpeg` trên Linux)
- Được cấp quyền truy cập server (hỏi admin nếu chưa có)
- *(chỉ khi dùng `--transcribe`)* `OPENAI_API_KEY` — set trước khi chạy:
  ```bash
  export OPENAI_API_KEY=sk-...
  ```

## Cách dùng

### Bước 1 — Lấy meeting ID

Meeting ID là đoạn mã ngắn trong URL Google Meet, ví dụ `awb-eqbz-odz`.  
Hoặc xem trong GCS bucket — tên folder cấp đầu tiên trong `captures/`.

### Bước 2 — Xem danh sách audio tracks

```bash
node scripts/export-audio.js <meetingId>
```

Ví dụ:

```
$ node scripts/export-audio.js awb-eqbz-odz

Meeting:  awb-eqbz-odz
Mentor:   Vu Duc Bao
Started:  21:04:19 21/5/2026 (VN time)

Audio tracks:

  [1]  shared-audio (6666)       5 chunks   0:13  ~0.2 MB
  [2]  shared-audio (6667)       5 chunks   0:13  ~0.0 MB
  [3]  shared-audio (6668)       5 chunks   0:13  ~0.0 MB
  [4]  mentor-audio              1248 chunks  63:06  ~29.6 MB
```

> **shared-audio** là 3 luồng audio chung của Google Meet (thường ngắn, ít dùng).  
> **mentor-audio** là toàn bộ audio của mentor — đây thường là track cần export.

### Bước 3 — Export

```bash
node scripts/export-audio.js <meetingId> --track <số>
```

Ví dụ export mentor audio:

```bash
node scripts/export-audio.js awb-eqbz-odz --track 4
```

Output file tự đặt tên theo format: `{meetingId}_{ngày}_{mentor}_{track}.mp3`  
Ví dụ: `awb-eqbz-odz_2026-05-21_Vu-Duc-Bao_mentor-audio.mp3`

Muốn đặt tên khác:

```bash
node scripts/export-audio.js awb-eqbz-odz --track 4 --out buoi-hoc-21-5.mp3
```

---

## Nếu meeting có nhiều session

Một số meeting có thể bị ngắt kết nối rồi join lại → nhiều session. Script sẽ hỏi:

```
Found 2 sessions for awb-eqbz-odz:

  [1]  20:00:00 → 20:15:00  mentor: Vu Duc Bao
  [2]  20:18:00 → 21:30:00  mentor: Vu Duc Bao

Re-run with --session <number> to pick one.
```

Chọn session rồi export:

```bash
node scripts/export-audio.js awb-eqbz-odz --session 2 --track 4
```

---

## Export đoạn ngắn cho Voice Clone

Voice clone cần 1 đoạn audio **6–15 giây** sạch (không tiếng ồn, không ngắt quãng). Có 2 cách:

### Cách 1 — Tự chia thành clip 13s (dễ nhất)

```bash
node scripts/export-audio.js awb-eqbz-odz --track 4 --split
```

Script tự chia file full thành từng clip ~13s, lưu vào folder:

```
awb-eqbz-odz_2026-05-21_Vu-Duc-Bao_mentor-audio_clips/
  clip-000.mp3   (0:00)   84 kB
  clip-001.mp3   (0:13)   84 kB
  clip-002.mp3   (0:26)   88 kB
  ...
```

Nghe qua, tìm clip mentor nói rõ → dùng trực tiếp file đó cho voice clone.

Muốn clip dài hơn (VD 10s):
```bash
node scripts/export-audio.js awb-eqbz-odz --track 4 --split 10
```

### Cách 2 — Chỉ định timestamp chính xác

Export full audio trước, mở bằng media player tìm đoạn rõ, ghi timestamp rồi cắt:

```bash
node scripts/export-audio.js awb-eqbz-odz --track 4 --clip 2:00-2:15
```

Output: `awb-eqbz-odz_2026-05-21_Vu-Duc-Bao_mentor-audio_clip-2:00-2:15.mp3`

Format: `phút:giây-phút:giây` hoặc `giây-giây`

---

## Đổi server

Mặc định script kết nối tới production server. Để dùng server khác:

```bash
MEET_SERVER=http://localhost:8787 node scripts/export-audio.js awb-eqbz-odz
```
