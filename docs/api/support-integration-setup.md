# Destek entegrasyonu ve teslim — Bölüm 6–8

**Sorumlu: Hasti.** EN: Support integration and handover by Hasti.

Bu çalışma `main` içindeki `a3af28e` sunucu iskeleti ve Eren'in
`chore/backend-prisma` dalındaki `450bf34` şema/migration'ı üzerine kuruludur.
Bu upstream dosyalar yerel çalışma kopyasına alındı; ilk migration değiştirilmedi.
Prisma dalı henüz main'de olmadığı için yeni PR bu bağımlılığı açıkça belirtmelidir.
Bölüm 1–5 belgelerindeki "DB adaptörü/ana giriş yok" notları tarihsel durumdur;
güncel durum bu belgededir. API yolları hâlâ ekip incelemesine açık sözleşmedir.

## Tamamlanan kod

| Bölüm | Sonuç |
| --- | --- |
| 6 — Depo ve auth bağlantısı | Gerçek Prisma adaptörü, ek migration, ortak HTTP/Socket.IO doğrulayıcı, isteğe bağlı imza doğrulayan JWT adaptörü |
| 7 — Kuyruk ve bildirim | Lease/retry destekli kalıcı outbox dispatcher, BullMQ yayın köprüsü, DB bildirimleri, güncel durumla çalışan worker bağlantısı |
| 8 — Çalıştırma ve doğrulama | Tek sunucu factory'si, yapılandırılabilir başlangıç/kapanış, gerçek PostgreSQL testleri, Redis CI testi ve teslim rehberi |

Ana dosyalar: `prisma-support.store.ts`, `support-auth.ts`, `support-outbox.ts`,
`support-runtime.ts` (`api/src/modules/support/` altında). Açıklamalar TR/EN'dir.

## Veritabanı — Eren

`20261114010000_support_delivery` migration'ı:

- Mesajlara `clientMessageId`, oturum içi `sequence`, özel `contentFingerprint` ekler.
- `(sessionId, senderId, clientMessageId)` ve `(sessionId, sequence)` unique olur.
- Oturumun mesaj sayacı aynı transaction içinde güncellenir; durum `revision` ve
  `updatedAt` alanları yalnızca mesaj gönderildiği için değişmez.
- Eski mesajları silmez. Mevcut metin ve zaman korunur, deterministik tarih/id
  sırasıyla sequence ve rastgele UUID atanır. Eski ham metin bilinmediği için HMAC
  null kalır; böyle bir mesajı yeniden gönderme girişimi `MESSAGE_ID_CONFLICT` verir.
- Outbox'a deneme sayısı, bir sonraki deneme zamanı, lease kimliği/süresi ve yalnızca
  sabit hata kodu ekler. Başka bir worker'ın lease'ini eski worker tamamlayamaz.

Prisma işlemleri `ReadCommitted` ve açık transaction kilitleri kullanır: mevcut
oturum `FOR UPDATE`, henüz olmayan conversationId transaction advisory lock ile
korunur. Kilit beklemesinden sonraki okuma güncel durumu görür. Diğer ekiplerin
oturum/teklif değiştiren işlemleri aynı oturum kilidine katılmalıdır.
`P2034`/`P2002` yarışları en fazla sekiz denemeyle tekrar edilir. Callback ve commit başarıyla bitmeden ack dönmez. Mesaj,
sayaç ve oturum/outbox yazımları transaction hatasında geri alınır. Üretim öncesi
migration ve silme/retention politikası Eren ile değerlendirilmelidir.

```powershell
cd api
npm ci
npm run prisma:generate
# DATABASE_URL yalnızca hedef geliştirme/veritabanı ortamında ayarlanır.
npm run prisma:deploy
```

Migration komutu bu çalışmada yalnızca izole test DB'sine uygulandı; ortak veya
üretim veritabanında migration çalıştırılmadı. Prisma sürümü upstream'deki 7.10.1'dir.

## Auth — Amir Ali / Buse

`createSupportServer` zorunlu `verifyAccessToken(token, { signal })` alır. Aynı
doğrulayıcı HTTP Bearer ve Socket.IO handshake/komut/yayın kontrolünde kullanılır.
HTTP doğrulamasında timeout ve istemci ayrılmasında iptal vardır; query/cookie token
kabul edilmez. Sonuç `{ userId, role, expiresAt }`, süre Unix milisaniyesidir.

Mevcut auth farklı JWT sözleşmesi kullanıyorsa kendi doğrulayıcısını verin.
`createSupportJwtVerifier` **isteğe bağlı HS256 adaptörüdür**; bunu seçerseniz:

