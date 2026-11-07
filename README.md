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

Henüz yapılmadı – `package.json`, `tsconfig.json` ve Python bağımlılıkları ekip tarafından eklenecek.

## Çalışma kuralları

- `main` korumalıdır; her değişiklik ayrı bir branch ve pull request ile gelir, en az 1 onay gerekir.
- Branch adları: `feature/<alan>-<kısa-açıklama>`, `fix/<alan>-<kısa-açıklama>`
- Commit mesajları: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- `.env` dosyaları repoya eklenmez; örnek değerler `.env.example` içinde tutulur.
- Projenin tamamı için bkz. [`CLAUDE.md`](CLAUDE.md).
