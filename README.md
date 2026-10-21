# API ของ Splitly

เวอร์ชัน `0.1.0` มี entrypoint `src/index.ts` สำหรับ Elysia บน Vercel Preview ส่วน `src/server.ts` ยังใช้กับ Docker และ localhost การตั้งค่า Preview และลำดับ deploy อยู่ที่ `../../docs/PREVIEW.md` ในโฟลเดอร์แม่

รีโพซิทอรี Elysia บน Bun 1.4.3 ที่ติดตั้งได้อิสระ จากโฟลเดอร์นี้ให้รัน `bun install --frozen-lockfile`, `bun run check`, `bun run test` และ `bun run build`

หากรันโดยไม่ใช้ Compose ให้คัดลอก `.env.local.example` เป็น `.env.local` ใส่ Supabase dev URL กับ publishable key แล้วรัน `bun run dev` API เปิดที่ <http://localhost:8082>
ตั้ง `API_DOCS_ENABLED=true` เพื่อเปิด Swagger UI ที่ `/docs` และ OpenAPI JSON ที่ `/docs/json`; ค่าเริ่มต้นปิดเอกสาร API

รีโพซิทอรีนี้ดูแล `supabase/migrations` และ RLS tests เมื่อเปิด Docker แล้วให้รัน `bun run db:start`, `bun x supabase migration up --local` และ `bun run db:test` เพื่อตรวจ schema ในเครื่อง คำสั่ง `bun run db:reset:local` ใช้เมื่อยอมลบข้อมูล local เพื่อสร้างฐานข้อมูลใหม่เท่านั้น
ก่อน link และ push ให้เลือก Supabase dev project ที่ถูกต้องและตรวจ `supabase db push --dry-run`

Migration ห้องค่าใช้จ่ายสร้างตารางใน `splitly_private` ที่ไม่เปิดผ่าน PostgREST โดยตรง API เรียก RPC ผ่าน Supabase publishable key ลิงก์ห้องเป็น token สุ่ม 64 ตัวอักษรใน URL fragment และส่งให้ API ทาง `X-Room-Token` ผู้มีลิงก์ดูข้อมูลได้ แต่ต้องเลือกชื่อและตั้ง/ใส่ PIN 6 หลักก่อนเพิ่มรายการ API ส่งเซสชันสมาชิกทาง `X-Member-Token` และตรวจว่าผู้แก้ไขหรือลบรายการ รวมถึงผู้แก้ผู้ร่วมหารหรือหลักฐาน เป็นผู้จ่ายรายการนั้น

`PATCH /v1/rooms/current/expenses/:expenseId` แก้จำนวนเงินและคำอธิบาย โดยคงผู้จ่าย ผู้ร่วมหาร และหลักฐานไว้ `DELETE` ที่ path เดียวกันลบรายการและคำนวณยอดโอนใหม่ ทั้งสอง endpoint ต้องส่ง `X-Room-Token` กับ `X-Member-Token` การลบจะพยายามลบไฟล์หลักฐานหลังฐานข้อมูลยืนยันแล้ว

การคำนวณปัดส่วนแบ่งเป็นสตางค์ในแต่ละรายการ โดยจัดเศษให้ผู้จ่ายก่อนแล้ววนตามลำดับสมาชิก จากนั้นหักกลบยอดหนี้สวนทางเป็นรายคู่ จึงแสดงคู่โอนทั้งหมดและรักษายอดรวมให้ตรงกับยอดรายการ

หลักฐานอยู่ใน Supabase Storage bucket แบบ private ชื่อ `expense-proofs` ใช้ JPEG/PNG/WebP/PDF ไม่เกิน 5 MB ใส่ `SUPABASE_SECRET_KEY` เฉพาะ API แล้วรัน `bun --env-file=.env.local run storage:setup` หนึ่งครั้งเพื่อสร้างหรือปรับ bucket หากใช้ Compose และเก็บค่าไว้ใน `.env` ที่โฟลเดอร์แม่ ให้รัน `bun --env-file=../../.env run storage:setup` จากโฟลเดอร์ `apps/api` ห้ามส่ง secret key ไปเว็บหรือ commit ลง Git หากไม่ตั้งค่า key การทำงานห้องทั่วไปยังใช้ได้ แต่ endpoint หลักฐานจะตอบ 503
ก่อนเปิดบริการสาธารณะต้องเพิ่ม rate limit ที่ขอบระบบ และกำหนดนโยบายลบ/หมดอายุห้องตามความต้องการผลิตภัณฑ์

production image build จาก root ของรีโพซิทอรีนี้ด้วย `Dockerfile`
