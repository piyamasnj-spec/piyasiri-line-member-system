# Public Promotions แบบอ่านอย่างเดียว

ไฟล์ `PublicPromotions.gs` อ่านเฉพาะช่วง `โปรโมชั่น!A:N` จากไฟล์ร้าน และคืนเฉพาะข้อมูลที่อนุญาตให้ลูกค้าเห็น ไม่มีคำสั่งเพิ่ม แก้ ลบ หรือตัดสต๊อก

## การรวมกับ Apps Script เดิม

ตรวจ source จริงครบทั้ง `appsscript.json`, `Code.gs` และ `PromotionEngine.gs` เมื่อ 2026-08-25 แล้ว ไม่พบ `doGet(e)` เดิม ไฟล์ `PublicPromotions.gs` จึงประกาศ `doGet(e)` ใหม่หนึ่งตำแหน่ง และคืน `NOT_FOUND` สำหรับ route อื่น

หากนำ handler นี้ไปใช้กับโปรเจกต์อื่นที่มี `doGet(e)` อยู่แล้ว ห้ามประกาศซ้ำ ให้ลบ `doGet(e)` ในไฟล์นี้แล้วเพิ่มสองบรรทัดนี้ไว้ตอนต้นของ `doGet(e)` เดิม:

```javascript
var publicPromotionsOutput = routePublicPromotionsGet_(e);
if (publicPromotionsOutput) return publicPromotionsOutput;
```

รูปแบบ entry point สำหรับโปรเจกต์ที่ไม่มี `doGet(e)`:

```javascript
function doGet(e) {
  var publicPromotionsOutput = routePublicPromotionsGet_(e);
  if (publicPromotionsOutput) return publicPromotionsOutput;
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: "NOT_FOUND" }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

URL สำหรับหน้าเว็บใช้รูปแบบ:

```text
https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?route=public-promotions
```

หลังสร้าง Deploy สำหรับทดสอบแล้ว ให้นำ URL เต็มไปใส่ที่ `PUBLIC_PROMOTIONS_CONFIG.endpoint` ใน `src/public-promotions.mjs` ก่อนทดสอบ Deploy Preview ห้ามเดา Deployment ID

## ข้อมูลที่ส่งออก

- รหัสและชื่อโปรโมชั่น
- รหัสสินค้าที่ซื้อและสินค้าแถม
- จำนวนขั้นต่ำและจำนวนแถม
- ประเภท/ราคาพิเศษ/รูปแบบราคา/ตัวคูณคะแนน
- การใช้ซ้ำตามจำนวนซื้อ
- วันที่เริ่ม วันที่สิ้นสุด และสถานะ `ใช้งาน`

ชีต `โปรโมชั่น!A:N` มีเฉพาะ “รหัสสินค้า” ไม่มีชื่อสินค้า ดังนั้น endpoint ไม่อ่านชีต `สินค้า` เพิ่มและไม่สร้างชื่อสินค้าเอง หน้าเว็บจะแสดงรหัสอย่างตรงไปตรงมาจนกว่าจะมีชื่ออยู่ใน schema ที่ได้รับอนุมัติ

## ความปลอดภัย

- route นี้รองรับ GET เท่านั้นผ่าน `doGet`
- อ่านด้วย `getValues()` เท่านั้น
- ไม่คืนราคาทุน สต๊อก ลูกค้า หรือข้อมูลจากชีตอื่น
- ไม่ใช้ Firebase และไม่เปลี่ยน Promotion Engine
- การเพิ่ม/แก้โปรโมชั่นในชีตไม่เรียกขั้นตอนขายหรือตัดสต๊อก
