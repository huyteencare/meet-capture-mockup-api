# Benchmark framework — Meet Capture v2

## Các mức test

| Mức | Số student | Kịch bản |
|---|---|---|
| Functional | 1–2 | capture bình thường, không churn |
| Mapping stability | 2 | join → leave A → tab switch → B vẫn ở |
| Load | 5–10 | tất cả bật camera/mic, chạy 10 phút |
| Stress | 10–20+ | tăng đến khi fail |

## Cách chạy

```bash
# 1. Mở dashboard trong browser khi đang test
http://18.142.106.202/dashboard

# 2. Sau test: tải CSV từ EC2 và xuất report
scp -i ~/.ssh/calorielens.pem \
  ubuntu@18.142.106.202:/home/ubuntu/meet-capture-api/benchmark-*.csv .

node scripts/benchmark-report.js benchmark-<timestamp>.csv

# 3. Report chất lượng session (coming soon)
node scripts/session-report.js http://18.142.106.202 <sessionId>
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
|---|---|---|---|---|---|---|
| Functional | | | | | | |
| Mapping stability | | | | | | |
| Load | | | | | | |
| Stress | | | | | | |

## Checklist mapping stability (per student)

| Student | join | leave | actualVideo | chunks | streams | Verdict |
|---|---|---|---|---|---|---|
| | | | | | | |

> `actualVideo` gần bằng thời gian hiện diện → tốt  
> `streams` tăng nhưng duration vẫn tăng → chấp nhận được  
> `streams` tăng + duration đứng yên → fail mapping
