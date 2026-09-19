# Stabilization: security model และเงื่อนไขก่อน integration

Branch: `stabilize/member-system-pre-promaxx` จาก `bde0ae6713cba8d485ba284de8c717cc85eb31d0` ไม่มี merge/push/deploy ในงานนี้

## Model ที่ implement ใน branch

- Admin login ตรวจ scrypt hash บน server; รหัสใหม่ขั้นต่ำ 16 ตัวอักษร (รหัสเดิมใช้ไม่ได้), signed session อายุ 30 นาทีใน HttpOnly/Secure/SameSite=Strict cookie และตรวจ session/revocation ในฐานข้อมูล
- ทุก Admin mutation ตรวจ exact Origin ที่ตั้งค่า รวมถึงตรวจ session ซ้ำใน transaction เพื่อกัน logout race; login จำกัดร่วมกันทุก instance 10 attempts/15 นาที (global budget มีข้อแลกเปลี่ยนว่าอาจถูกใช้ทำให้ login ชั่วคราวไม่ได้)
- Customer ส่ง LIFF access token ให้ server ตรวจ LINE token validity, expiry, channel และ profile จาก LINE; browser ไม่ส่ง identity ที่ใช้เป็นหลักฐานเอง
- Profile รับเฉพาะ name/phone/birthday/area ไม่รับ points, totalSpend, id หรือ lineUserId; ไม่ยึดบัญชีจากเบอร์โทรเดียวกัน ต้องติดต่อร้านเพื่อ reconcile mapping ที่มีอยู่
- Client อ่านผ่าน member-state ซึ่งคืนเฉพาะข้อมูลเจ้าของบัญชี และรางวัลที่เปิดอยู่; Admin ต้องผ่าน server auth จึงอ่านภาพรวมได้ ไม่มี localStorage member cache หรือ Firebase SDK writes
- Redemption ใช้ transaction ร่วมกันของ customers/rewards/transactions/redemptions/secureOperations; operation scope ผูก principal และ key กับ canonical payload; replay คืน receipt เดิม
- complete/cancel เป็น state transition ที่แข่งกันได้เพียงหนึ่งทาง การคืนคะแนนใช้ snapshot เดิมและคืน stock เฉพาะ reservation ที่พิสูจน์ได้
- การอนุมัติ/ปฏิเสธ pending purchase เก็บประวัติไว้; การลบรางวัลเปลี่ยนเป็น archive ไม่ลบรายการหรือข้อมูลสมาชิกจริง
- Notifications อ่านข้อความ/ผู้รับจาก record ฝั่ง server, เก็บ payload กับ LINE retry key เดิม, ไม่รับ free-text/recipient จาก browser; LINE failure ไม่ย้อนกลับ financial commit
- Legacy sale sync ใช้ auth header เดิมและ root transaction ร่วมกัน ไม่เพิ่ม POS/loyalty business rules; reverse/recalculate ที่ทำให้คะแนนติดลบจะถูกปฏิเสธ

## Transaction และขอบเขต

ใช้ RTDB REST GET พร้อม ETag แล้ว conditional PUT ด้วย if-match ที่ root ซึ่งเป็น common ancestor ของ schema เดิม โดย clone snapshot และเปลี่ยนเฉพาะข้อมูลที่เกี่ยวข้อง; conflict 412 อ่านใหม่/revalidate/retry สูงสุด 12 ครั้ง ไม่มี unconditional fallback ไม่มีการย้ายหรือลบ collection

PUT นี้เป็น CAS transaction บน snapshot เดิม ไม่ใช่ migration/reset database ทดสอบว่าข้อมูลอื่นอยู่ครบ และ failure ก่อน commit ไม่เกิด partial writes ส่วน commit แล้ว response หายสามารถ retry key เดิมได้

มี guard ขนาด snapshot 8 MB; ยังต้องวัดขนาดจริง/latency/contention บน staging ที่มีข้อมูลสังเคราะห์ขนาดใกล้เคียงจริง หากไม่เหมาะสมต้อง STOP และเสนอทางเลือกก่อน restructure ห้ามนำ root transaction ขึ้น Production เพียงเพราะ unit tests ผ่าน

Transaction callback ห้ามมี network I/O การส่ง LINE แยกจาก financial commit ใช้ durable notification payload และ retry key; เกิน 23 ชั่วโมงแล้วยังไม่ทราบผลส่งจะขอ reconciliation แทนส่งซ้ำโดยเดา

## Firebase Rules ที่เสนอ

`firebase/database.rules.proposed.json` ปิด browser read/write ทั้ง root และไม่มี descendant grants เพราะทุก operation ผ่าน server แล้ว Server ใช้ OAuth2 service account credentials ใน environment เท่านั้น

Rules นี้ **ยังไม่ deploy และยังไม่ทดสอบกับ emulator/staging จริง** การทดสอบไฟล์โครงสร้างไม่ใช่ผล rules enforcement ไม่มีการแก้ Production Rules

## Environment ที่ต้องเตรียม (ชื่อเท่านั้น)

