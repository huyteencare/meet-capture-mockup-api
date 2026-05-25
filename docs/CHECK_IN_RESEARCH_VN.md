## Problem: 

tự động điểm danh khi Student join meeting, bằng cách **sử dụng email** của student.


## Goal:

* tự động lấy được email của student 


* persist email qua các meeting khác để không bị mất


## Các hướng giải quyết:


1. ### Scrape People panel / hover card (failed)

* Đã test thực tế rồi: tile DOM và People panel đều không lộ email usable, chỉ ra display name + UI text + spaces/.../devices/....
* Nên về mặt thực tế, hướng này hiện đang fail.



2. ### **Official Google Meet API (researching)**

**cơ chế:** 

* extension gửi lên backend thông tin join như meetingId, displayName, joinObservedAt


* backend dùng Google Meet API để tìm đúng participant và participantSession của người đó
* nếu Meet trả về **signedinUser.user**, backend mới dùng identifier đó để thử **suy ra email** ở bước sau


**cần có:**

* Service account JSON - để backend authenticate tới Google Meet API


* Google Workspace domain-wide delegation
  * admin Workspace phải cấp quyền cho service account đó dùng scope đọc Meet
* Một Google Workspace user để impersonate



**Điểm quan trọng cho case** **này**:

* để dùng hướng delegated Workspace auth, team cần Google Workspace domain
* tức là không phải Gmail thường @gmail.com
* và thường sẽ phát sinh phí nếu công ty chưa có Workspace



3. ### **Nhập email bằng tay**

**Hướng đi 1:** 

Map student email vào streamID

**Vấn đề:** 

* Mỗi khi student join meet sẽ có 1 cái **streamId**
* rejoin meet hoặc session mới → **streamId thay đổi → map email vào đây sẽ bị mất**


**Hướng đi 2:**

Map Student email vào **API-based identity** nếu prove được: **signedinUser.user ở case Google API trên**


**Hướng đi 3:**

Map Student email vào name trên DOM → không ổn định do name có thể thay đổi


