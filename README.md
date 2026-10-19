# API ของ Splitly

รีโพซิทอรี Elysia บน Bun 1.4.3 ที่ติดตั้งได้อิสระ จากโฟลเดอร์นี้ให้รัน `bun install --frozen-lockfile`, `bun run check`, `bun run test` และ `bun run build`

หากรันโดยไม่ใช้ Compose ให้คัดลอก `.env.local.example` เป็น `.env.local` ใส่ Supabase dev URL กับ publishable key แล้วรัน `bun run dev` API เปิดที่ <http://localhost:8082>
ตั้ง `API_DOCS_ENABLED=true` เพื่อเปิด Swagger UI ที่ `/docs` และ OpenAPI JSON ที่ `/docs/json`; ค่าเริ่มต้นปิดเอกสาร API

รีโพซิทอรีนี้ดูแล `supabase/migrations` และ RLS tests เมื่อเปิด Docker แล้วให้รัน `bun run db:start`, `bun run db:reset:local` และ `bun run db:test` เพื่อตรวจ schema ในเครื่อง
ก่อน link และ push ให้เลือก Supabase dev project ที่ถูกต้องและตรวจ `supabase db push --dry-run`

production image build จาก root ของรีโพซิทอรีนี้ด้วย `Dockerfile`
