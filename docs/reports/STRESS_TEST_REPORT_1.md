# ==Stress test meeting lần 1 (id: arf-fwzg-vat) · 2026-05-15==


## Backend server specs:

* AWS EC2: t3.small (2vpcu - 2gb ram - 16gb storage)
* AWS S3 bucket 

## Bảng kết quả để report stress test 

| Mức | Số student | Thời lượng | Backend ổn | Capture ổn | Mapping ổn | Kết luận |
|-----|------------|------------|------------|------------|------------|----------|
| độ ổn định | 2          | 5 phút     | x          | x          | chưa ổn    | Độ ổn định của extension cần phải improve<br><br>Khi student join → out ra→ join lại, khó để map lại đúng học sinh đó |
| Stress (lần 1) | 8          | 15 phút    | x          | x          | x          | OK6 máy mở cam, 2 máy tắt cam  |
| Stress (lần 2) | 8          | 23 phút    | x          | x          | tạm ổn     | OK - 8 máy mở cam - share screen + tắt mở mic/cam |


## Chart Summary:

Cách xem chart: Start Live server file HTML (có thể dùng vscode live server extension) → Drag and drop file csv vào

 

[benchmark-2026-05-15T02-45-50.csv 6652](/api/attachments.redirect?id=615a7adb-cf20-4894-a896-e0ce3603c47f)

[benchmark-viewer.html 9546](/api/attachments.redirect?id=0f6171e3-873d-409b-ab64-291f99640922)



 ![](/api/attachments.redirect?id=7fc123be-ec8a-4400-a473-0b1345cb141f " =3817x1523")


 ![](/api/attachments.redirect?id=339b1aff-8b95-47e8-9557-93dd141a6767 " =3839x2073")


## Session info

|     |     |
|-----|-----|
| Meeting ID | arf-fwzg-vat |
| Mentor | Teacher Test |
| Duration | **15m 44s** (03:19 → 03:35 UTC) |
| Participants | 8 total — 6 bật cam, 2 tắt cam |
| Students captured | 5 (mentor không count) |
| Verdict | **PASS** |


---

## Server performance

| Chỉ số | Avg | Peak | Server limit | Headroom |
|--------|-----|------|--------------|----------|
| CPU    | 1.9% | **36.2%** | 2 vCPU (200%) | \~164%   |
| RAM    | 130 MB | **223 MB** | 2048 MB      | \~1825 MB |
| Disk (local) | —   | 3.93 MB | —            | S3 upload ổn |
| Errors | —   | **0** | —            | ✅        |

### Headroom

EC2 hiện tại (`t3.small` / 2 vCPU · 2 GB RAM) với 8 người (6 cam):

* **CPU còn \~64% headroom** — peak 36% chỉ xuất hiện ngắn khi nhiều batch đến đồng thời. Ước tính có thể chịu thêm \~2–3x tải trước khi CPU trở thành bottleneck.
* **RAM còn \~87% headroom** — 223 MB peak trên 2 GB. Rất thoải mái.
* **Kết luận:** Server hiện tại đủ sức chạy **5 mentor đồng thời (mỗi mentor 5–6 student)** mà không cần nâng cấp.


---

## Tổng File size ( · 1 mentor - 5 students - 2 student without camera)

| Track | Size |
|-------|------|
| mentor-audio | 6.4 MB |
| shared-audio (3 streams) | 32.8 MB |
| student-video (5 students) | 245.6 MB |
| **Total upload lên S3** | **\~285 MB** |

### Per student video (variance cao do camera quality khác nhau)

| Student | Size (15m) | Ước tính / giờ |
|---------|------------|----------------|
| Quốc Khánh (HD) | 86 MB      | \~330 MB/hr    |
| VuHao (HD) | 69 MB      | \~265 MB/hr    |
| Duc Huy (HD) | 59 MB      | \~225 MB/hr    |
| Another Account (SD) | 16 MB      | \~60 MB/hr     |
| Hao Nguyen (SD) | 16 MB      | \~60 MB/hr     |
| **Trung bình** | **49 MB**  | **\~190 MB/hr** |

> Variance lớn (16–86 MB) do camera resolution khác nhau (HD vs SD) và số lần recorder restart.


---

## Estimate trong 1 giờ meeting · 5 students

| Track | Ước tính |
|-------|----------|
| mentor-audio | \~25 MB  |
| shared-audio | \~125 MB |
| student-video (5 students) | \~937 MB |
| **Tổng upload S3** | **\~1.1 GB / meeting** |


> Ước tính trên dựa trên config test: **1 mentor + 5 students bật cam** (8 người tổng, 2 tắt cam).

