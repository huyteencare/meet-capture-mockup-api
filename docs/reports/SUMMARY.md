mentor-side capture là phương án khả thi:


1. **Capture hoạt động tốt về mặt kỹ thuật** — tất cả stream được ghi
2. Đã test 1 server backend mockup trên AWS —  t3.small (2 vCPU · 2 GB RAM) đủ **chạy ít nhất 5 mentor × 8 student** **đồng thời.**

   
   1. CPU peak \~20%, RAM peak 224 MB, 0 errors. 
   2. Chi phí estimate: EC2 \~$15/tháng (flat) + S3 \~$0.50/giờ recording (storage + upload requests).


**Estimate cost breakdown — production scale: 250 sessions/ngày (1:1 only)**

250 sessions/ngày × 20 ngày = **5,000 sessions/tháng**

Mỗi session 1 tiếng, 3 streams (student-video, shared-audio, mentor-audio):

| Khoản | Tính | Chi phí |
|-------|------|---------|
| GCS PUT requests | 8,825,000 × $0.05/10,000 | \~$44/tháng |
| GCS storage (Standard, asia-southeast1, 30-day lifecycle) | 5,000 × 0.215 GB = **1,075 GB** × $0.020 | \~$21.5/tháng |
| **GCS tổng** | | **\~$65.5/tháng** |
| VPS H2Cloud Platinum VIP 6-6-80 | 980,000đ/năm ÷ 12 (limit 2 vCPU · 2 GB RAM) | **\~$3.3/tháng** |
| **Tổng** | | **\~$69/tháng (~1.7M VND)** |

**VPS có đủ tải không?**
- Peak concurrent: ~30 session đồng thời (nếu spread đều 8 tiếng)
- Backend chỉ xử lý JSON metadata nhỏ — binary đi thẳng từ extension lên GCS
- Test thực tế: processingMs 6–22ms/batch → 2 vCPU thừa sức xử lý
- Nếu cần scale: bỏ limit lên 6 vCPU · 6 GB RAM (VPS đã có sẵn)

> GCS tự xóa data sau 30 ngày qua lifecycle rule. Chi phí storage là steady-state (1 tháng rolling).



3. **Hạn chế lớn nhất là mapping** — Google Meet thay đổi display name giữa chừng (VD: "You can't remotely this participant") khiến chunk của nhiều student bị gộp nhầm vào 1 track; đã fix ở extension và export script, nhưng về sau vẫn cần theo dõi và improve extension vì dù sao đây cũng không phải API chính thức của google.
4. **Post-processing improve được** — dù mapping bị sai tên trong quá trình record, data video thực tế vẫn đầy đủ trên S3. Có thể recover video đúng của từng student bằng cách group theo stream ID (ID kỹ thuật ổn định) thay vì tên hiển thị. Đã test thực tế: Record ban đầu chỉ hiện 1:54 video do mapping sai, sau khi fix script export ra đúng 16:38 đầy đủ.



