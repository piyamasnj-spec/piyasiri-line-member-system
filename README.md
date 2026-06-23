# Piyasiri LINE Member System

ระบบสมาชิก LINE OA สำหรับร้านปิยสิริเคมีเกษตร

## Netlify Environment Variables

ต้องตั้งค่าใน Netlify ก่อนใช้งานแจ้งเตือน LINE:

```text
LINE_CHANNEL_ACCESS_TOKEN=Channel access token จาก LINE Messaging API
```

## Functions

- `/.netlify/functions/send-line-message` ส่งแจ้งเตือนเมื่ออนุมัติแต้มและจัดการแลกของ
- `notify-expiring-points` รันวันละครั้งเพื่อเตือนแต้มใกล้หมดอายุ
