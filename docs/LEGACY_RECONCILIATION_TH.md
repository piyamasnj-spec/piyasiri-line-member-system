# Legacy reconciliation — dry run เท่านั้น

เครื่องมือ `scripts/legacy-reconciliation.mjs` อ่าน local JSON และส่ง JSON report ไป stdout ไม่มี Firebase import, network call, write, normalize, repair หรือ migration command

รัน: `node scripts/legacy-reconciliation.mjs LOCAL_SYNTHETIC_OR_APPROVED_SNAPSHOT.json`

รายงานส่งเฉพาะ collection/key/reason ไม่ส่งชื่อ เบอร์โทร credential หรือ record payload; key ยังอาจเป็น identifier จึงควรเก็บ report ภายใน

## หลักฐานใน workspace

ตรวจ baseline Git HEAD `bde0ae6713cba8d485ba284de8c717cc85eb31d0` และ working tree บน `stabilize/member-system-pre-promaxx` ไม่ได้ยืนยันว่า baseline เป็น deployed source

- baseline `index.html`: browser หัก points แล้วบันทึก customer/redemption/transaction ผ่าน Promise.all แยกกัน; redemption อาจไม่มี quantity หรือ stock snapshot, transaction ไม่มี status และ backlink redemptionId
- baseline `reward-redemption.mjs`: claim lock → root patch → finish lock เป็นคนละ write; normal redemption ไม่มี stock snapshot แบบ TEST record
- baseline `lib/firebase-rest.mjs`: failed/stale processing lock เคย retry ได้ จึงอาจเกิด commit แล้ว finish ไม่สำเร็จ; completed ก็ไม่พิสูจน์ว่าการแข่งกับ operation อื่นไม่มี lost update
- working tree `sync-sale-points.mjs`: reversed/revised original พร้อม reversal/replacement record; ห้ามรวมทุก points ตรง ๆ เพราะจะนับซ้ำหรือผิดเครื่องหมาย และยังไม่ทราบ opening balance/ความครบของ history
- working tree `reward-redemption.mjs`: cancellation ใช้ stored points และต้องมีหลักฐาน stock reservation; ไม่มี snapshot ต้อง review

## ผลและข้อจำกัด

`STRUCTURALLY CONSISTENT` = ผ่านการตรวจรูปแบบและลิงก์ที่เครื่องมือตรวจเท่านั้น เป็น candidate ที่รักษา record เดิมต่อได้เมื่อยอดและหลักฐานรวมได้รับการรับรอง ไม่ใช่อนุมัติย้ายข้อมูล

`NEEDS REVIEW` = ห้ามอนุมานผล transaction หรือปรับยอดอัตโนมัติ

ต้อง manual review: member balances ทุก record (opening balance และ ledger completeness ไม่พิสูจน์), legacy locks ทุกสถานะ, missing/duplicate IDs, key/id mismatch, orphan references, invalid points/quantity/status, missing stock reservation, inconsistent debit/refund, refund ซ้ำหรือไม่มี cancellation, reversed/revised chains และ duplicate active bill references

เครื่องมือไม่พยายาม reconcile ยอด stock จริงกับประวัติ restock ไม่ตรวจ active Apps Script contract และไม่รับรอง secureOperations receipts ใหม่; งานนี้เน้น legacy operationLocks เท่านั้น ไม่มีหลักฐานพอจะ certify ยอด Production จาก source code

สิ่งที่ต้องมีเพื่อปิด data gate: sanitized local snapshot ที่ได้รับอนุญาตของ customers/rewards/transactions/redemptions/operationLocks จากเวลาเดียวกัน พร้อม record counts, opening balance/ยอดอ้างอิงที่เชื่อถือได้, ประวัติรายการที่อาจลบ/เขียนไม่ครบ และหลักฐาน debit/refund/stock ของรายการกำกวม ให้ผู้รับผิดชอบตัดสินทีละรายการก่อนอนุมัติ migration แยกต่างหาก ห้ามส่ง credential
