# Capture Architecture — Meet Capture v2

## Postprocess và cách tách dữ liệu sau khi record

Sau khi capture xong, dữ liệu đã được tách theo hướng phục vụ review và hậu xử lý tiếp:

| Track | Nguồn | Mô tả |
|---|---|---|
| **Mentor Audio** | `trackSource = local` | Audio local của mentor, lấy từ local sender/local track |
| **Student Audio** | `trackSource = remote` | Audio remote mà mentor nhận được từ học sinh (shared mix) |
| **Student Video** | `trackSource = remote`, `kind = video` | Recording từ remote video track của từng học sinh |

## Điểm cần chốt rõ

Mục tiêu chính của postprocess hiện tại là **tách audio mentor ra khỏi audio học sinh**, và **tách video cam remote của học sinh ra khỏi màn hình Meet tổng**.

PoC hiện tại **không** đi theo hướng record cả màn hình Meet rồi mới crop/tách bằng xử lý hình ảnh.

Việc tách được thực hiện ngay từ **layer media/track**:
- `trackSource = local` → mentor
- `trackSource = remote` → học sinh

Nhờ đó, kết quả export/viewer hiện tại đã cho phép inspect riêng:
- ✅ Audio mentor
- ✅ Audio học sinh (shared)
- ✅ Video cam học sinh (per participant)

## Format lưu trữ

Dữ liệu capture được lưu dưới dạng **WebM chunks** (output của `MediaRecorder` trong Chrome). Đây là format duy nhất browser hỗ trợ ghi trực tiếp — không thể capture thẳng ra `.mp4` hay `.mp3` từ browser.

Mỗi chunk được upload lên S3 ngay sau khi ghi, file local bị xoá để tránh đầy disk EC2.

Cấu trúc trên S3:
```
captures/
  {meetingId}/
    {sessionId}/
      mentor-audio/       ← WebM chunks, trackSource=local
      shared-audio/       ← WebM chunks, trackSource=remote, kind=audio
      participants/
        {participantId}/
          video/          ← WebM chunks, trackSource=remote, kind=video
      manifest.json
      session-breakdown.csv
```

## Hạn chế hiện tại

- Việc gắn chính xác remote media với **từng học sinh cụ thể** vẫn chưa đảm bảo tuyệt đối trong mọi layout của Google Meet (stream replacement, tab switch).
- `Student Audio` là **shared mix** — toàn bộ audio học sinh được mix chung, chưa tách được per-student.
- Nếu cần file playable (`.webm` đơn hoặc `.mp4`), cần thêm bước post-process chạy `ffmpeg` để concat các chunks lại sau khi session kết thúc.
