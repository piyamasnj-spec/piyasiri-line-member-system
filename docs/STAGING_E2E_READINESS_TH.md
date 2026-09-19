# Staging E2E readiness — NOT READY

ตรวจ workspace เท่านั้น ไม่เรียก LINE, Netlify deployment หรือ Firebase จริง ไม่ deploy หรือสร้าง credential

## สิ่งที่พร้อมใน source

- Netlify build ใช้ public allowlist `dist`; functions อยู่ `netlify/functions`
- Customer API ส่ง LIFF access token ผ่าน Authorization; server ตรวจ expiry/channel/profile ก่อนใช้ identity
- member-profile whitelist, member-state owner scope, redemption atomic/idempotent และ admin server session มี implementation
- APP_ORIGIN ต้องตรง origin จริง; admin cookie Secure/HttpOnly/SameSite=Strict; production context ถูก guard ปฏิเสธ
- ผล emulator และ reconciliation เป็นงานที่เสร็จก่อนหน้า ไม่รันซ้ำในรอบนี้

## หลักฐานที่ยังไม่พอ

index.html กำหนด test LIFF เฉพาะ deploy-preview-6 hostname เดิม ยังไม่มีหลักฐานว่า URL นี้รัน working tree ล่าสุดหรือผูก Firebase แยก ห้ามใช้เป็น staging อัตโนมัติ
Test LIFF ID ใน source มี prefix ของ channel เดียวกับ Production จึงต้องยืนยันแยก test channel/LIFF ที่ได้รับอนุญาตก่อน ไม่แก้ LINE channel เดิม
ไม่มี staging env names ที่เกี่ยวข้องใน process environment และไม่พบ local env configuration ใน repository ที่ตรวจ ไม่ได้สรุปว่า remote Netlify ไม่มีค่า เพราะไม่ได้เข้าถึง remote configuration

## ผู้ใช้/ผู้ดูแลต้องเตรียม

1. ยืนยัน isolated staging Netlify site/context และ hostname ที่แน่นอน รวมถึง revision ของ branch ที่จะนำไป staging ห้ามใช้ CONTEXT=production เพราะ guard ปัจจุบันปิดไว้ แม้เป็น site สำหรับ test; ใช้ deploy-preview/branch-deploy ที่อนุมัติ
2. ยืนยัน Firebase project/database staging ที่แยกจริง พร้อม service account/IAM และ proposed Rules เฉพาะ staging; ต้องยืนยัน account กับ database เป็น project เดียวกันจาก console หลักฐาน ไม่เดาจากชื่อ URL
3. Login LINE Developers ด้วยตนเอง สร้างหรือระบุ Test LINE Login channel/LIFF ที่อนุมัติ ตั้ง endpoint เป็น staging hostname และเพิ่ม tester ที่ต้องใช้ ยืนยัน profile permission และ access token ใช้ channel เดียวกับ server; ไม่ใช้ Production LIFF แทน
4. หลังได้ hostname/Test LIFF ที่ยืนยันแล้ว จึงแก้ mapping เฉพาะ staging ใน index.html งานรอบนี้ยังไม่เปลี่ยน mapping หรือ UX
5. ตั้ง server-only env ใน Functions ของ staging context ผ่าน secret management ไม่ใส่ใน frontend/build artifact/chat: FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_JSON, APP_ORIGIN, ADMIN_PASSWORD_SALT, ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET, LINE_LOGIN_CHANNEL_ID ตั้ง LINE_NOTIFICATIONS_ENABLED=false และ FIREBASE_EMULATOR_MODE ไม่เป็น true
6. เตรียมรหัส admin เฉพาะ staging และ synthetic customer/reward/points fixture พร้อมบัญชี tester ที่ได้รับอนุญาต ไม่ใช้ข้อมูลจริง ไม่ rotate credential เดิม

Test OA และ LINE_CHANNEL_ACCESS_TOKEN ไม่จำเป็นต่อ core flow เมื่อ notifications ปิดอยู่; ถ้าจะพิสูจน์ messaging ภายหลังต้องมี Test OA/token และคำอนุมัติแยก SHEET_SYNC_SECRET ไม่จำเป็นต่อ flow รอบนี้ ไม่เปิด sync-rewards

## Preflight และ acceptance harness

`node scripts/staging-preflight.mjs` ตรวจ config แบบ offline พิมพ์เฉพาะชื่อและ reason ไม่พิมพ์ค่า secret ไม่ fetch ไม่ deploy ไม่เขียนข้อมูล
STATIC CHECKS PASS ไม่รับรอง credential validity/IAM/deployment; ยังต้องมีหลักฐาน environment และ live acceptance ด้านล่าง

เมื่อ prerequisites ครบและได้รับอนุมัติการเขียน synthetic staging ให้รันตามลำดับ พร้อมบันทึก status/record ID ที่จำเป็นเท่านั้น ห้ามบันทึก token/cookie/password:

| Flow | หลักฐานที่ต้องได้ |
|---|---|
| Test LIFF identity | login/callback กลับ hostname test และ route เดิม; token ของ test channel ผ่าน server; invalid/wrong-channel token ถูกปฏิเสธ |
| Register/profile | POST member-profile สร้าง tester ครั้งเดียว; update fields เดิมได้; payload points/id ถูกปฏิเสธ |
| Member read | GET member-state เห็นข้อมูล tester เท่านั้น ไม่เห็นรายอื่นหรือ security records |
| Redemption | POST reward-redemption key เดิม retry ได้ receipt เดิม; points/stock ลดครั้งเดียว; history/member-state สอดคล้อง |
| Admin | POST admin-session login; cookie attributes ถูกต้อง; GET member-state?admin=true และ POST admin-operations ทำงานเฉพาะ session จริง/exact Origin; forged session ถูกปฏิเสธ |
| Logout | session ถูก revoke และ cookie เก่าใช้ mutation ไม่ได้ |
| Server-only Firebase | anonymous direct read/write บน staging ถูกปฏิเสธ; server credential ยังทำงาน; public artifact ไม่มี server credential |

ผล live ทั้งสาม gate: Netlify endpoints BLOCKED, LINE/LIFF staging E2E BLOCKED, Firebase server-only staging BLOCKED จนมี prerequisites ไม่ใช้ผล offline เป็น live PASS

Release blockers เดิมยังอยู่: active reward stock contract, actual legacy data certification, Production-like capacity และ cutover approval ไม่ดำเนินการต่อในรอบนี้
