# Stabilization review gate — ยังห้าม deploy Production

คู่มือ frontend passcode เดิมเลิกใช้แล้ว รหัสที่เคยอยู่ใน frontend/เอกสารถือว่าเปิดเผยและห้ามนำมาใช้กับ server auth ใหม่ ประวัติเดิมยังอยู่ใน Git โดยไม่ได้ rewrite history

อ่าน [Security model และขั้นตอน staging](docs/STABILIZATION_SECURITY_TH.md) ก่อนใช้งาน branch นี้

- ห้าม merge/push/deploy Production, เปลี่ยน Production Rules, หมุน credentials หรือเปลี่ยน LINE OA/Rich Menu จนได้รับคำสั่ง
- ต้องมี staging Firebase แยกจาก Production, server-only credentials, exact APP_ORIGIN และ Test LIFF ที่ยืนยันแล้ว
- Admin ใช้ scrypt password hash กับ HttpOnly session; ห้ามใส่รหัส/secret ใน index.html
- ทดสอบ proposed Firebase Rules บน emulator/staging ก่อน: browser read/write ถูกปฏิเสธ แต่ authenticated server operations ใช้งานได้
- ต้อง resolve `sync-rewards` active Apps Script contract และ legacy operation/redemption reconciliation ก่อน release
- รัน offline tests, Firebase integration, capacity/contention test, offline build และ secret scan ให้ผ่าน
- Build public artifacts ด้วย `node scripts/build-public.mjs`; ห้าม deploy repository root หรือ backups
- ก่อน release ต้องมีแผน cutover/rollback ที่ประสาน server endpoints, customer data path และ Rules พร้อมกัน

รอบนี้ไม่มี live transaction และไม่มี Production deploy การผ่าน unit tests เพียงอย่างเดียวไม่ปลด release gate
