# Kalkan – Backend

Web ve Android'in ortak kullandığı ana API, kimlik doğrulama, canlı destek altyapısı ve güvenlik araçları servisi.

**Sorumlu:** İrem Karabıyık · **Diller:** TypeScript, JavaScript, Python

## Klasör yapısı

```
docs/api/openapi.yaml   API sözleşmesi – her endpoint önce burada tanımlanır
docker-compose.yml      Servisleri yerelde ayağa kaldırır
api/                    Ana API (Node.js + Express, TypeScript)
├── src/modules/        auth, chat, support, tools, reports, stats, academy
├── src/sockets/        Socket.IO (canlı destek)
├── src/jobs/           BullMQ iş kuyruğu
├── src/config/  middlewares/  lib/
├── prisma/             Prisma şeması ve migration'lar
├── scripts/            Yardımcı betikler (JavaScript)
└── tests/              Jest/Vitest + Supertest
tools-service/          Güvenlik araçları servisi (Python + FastAPI)
├── app/routers/  services/  schemas/
└── tests/              pytest
```

## Kurulum

Canlı destek bağlantı altyapısı için Node.js 24+ ve npm gerekir:

```powershell
cd api
npm ci
npm run typecheck
npm test
npm run build
```

Geliştirme sunucusu için `npm run dev` (http://localhost:3000, sağlık kontrolü: `/health`).
Bu komutlar TypeScript kontrolünü, Socket.IO, devir ve HTTP testlerini ve derlemeyi çalıştırır.
Canlı destek router'ı ve Socket.IO sunucusu, gerçek JWT doğrulama adaptörü ve veritabanı
hazır olduğunda `src/app.ts` / `src/index.ts` içine bağlanacak. Socket.IO kurulumu ve ekip entegrasyonu için
[Bölüm 2 rehberine](docs/api/support-socket-setup.md), devir servisi ve dört HTTP yolu
için [Bölüm 3'e](docs/api/support-handoff-setup.md), önerilen HTTP/olay sözleşmesi
için [Bölüm 1'e](docs/api/support-contract.md) bakın.

Veritabanı (PostgreSQL + Prisma 7):

```bash
docker compose up -d                 # PostgreSQL ve Redis (repo kökünde)
cd api
cp ../.env.example .env              # DATABASE_URL yerel docker ayarına göre hazırdır
npm run prisma:deploy                # Migration'ları uygular (ilk kurulum)
npm run prisma:studio                # Tabloları tarayıcıda görüntüler
```

Şema `api/prisma/schema.prisma` dosyasındadır; değişiklik sonrası `npm run prisma:migrate -- --name <aciklama>`
ile yeni migration oluşturulur. İstemci `npm install` sırasında `src/generated/prisma` altına üretilir;
kodda `getPrisma()` (`src/lib/prisma.ts`) kullanılır.

Güvenlik araçları servisi (Python 3.12+):

```bash
cd tools-service
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8001
pytest
ruff check . && ruff format .
```

## Çalışma kuralları

- `main` korumalıdır; her değişiklik ayrı bir branch ve pull request ile gelir, en az 1 onay gerekir.
- Branch adları: `feature/<alan>-<kısa-açıklama>`, `fix/<alan>-<kısa-açıklama>`
- Commit mesajları: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- `.env` dosyaları repoya eklenmez; örnek değerler `.env.example` içinde tutulur.
- Projenin tamamı için bkz. [`CLAUDE.md`](CLAUDE.md).
