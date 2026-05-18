## Các mức test

| Mức | Số student | Kịch bản |
|-----|------------|----------|
| Functional | 1–2        | capture bình thường, không churn |
| Mapping stability | 2          | join → leave A → tab switch → B vẫn ở |
| Load | 5–10       | tất cả bật camera/mic, chạy 10 phút |
| Stress | 10–20+     | tăng đến khi fail |

## Cách chạy

### Trong lúc test
```bash
# Mở dashboard real-time trong browser
http://18.142.106.202/dashboard
```
Benchmark monitor đã chạy tự động trên EC2 (PM2), không cần làm gì thêm.

### Sau khi mentor test xong

```bash
# 1. Xem chất lượng từng session (mentor nào, student nào, capture đủ không)
node scripts/session-report.js http://18.142.106.202

# 2. Xem sức khỏe server trong suốt kỳ test (CPU, RAM, throughput)
scp -i ~/.ssh/calorielens.pem \
  "ubuntu@18.142.106.202:/home/ubuntu/meet-capture-api/benchmark-*.csv" .

node scripts/benchmark-report.js benchmark-<timestamp>.csv

# 3. Xem lại video/audio từng session (nếu cần)
# Mở viewer.html → nhập server: http://18.142.106.202
```

## Pass/fail cho mỗi mức test

- [ ] UI Meet phía mentor còn dùng được
- [ ] Backend nhận batch ổn định (không tăng error)
- [ ] `mentor-audio` không bị mất
- [ ] `shared-audio` không bị mất
- [ ] `student-video` không bị mất
- [ ] Không sinh participant rác rõ rệt
- [ ] `actualVideoDuration` không đứng yên bất thường khi student vẫn còn trong call

## Bảng kết quả

| Mức | Số student | Thời lượng | Backend ổn | Capture ổn | Mapping ổn | Kết luận |
|-----|------------|------------|------------|------------|------------|----------|
| Functional |            |            |            |            |            |          |
| Mapping stability |            |            |            |            |            |          |
| Load |            |            |            |            |            |          |
| Stress |            |            |            |            |            |          |

## Checklist mapping stability (per student - Optional)

| Student | join | leave | actualVideo | chunks | streams | Verdict |
|---------|------|-------|-------------|--------|---------|---------|
|         |      |       |             |        |         |         |

> `actualVideo` gần bằng thời gian hiện diện → tốt
> `streams` tăng nhưng duration vẫn tăng → chấp nhận được
> `streams` tăng + duration đứng yên → fail mapping


---

## Mentor post-session feedback

* Slides Hướng dẫn cài Extension:
  <https://docs.google.com/presentation/d/1wG_do4ut96jG5XecoWcSAisCGOEkS0YfEDQtinXvL5c/edit?usp=sharing>


* Form để mentor tổng hợp kết quả sau khi session kết thúc: 
  <https://forms.gle/xvg7eZkzzxSs3r2b6>

### Verdict nhanh

* **Pass**: Không lag, không crash, camera/mic học sinh capture đủ
* **Borderline**: Lag nhẹ nhưng capture vẫn có dữ liệu
* **Fail**: Crash tab, lag nặng ảnh hưởng dạy học, hoặc mentor phàn nàn rõ ràng