- En az 32 bayt gizli anahtar, beklenen `issuer` ve `audience` zorunludur.
- Başlık `alg: HS256`, `typ: at+jwt`; claim'ler `sub`, `role`, `jti`, `iat`, `exp`.
- İmza, issuer/audience, token tipi, süre ve rol kontrol edilir. Refresh token bu
  sözleşmeye uymamalıdır. Bu modül login/register veya token üretimi sağlamaz.
- `isActive` callback'i zorunludur. `createPrismaAccessCheck(prisma, isTokenRevoked)`
  güncel DB kullanıcı durumunu/rolünü kontrol eder ve auth ekibinin **gerçek** iptal
  kaynağını çağırır. Üretimde `async () => false/true` gibi test varsayılanları kullanmayın.
- Auth altyapı hatası 503, geçersiz/iptal edilmiş kimlik 401 olur. Socket token'ı
  iptal edilince yayın öncesi de doğrulanır. Çok süreçli iptal bildirimi ayrıca gerekir.

## Kuyruk — Seyit

`createBullMqSupportPublisher(queue)` outbox olayını `support.reconcile` işi olarak
ekler; veri yalnızca `{ eventId, sessionId }` içerir. Job ID olay ID'sinin SHA-256
özetidir; BullMQ'nun kabul etmediği `:` karakteri yoktur. Başarılı/başarısız işler
otomatik silinmez; aynı outbox tekrarının yeniden iş oluşturması önlenir.
Job retention/bakımı teslim geçmişiyle koordine edilmelidir.

```typescript
const publishQueueEvent = createBullMqSupportPublisher(queue);
const processSupport = createSupportQueueHandler(prisma, reconcileSupportSession);
// Worker yalnızca bu destek kuyruğunu tüketmelidir.
const worker = new Worker(queueName, (job) => processSupport(job.data), { connection });
```

`reconcileSupportSession(session, eventId)` Seyit/Furkan'ın gerçek iş mantığıdır:
uzman teklifi, kuyruktan çıkarma ve AI üretimini durdurma burada bağlanır. Eski queued
olayı closed oturumu yeniden açmamalıdır. Handler güncel DB görünümünü alır; **iş
etkileri aynı DB revision kontrolüyle atomik ve idempotent uygulanmalıdır**, çünkü
okuma ile etki arasında durum değişebilir. Bu callback henüz takım deposunda yoktur.

Dispatcher önce lease alır, kuyruğa yazar ve Socket.IO'ya güncel durum yayını ister.
Sonra DB bildirimi ve `processedAt` aynı transaction'da yazılır. Notice ID
oturum/revision/alıcıya göre sabittir; tekrarlar bildirim çoğaltmaz. Başarısız işler
artarak en fazla beş dakikaya çıkan beklemeyle yeniden denenir. `DELIVERY_FAILED`
dışında ham exception/token/metin saklanmaz. Teslim timeout'u lease'ten kısadır.
Timeout, Redis'e giden isteği geri alamaz; geç tamamlanan teslim de aynı job ID'yi
kullanır. Askıda kalan lease süre dolunca başka worker tarafından alınabilir.

DB bildirimi uygulama içi `Notification` kaydıdır; e-posta, SMS veya push servisi
çağrılmaz. Canlı yayın bu API sürecindeki alıcılara gider; çok süreçli Socket.IO
dağıtımı hâlâ ayrı entegrasyondur. Ağda tam bir kez teslim garantisi yoktur.

## Başlangıç — tek sunucu

`createSupportServer(options)` Express router'ını, HTTP sunucusunu, Socket.IO'yu,
handoff/mesaj servislerini ve dispatcher'ı birlikte kurar. Zorunlu bağımlılıklar:

- `prisma`: paylaşılan gerçek PrismaClient.
- `verifyAccessToken`: gerçek auth adaptörü.
- `messageHmacKey`: `decodeSupportMessageKey(base64Value)` sonucu; JWT anahtarından
  ayrı, kalıcı, tüm süreçlerde aynı anahtar. Rotasyon henüz desteklenmiyor.
- `redactText`: Eren'in yerel/senkron/deterministik maskelemesi. Test maskesi üretim
  politikası değildir; bu fonksiyonun gerçek uygulaması upstream'de henüz yoktur.
- `publishQueueEvent`: BullMQ köprüsü; `allowedOrigins` açık origin listesi.
- `onDeliveryError`: yalnızca sabit kod alan izleme callback'i.