| ชื่อ | ใช้สำหรับ |
|---|---|
| FIREBASE_DATABASE_URL | URL staging แยกจาก Production ไม่มี default |
| FIREBASE_SERVICE_ACCOUNT_JSON | Service account ของ staging เท่านั้น มีสิทธิ์ RTDB ที่จำเป็น เก็บเป็น secret env |
| APP_ORIGIN | Exact HTTPS origin ของเว็บ staging ที่ได้รับอนุมัติ |
| ADMIN_PASSWORD_SALT | salt ใหม่อย่างน้อย 16 ตัวอักษร |
| ADMIN_PASSWORD_HASH | scrypt(password, salt, 64 bytes) เป็น hex 128 ตัว |
| ADMIN_SESSION_SECRET | คีย์สุ่มอย่างน้อย 32 ตัวอักษร |
| LINE_LOGIN_CHANNEL_ID | Channel ของ Test LIFF ที่อนุมัติ |
| SHEET_SYNC_SECRET | Shared server-to-server secret เดิม ห้ามส่งให้ browser |
| LINE_CHANNEL_ACCESS_TOKEN | สำหรับ Test OA เท่านั้นหากจะทดสอบ notification |
| LINE_NOTIFICATIONS_ENABLED | ค่าเริ่มต้นไม่ส่งข้อความ; เปิดเฉพาะหลังยืนยัน Test OA |

ยังไม่ได้สร้าง/ตั้งค่า/rotate credential ใด ๆ การเตรียมรหัสใหม่ต้องทำหลังมีคำสั่ง ไม่ส่งค่า secret ใน chat หรือ commit

Branch นี้ hard-block hostname ของ Firebase Production และ Netlify CONTEXT=production แม้มี credentials; ห้ามถอด guard โดยพลการ การปล่อยจริงต้องเป็นงานที่อนุมัติต่างหาก

## BLOCKED: active Apps Script และข้อมูล legacy

`sync-rewards` ปิด write และตอบ 503 `blocked_reward_stock_contract_review` หลังตรวจ service auth เนื่องจาก absolute stock snapshot จากชีตอาจคืน stock ที่เพิ่ง reserve แม้ใช้ CAS ไม่มีการเดา deployed contract จาก backup

ต้องได้ active deployed Apps Script source/contract เพื่อเลือก versioned expected-stock หรือ revision/delta protocol และทดสอบก่อนเปิด sync อีกครั้ง; legacy planner เก็บไว้ไม่พัฒนาต่อ ไม่แก้ Apps Script/POS/Stock/Promotion Engine

รายการแลกเก่าที่ไม่มี reservation snapshot จะ cancel ไม่ได้จน reconcile เพราะแยกไม่ออกว่าเคยหัก stock หรือไม่ ส่วน legacy sale operationLocks จะตอบ 409 reconciliation เพื่อไม่ retry รายการที่ผล commit ไม่แน่นอน ไม่มีการลบหรือแก้ records จริง

## ขั้นตอน integration ที่ยังไม่รัน

ไม่มี staging Firebase configured และไม่พบ Firebase CLI/Java runtime ใน PATH ที่ตรวจ จึงหยุดก่อน Firebase integration ตามคำสั่งผู้ใช้

ทางเลือก emulator: เตรียม Firebase CLI กับ Java ที่ CLI รุ่นนั้นรองรับ จากนั้นรันเฉพาะ demo project เช่น `firebase emulators:start --only database --project demo-member-stabilize --config firebase/emulator.json`; ตั้ง `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000` แล้วรัน `node scripts/test-rules-emulator.mjs`

สคริปต์จะรับเฉพาะ loopback namespace `demo-member-stabilize` โหลด proposed rules จริง ทดสอบ deny anonymous read/write และ CAS 412 โดยใช้ synthetic fixture ห้ามเปลี่ยนเป็น Production URL

สำหรับ staging ต้องเตรียม Test LIFF hostname/config ที่ยืนยันแล้ว (branch คง LIFF mapping เดิมไว้), Test OA, synthetic member/reward data, proposed rules บน staging และยืนยัน active Apps Script ก่อนต่อ sync รางวัล

ลำดับ cutover ในอนาคต: ตรวจ export rules ปัจจุบันและ backup ที่อนุมัติ → staging acceptance/end-to-end → reconciliation ข้อมูลเดิม → ตัดสินใจ root transaction capacity → ตรวจ artifacts/secret scan → ขออนุมัติ release ที่ประสาน endpoints, customer read/write path และ rules พร้อมกัน ไม่มีขั้นตอนไหน execute กับ Production ในรอบนี้

## Tests และ artifacts

Offline suite: `node --import ./tests/no-network.mjs --test tests/*.test.mjs` บล็อก global fetch ทดสอบ transport/LINE ด้วย injected mocks เท่านั้น

Browser smoke: `node scripts/test-browser-offline.mjs` ต้องมี Playwright; ใช้ PLAYWRIGHT_MODULE_PATH ระบุ module ที่ติดตั้งไว้ และ PLAYWRIGHT_CHANNEL เช่น msedge ได้ สคริปต์ intercept ทุก request ด้วย fixtures ไม่ติดต่อ LINE/Firebase/Netlify จริง ไม่ใช่ Firebase integration test

Build: `node scripts/build-public.mjs` ใช้ explicit public allowlist ของ index.html/src/assets แทน publish repository root, ไม่ส่ง server source/rules/tests/backups และเปิด Netlify smart secret detection

Secret scan: `node scripts/scan-secrets.mjs` รายงานเฉพาะชื่อไฟล์กับ rule ไม่มีค่าที่ match เป็น local pattern scan ไม่อ้างว่าเป็น forensic scan ทุก credential/history

ProMaxx ยังไม่ implement; service boundary ของสมาชิก/points/rewards พร้อมรองรับ adapter ภายหลังโดยต้องผ่าน principal authorization และ transaction/idempotency เดียวกัน ไม่เพิ่ม import/report format/POS/product stock/business promotion logic

เอกสารอ้างอิง: [Firebase REST conditional writes](https://firebase.google.com/docs/database/rest/save-data), [Firebase server authentication](https://firebase.google.com/docs/database/rest/auth), [LINE token verification](https://developers.line.biz/en/reference/line-login/#verify-access-token), [Netlify scheduled function access](https://docs.netlify.com/build/functions/scheduled-functions/)
