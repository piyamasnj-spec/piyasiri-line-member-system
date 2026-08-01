# ระบบสมาชิก LINE OA - สถานะและขั้นตอนถัดไป

อัปเดตในชุดนี้: 2026-06-30

## สถานะตอนนี้

ระบบหลักมีแล้ว:

- สมัครสมาชิกผ่าน LIFF
- ผูก LINE user ID กับสมาชิก
- เช็กแต้ม
- ลูกค้าส่งยอดซื้อเพื่อขอเพิ่มแต้ม
- แอดมินอนุมัติ/ปรับยอดก่อนแต้มเข้า
- บันทึกยอดซื้อจากเบอร์โทร
- ประวัติซื้อ/ประวัติแต้ม
- แลกของรางวัล
- แอดมินเพิ่ม/ปิด/ลบของรางวัล
- Firebase Realtime Database
- Netlify Functions สำหรับ LINE Messaging API
- ยกเลิกคำขอแลกของและคืนแต้ม
- LINE แจ้งเตือนอนุมัติแต้ม/จัดการแลกของ/ยกเลิกคืนแต้ม
- ด่านรหัสผ่านหลังบ้านแบบพื้นฐาน

## รหัสหลังบ้าน

รหัสเริ่มต้นในไฟล์ `index.html` คือ:

```text
2468
```

ก่อน deploy จริง ให้เปิด `index.html` แล้วค้นหา:

```js
const ADMIN_PASSCODE = "2468";
```

เปลี่ยนเป็นรหัสของร้านเอง

หมายเหตุ: ด่านนี้เป็นการกันคนทั่วไปแบบ frontend เท่านั้น ถ้าต้องการล็อกแบบจริงจัง ต้องเพิ่ม Firebase Auth และตั้ง Firebase Security Rules

## ไฟล์ที่ต้อง deploy

ใช้ทั้งโฟลเดอร์นี้:

```text
outputs/line-member-system-ready
```

ไฟล์สำคัญ:

- `index.html`
- `netlify.toml`
- `netlify/functions/send-line-message.mjs`
- `netlify/functions/notify-expiring-points.mjs`

## Environment Variable ใน Netlify

ต้องมี:

```text
LINE_CHANNEL_ACCESS_TOKEN
```

ค่านี้ต้องเป็น Channel access token จาก LINE Developers > Messaging API

## ขั้นตอน deploy หลัง Netlify ใช้งานได้

1. เปิด Netlify project: `piyasiri-line-member-system`
2. ตรวจ Environment Variable ว่ามี `LINE_CHANNEL_ACCESS_TOKEN`
3. Deploy โฟลเดอร์/รีโปที่มีไฟล์ชุดนี้
4. รอสถานะ Published
5. เปิดเว็บ:

```text
https://piyasiri-line-member-system.netlify.app
```

6. เปิดหลังบ้าน:

```text
https://piyasiri-line-member-system.netlify.app/#admin
```

ต้องเห็นหน้ากรอกรหัสหลังบ้าน

## Checklist ทดสอบหลัง deploy

1. เปิด `#admin` แล้วต้องติดหน้ารหัสผ่าน
2. ใส่รหัสแล้วเข้าหลังบ้านได้
3. สมัครสมาชิกผ่าน LIFF ใน LINE
4. ลูกค้าส่งยอดซื้อเพื่อขอเพิ่มแต้ม
5. แอดมินอนุมัติยอดซื้อ
6. แต้มลูกค้าเพิ่มถูกต้อง
7. ลูกค้าได้รับ LINE แจ้งเตือนอนุมัติแต้ม
8. ลูกค้าแลกของรางวัล
9. แต้มถูกหัก
10. แอดมินกดจัดการแล้ว
11. ลูกค้าได้รับ LINE แจ้งเตือนแลกของเรียบร้อย
12. ลูกค้าแลกของอีกครั้ง
13. แอดมินกดยกเลิกและคืนแต้ม
14. แต้มลูกค้ากลับมา
15. ประวัติมีรายการคืนแต้ม
16. ลูกค้าได้รับ LINE แจ้งเตือนยกเลิกและคืนแต้ม

## ข้อควรระวัง

- ถ้าเปิดเว็บนอก LINE จะเป็น Demo user และอาจส่ง LINE ไม่ได้
- ลูกค้าต้องเป็นเพื่อนกับ LINE OA ร้าน
- ถ้า Netlify Function เปิดแล้วขึ้น `{"error":"method not allowed"}` ถือว่าฟังก์ชันขึ้นแล้ว
- ถ้าฟังก์ชัน 404 ให้เช็ก `netlify.toml` และการ deploy โฟลเดอร์ `netlify/functions`
- ถ้า LINE ไม่แจ้งเตือน ให้เช็ก `LINE_CHANNEL_ACCESS_TOKEN`
