# วิธีเปลี่ยนรูปภาพ

## โลโก้ร้าน

วางไฟล์โลโก้ทับที่ `assets/images/piyasiri-logo.png` โดยใช้ไฟล์ PNG และคงสัดส่วนเดิม หน้าเว็บจะปรับขนาดด้วย `object-fit: contain` โดยอัตโนมัติ หากไฟล์โหลดไม่ได้ ระบบจะแสดงชื่อ “ปิยสิริเคมีเกษตร” แทน

ตำแหน่งกลางของไฟล์กำหนดใน `ASSET_CONFIG.storeLogo` ภายใน `index.html`

## รูปของรางวัล

1. วางไฟล์ใน `assets/rewards/`
2. ตั้งชื่อเป็นภาษาอังกฤษตัวพิมพ์เล็ก คั่นด้วยขีดกลาง เช่น `fertilizer-bag.webp`
3. ใส่ชื่อไฟล์นั้นในค่า `imageUrl` ของข้อมูลของรางวัล เช่น `fertilizer-bag.webp` ไม่ต้องเขียน path ซ้ำ
4. ระบบยังรองรับ URL แบบ `https://...` และลิงก์ Google Drive เดิม

แนะนำรูปแนวนอนอัตราส่วน 16:10 ขนาดประมาณ 1200 × 750 พิกเซล ใช้ `.webp`, `.jpg` หรือ `.png` และควรบีบอัดให้ไม่เกินประมาณ 300 KB เพื่อให้เปิดผ่าน LINE ได้เร็ว หากไม่มีรูปหรือรูปโหลดไม่สำเร็จ ระบบจะแสดง placeholder แทน

ตำแหน่งโฟลเดอร์กลางกำหนดใน `ASSET_CONFIG.rewardImageDirectory` และรูปทั้งหมดแสดงผ่าน component `imageMarkup()` ใน `index.html` โดยไม่ใช้ Base64

## รูป Promotion Banner

กำหนดรูปที่ `PROMOTION_CONFIG.imageUrl` ใน `index.html` เช่น `assets/images/promotion-banner.webp` หากยังไม่ใส่ URL ระบบจะแสดงไอคอน placeholder แทน แนะนำภาพแนวนอนประมาณ 1200 × 600 พิกเซล และไม่เกินประมาณ 300 KB
