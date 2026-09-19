# Piyasiri LINE Member System

ระบบสมาชิก LINE OA สำหรับร้านปิยสิริเคมีเกษตร

Branch Stabilize นี้ยังไม่พร้อม Production: มี staging-only guard และหยุด reward stock sync จนยืนยัน deployed Apps Script contract

ดู [security model / environment / integration blockers](docs/STABILIZATION_SECURITY_TH.md) และ [release gate](DEPLOY_CHECKLIST_TH.md)

```sh
node --import ./tests/no-network.mjs --test tests/*.test.mjs
node scripts/build-public.mjs
node scripts/scan-secrets.mjs
```

Firebase integration เป็นสคริปต์แยก `scripts/test-rules-emulator.mjs` ที่รับเฉพาะ local demo emulator ไม่ทำงานกับ Production

Netlify Functions ตรวจ Admin session หรือ verified LINE identity ก่อนเข้าถึงข้อมูล และใช้ server-only Firebase authentication; frontend ไม่มี credential และไม่เขียน Firebase โดยตรง

Legacy POS/Stock/Promotion Engine คง Frozen ไม่มี ProMaxx Import ในรอบนี้