| Config | S3 / giờ | Chi phí / giờ |
|--------|----------|---------------|
| 5 mentor × 5 students bật cam | \~5.5 GB | \~$0.13       |
| 5 mentor × 8 students bật cam | \~8.2 GB | \~$0.19       |
>
> 
> S3 Standard: \~$0.023/GB.


---



# ==Stress test meeting lần 2 (id: izz-kdhh-ddt) · 2026-05-15==

## Backend server specs:

* AWS EC2: t3.small (2vCPU - 2GB RAM - 16GB storage)
* AWS S3 bucket

## Bảng kết quả stress test

| Mức | Số student | Thời lượng | Backend ổn | Capture ổn | Mapping ổn | Kết luận |
|-----|------------|------------|------------|------------|------------|----------|
| Stress cao | 8          | 24m 50s    | ✓          | ✓          | Chưa ổn    | Backend và capture đều tốt. Mapping bị lỗi do Google Meet inject UI string làm tên participant (xem bên dưới) |


---

## Session info

|     |     |
|-----|-----|
| Meeting ID | izz-kdhh-ddt |
| Mentor | Teacher Test |
| Duration | **24m 50s** (06:27 → 06:52 UTC) |
| Participants | 8 students bật cam |
| Verdict | **PASS** (backend + capture) / **cần fix** (mapping) |


---

## Server performance

| Chỉ số | Avg | Peak | Server limit | Headroom |
|--------|-----|------|--------------|----------|
| CPU    | 4%  | **40%** | 2 vCPU (200%) | \~160%   |
| RAM    | 170 MB | **224 MB** | 2048 MB      | \~1824 MB |
| Disk (local) | —   | \~4 MB | —            | S3 upload ổn |
| Errors | —   | **0** | —            | ✅        |

**Kết luận:** Server t3.small chịu tốt 8 student bật cam đồng thời, không cần nâng cấp.


---

## Mapping issue — "You can't remotely this participant"

**Vấn đề:** Google Meet hiển thị chuỗi `"You can't remotely this participant"` trên tile của student khi đang có presentation. Extension đọc chuỗi này từ DOM và dùng làm `participantId` → chunks của **6 student khác nhau** bị gộp chung vào 1 track giả, làm coverage báo sai (ví dụ: Nguyen Pham chỉ hiện 10% thay vì 94%).

**Đã fix (post-processing):**

* `export-video.js`: group by `streamId` thay vì `participantId` → recover đúng video từng student từ session cũ
* Xuất lại Nguyen Pham: **16m 38s** (trước đó báo 1m 54s)

**Đã fix (extension — cần reload):**

* `hook.js`: filter `"You can't remotely..."` trong `cleanName` → các session sau không còn bị lỗi này

**Còn cần hoàn thiện:**

* `session-report.js` vẫn group by `participantId` → coverage report vẫn sai nếu session cũ bị ảnh hưởng. Cần update sang group by `streamId` như `export-video.js`
* Extension cần được **reload trong Chrome** để hook.js mới có hiệu lực


---

## File size (24m 50s · 8 students)

| Track | Size |
|-------|------|
| mentor-audio | 2.6 MB |
| shared-audio (3 streams) | 42.3 MB |
| student-video (8 students) | 824.6 MB |
| **Total upload S3** | **\~870 MB** |

Ước tính 1 giờ · 8 students: **\~2.1 GB / meeting**


 ![](/api/attachments.redirect?id=3f5ff83e-f03a-4633-9b00-86e51e9a4f9c " =3834x1808")


 ![](/api/attachments.redirect?id=3861603d-a54a-405f-bb8f-bb3f991ee23f " =943.3333333333334x581.3333333333334")



## Một số file report khác:

[session-report.txt 5556](/api/attachments.redirect?id=99babdec-6052-4940-bfcd-2f6239f23522)


# Automation Test ( Không khả thi ):

Dùng Playwright/Pupeteer tạo nhiều acc guest join → bị Google detect là Bot


 ![](/api/attachments.redirect?id=465e430f-ec4d-480b-b432-060a7fa81199 " =1317x1024")



## Một vài file report khác:


[session-report.txt 3966](/api/attachments.redirect?id=f0b26f49-ffba-4516-bcab-c3cdd75d5027)

[session-manifest.json 3192](/api/attachments.redirect?id=0b260c34-a594-423f-a1ef-13e8693db959)

[session-breakdown.csv 1018](/api/attachments.redirect?id=1dc0d158-0ce8-4dce-8b60-fb672a8378fe)