Standart `npm start` için `SUPPORT_ADAPTER_MODULE` yerel, güvenilir bir modülün
yoludur (`api` çalışma dizinine göre; build sonrası genellikle `./dist/config/...js`).
Modül aşağıdaki factory'yi export etmelidir. Değişkenler ilgili ekip adaptörleridir;
bu şablon hazır bir auth/maskeleme/queue sistemi olduğu anlamına gelmez.

```typescript
export async function createSupportBootstrap() {
  // Bağımlılıkları başlatın; kısmi başlangıç hatasında açılan kaynakları temizleyin.
  return {
    options: {
      prisma,
      verifyAccessToken,
      messageHmacKey: decodeSupportMessageKey(config.supportMessageHmacKey),
      redactText,
      publishQueueEvent: createBullMqSupportPublisher(queue),
      allowedOrigins: config.allowedOrigins,
      onDeliveryError: (code) => logger.error({ code }),
    },
    async closeDependencies() {
      await queue.close();
      await prisma.$disconnect();
    },
  };
}
```

Giriş sunucuyu açar, dispatcher'ı başlatır, SIGTERM/SIGINT'te önce destek sunucusunu
sonra paylaşılan bağımlılıkları kapatır. `SUPPORT_ADAPTER_MODULE` boşsa health
iskeleti çalışır, **`/support` 503 döner**; kimlik doğrulamayı atlayan demo açılmaz.
Başlangıç öncesi `.env.example` dosyasını `api/.env` olarak doldurun veya ortam
değişkenlerini sağlayın; sırlar repoya eklenmez.

## Test ve CI

```powershell
cd api
npm run typecheck
npm test
npm run test:integration
npm run build
```

`test:integration` uygulamanın `DATABASE_URL` değerini kullanmaz. Varsayılan olarak
rastgele port/parolalı, yalnızca 127.0.0.1'e bağlı geçici PostgreSQL 18.6 açar;
migration'ları uygular, test eder, sunucuyu kapatır ve yalnızca kendi geçici
dizinini temizler. Docker veya sistem servisi kurulmaz. Paket sürümü sabittir;
`embedded-postgres` yalnızca geliştirme bağımlılığıdır.

CI'da PostgreSQL 17 ve Redis 7 servisleri kullanılır. Harici test DB seçilecekse
`SUPPORT_TEST_DATABASE_URL` **ayrı bir `*_test` veritabanını** göstermelidir; testler
oluşturdukları kullanıcıları siler. `SUPPORT_TEST_REDIS_URL` yoksa gerçek Redis
testi açıkça skip olur. Yerel PostgreSQL testi, Redis testinin geçtiği anlamına gelmez.

Doğrulama; gerçek transaction yarışları/rollback, iki uzman yarışı, imzalı JWT ile
HTTP → Socket.IO → kalıcı geçmiş, kullanıcı askıya alma/token iptali, retry/lease,
güncel durumdan bildirim ve gecikmiş kuyruk olaylarını kapsar. CI değişiklikleri
hazırdır; güncel CI sonucu pull request Checks bölümünden izlenir.

## Teslim için kalan dış bağlantılar

### Yerel doğrulama sonucu — 2026-11-15

| Kontrol | Sonuç |
| --- | --- |
| TypeScript kontrolü ve production build | Başarılı |
| API/HTTP/Socket.IO/JWT birim ve bağlantı testleri | 151 geçti |
| Gerçek PostgreSQL entegrasyonu ve eski veri migration testi | 11 geçti |
| Migration sonucu ile Prisma şemasının karşılaştırması | Fark yok |
| OpenAPI yerel referansları | 5 yol, 80 referans doğrulandı |
| Gerçek Redis entegrasyonu | Yerelde Redis olmadığı için 1 test skip; CI sonucu henüz alınmadı |

Geçici PostgreSQL testi exit code 0 ile kapandı. Bu sonuçlar ortak/üretim ortamına
deployment veya takım adaptörlerinin tamamlandığı anlamına gelmez.

Bu üç bölümün kodu ve yerel test altyapısı hazırdır; üretim kabulü için auth ekibinin
token/iptal kaynağı, Eren'in maskeleme politikası, Seyit/Furkan'ın reconcile/AI
callback'i, gerçek Redis testi ve ekip ortamında uçtan uca kabul hâlâ gerekir.
Bu eksikler mock ile tamamlanmış gibi gösterilmedi. Branch yayını üretim kabulü veya manager onayı değildir.

Teknik kaynaklar: [Prisma transactions](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions),
[JOSE](https://github.com/panva/jose), [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids),
[embedded-postgres](https://github.com/leinelissen/embedded-postgres).

Kilit davranışı: [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).
