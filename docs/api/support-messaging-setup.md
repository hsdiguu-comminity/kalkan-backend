# Canlı mesajlaşma ve geçmiş — Bölüm 4–5

> Güncel Prisma/auth/outbox entegrasyonu Bölüm 6–8'de eklendi.
> Aşağıdaki adaptör bekleme notları bu bölümün tarihsel durumudur;
> [güncel kurulum ve kalan dış bağımlılıklar](support-integration-setup.md) esas alınmalıdır.

**Sorumlu:** Hasti. **Durum:** Mesaj servisi, yetkili Socket.IO odaları ve geçmiş
router'ı hazır; gerçek auth, PostgreSQL, maskeleme ve outbox worker adaptörleri bekleniyor.
EN: Messaging, authorized rooms and HTTP history are implemented and locally tested.
Production authentication, database, redaction and outbox integrations remain team work.

## Dosyalar ve davranış

| Dosya | İşlev / Purpose |
| --- | --- |
| `api/src/modules/support/message.service.ts` | Mesaj doğrulama, transaction içinde yazma, HMAC ile tekrar kontrolü, sayfalama / validation, persistence interface, deduplication, history |
| `api/src/sockets/support.socket.ts` | Yetkili oda, commit sonrası ack, alıcı erişim kontrolü / rooms, acknowledgements, recipient authorization |
| `api/src/sockets/index.ts` | İşleyicileri kurma, yayın öncesi token doğrulama / wiring and token verification |
| `api/src/modules/support/support.routes.ts` | Beşinci HTTP yolu: mesaj geçmişi / fifth HTTP route: history |
| `api/tests/support/message.service.test.ts` | Transaction, tekrar, maskeleme, sıra ve yetki / transaction and service tests |
| `api/tests/support/support.messaging.test.ts` | Gerçek yerel Socket.IO ve HTTP bağlantıları / local network integration tests |

- `support:join({ sessionId }, ack)` yalnızca sahibi veya atanmış uzmanı odaya alır.
  Ack güncel oturumu döndürür. Queued/closed oturum sahibi de geçmişini okuyabilir.
- `support:message:send({ sessionId, clientMessageId, text }, ack)` yalnızca active
  oturumda yeni mesaj oluşturur. Gönderenin odaya girmesi zorunlu değildir; oturum
  erişimi zorunludur. Odaya katılmış katılımcılar canlı yayını alır.
- Ack zorunludur; eksik callback veya ek alanlar yazmadan reddedilir. Başarılı ack
  `{ ok: true, data: message }`, hata `{ ok: false, error: { code, message } }` olur.
- Kimlik/rol/saat/sıra sunucudan gelir. Metin 1–4000 Unicode kod noktasıdır, yalnızca
  boşluk olamaz, HTML olarak işlenmez. Maskeleme sonrası çıktı da bu sınırlara uymalıdır.
- Aynı oturum/gönderen/UUID ve aynı ham metin tek kayıt oluşturur; tekrar aynı ack'i
  döndürür, yeni yayın oluşturmaz. UUID küçük harfe çevrilir. Değişmiş metin
  `MESSAGE_ID_CONFLICT` olur; iki farklı ham metin aynı maskeye dönüşse bile reddedilir.
- Kapanmadan önce kaydedilmiş mesajın aynı tekrarı kapanıştan sonra da dönebilir.
  Yeni mesaj queued durumunda `SESSION_NOT_ACTIVE`, closed durumunda `SESSION_CLOSED` olur.
- `support:message:created` yalnızca commit sonrası yayınlanır. Her alıcının token'ı
  ve katılımcılığı yeniden kontrol edilir; odada bulunmak tek başına izin değildir.

## Ana uygulamaya bağlama — Amir Ali / Buse

Örnek yalnızca bağlantı biçimidir: `app`, `httpServer` ve adapter değişkenleri ekipçe
sağlanmalıdır. Mevcut HTTP sunucusuna tek Socket.IO örneği eklenir.

```typescript
import { createHandoffService } from "./modules/support/handoff.service.js";
import { createSupportMessageService } from "./modules/support/message.service.js";
import { createSupportRouter } from "./modules/support/support.routes.js";
import { createSupportSocketServer } from "./sockets/index.js";

const handoff = createHandoffService({
  store: supportDatabaseAdapter,
  conversations: chatOwnershipAdapter,
});
const messages = createSupportMessageService({
  store: supportDatabaseAdapter, // TR: Aynı transaction kaynağı. EN: Same transaction source.
  messageHmacKey: decodedSupportMessageKey,
  redactText: redactSupportText,
});
app.use("/support", createSupportRouter({
  service: handoff,
  messages,
  resolvePrincipal: resolveVerifiedHttpPrincipal,
}));
const realtime = createSupportSocketServer(httpServer, {
  allowedOrigins,
  verifyAccessToken,
  support: { handoff, messages },
});
// TR: Outbox worker commit edilmiş oturum değişimini işlerken çağırır.
// EN: Call from the outbox consumer when processing a committed session change.
// await realtime.publishSessionUpdate(event.session.id);
```

`support` seçeneği yoksa bağlantı testlerinde kullanılan yalnızca-auth modu korunur;
mesaj olayları kurulmaz. Router'a `messages` verilmezse geçmiş 503 döner. Test
deposu veya kimlik doğrulamayı atlayan bir üretim varsayılanı yoktur.

## Kalıcı depo ve maskeleme — Eren

`SupportTransaction` artık aşağıdaki **zorunlu** metotları da içerir; mevcut adaptör
ve mock'lar genişletilmelidir. Handoff ve mesaj servisleri aynı transaction/oturum
kilidini kullanır. Kabul, kapanış, sıra ayırma ve mesaj yazımı birbirleriyle yarışamaz.

| Metot | Gereken garanti |
| --- | --- |
| `findMessageByClientId(sessionId, senderId, clientMessageId)` | `StoredSupportMessage` veya null; aynı transaction'da tekrar kontrolü |
| `nextMessageSequence(sessionId)` | Oturum başına atomik artan güvenli tamsayı; aralıklar olabilir |
| `saveMessage({ message, contentFingerprint })` | Maskelenmiş mesaj ve HMAC aynı transaction'a yazılır |
| `listMessages(sessionId, afterSequence, limit)` | Yalnızca o oturum, `sequence > afterSequence`, artan sıra, en fazla limit kayıt |

Veritabanında `message.id`, `(sessionId, sequence)` ve
`(sessionId, senderId, clientMessageId)` benzersiz olmalıdır. Callback başarılı olsa
bile commit tamamlanmadan transaction çözülmez; hata halinde yazımlar rollback olur.
Serialization/unique yarışlarını adaptör sınırlı sayıda tekrarlar. Bu garantiler
test deposunda sınandı; gerçek PostgreSQL üzerinde ayrıca doğrulanmalıdır.

`redactText` yerel, deterministik, senkron ve yan etkisiz bir fonksiyondur. Ağ çağrısı
veya log yazımı yapmaz; retry edilen transaction içinde tekrar çalışabilir. Ham
metin saklanmaz/yayınlanmaz. Testlerdeki `secret:` maskesi gerçek PII politikası değildir.
Politika ve maskeleme uygulaması Eren tarafından sağlanır; varsayılan pass-through yoktur.

`SUPPORT_MESSAGE_HMAC_KEY` `.env.example` içinde boş yer tutucudur. Config katmanı
base64 değerini doğrulayıp en az 32 rastgele bayta çözerek `messageHmacKey` olarak
vermelidir; servis ortam değişkenini kendisi okumaz. Anahtar JWT anahtarından ayrı,
tüm API süreçlerinde aynı ve yeniden başlatmalar arasında kalıcı olmalıdır.
Bu sürüm tek anahtar kullanır: anahtarı doğrudan değiştirmek eski tekrarların
karşılaştırmasını bozar. Rotasyon için anahtar sürümü/migration tasarımı gerekir.
HMAC alanı HTTP/Socket.IO yanıtlarında yoktur; ham metin ve token loglanmaz.

## Durum yayını — Seyit

Outbox tüketicisi `support.queued`, `support.accepted`, `support.closed` işlemlerinden
sonra `await realtime.publishSessionUpdate(event.session.id)` çağırabilir. Yayın eski
outbox görünümünü kullanmaz; her yetkili alıcı için güncel oturumu tekrar okur.
Tekrar/sırasız durum olaylarını istemci `revision` ile ayıklar.

Bu fonksiyon yalnızca **bu süreçteki** bağlı alıcılara yayın yapar. Redis adapter ve
süreçler arası dispatcher henüz yoktur; birden çok API süreci için ayrıca tasarlanmalıdır.
Alıcı erişimi/depo kontrolü başarısızsa alıcı odadan çıkarılır; auth başarısızsa bağlantı
da kesilir. İstemci hata sonrası kimliğini düzeltip yeniden katılmalı ve geçmişi yenilemelidir.

Mesaj için ayrı kalıcı yayın outbox'ı yoktur: DB commit ile ağ yayını arasında süreç
kapanırsa mesaj geçmişte bulunur fakat canlı olay kaybolabilir. Ack kayıt onayıdır,
okundu/teslim edildi makbuzu değildir. Eksik olaylar HTTP geçmişiyle tamamlanır.

## Web / Android: yeniden bağlanma ve geçmiş

`GET /support/sessions/:sessionId/messages?afterSequence=0&limit=50`
Bearer auth kullanır. Varsayılan cursor 0, limit 50; limit 1–100. Yanıt:

```json
{ "items": [], "nextAfterSequence": 0, "hasMore": false }
```

1. Canlı mesaj/durum dinleyicilerini bağlanmadan önce kurun; mesajları `id` ile
   tekilleştirin, `sequence` ile sıralayın. Metni düz metin olarak gösterin.
2. Her bağlantıda `support:join` ack'ini bekleyin. Dönen oturum ve canlı durumlarda
   yalnızca daha yüksek `revision` uygulayın.
3. Son kaydedilmiş **HTTP geçmiş cursor'undan** sayfaları alın; canlı olayları bu
   sırada tamponlayıp `id` ile birleştirin. `hasMore` true ise sonraki sayfayı alın.
4. Cursor'u yalnızca başarılı HTTP sayfasının `nextAfterSequence` değeriyle
   ilerletin. Canlı bir olay daha ileri sıradaysa cursor'u ona atlatmayın.
5. Yeniden bağlanmada, uygulama odağa dönünce ve uygulamanın belirlediği aralıklarla
   geçmişi yenileyin. Commit sonrası yayın kaybı, bağlantı kopmadan da oluşabilir.

Gönderirken UUID'yi bir kez üretin; timeout'ta aynı UUID **ve aynı ham metinle** tekrar
deneyin. Yeni bir mesaj farklı UUID kullanır. Örnek:

```typescript
const payload = { sessionId, clientMessageId: crypto.randomUUID(), text };
const ack = await socket.timeout(10_000).emitWithAck("support:message:send", payload);
// TR: Ağ timeout'unda aynı payload tekrar kullanılır. EN: Reuse this payload after timeout.
// TR: ack.ok false bir servis hatasıdır. EN: ack.ok false is a service error, not a transport timeout.
```

## Doğrulama ve sınırlar

`api` içinde `npm run typecheck`, `npm test`, `npm run build` kullanılır. Mevcut
132 test; 20 eşzamanlı mesaj tekrarı, Unicode sınırı, HMAC çakışma kontrolü,
maskeleme/yazım hataları, kapanış yarışı, cursor doğrulama, HTTP yetkisi, gerçek
Socket.IO yayını, iptal edilmiş alıcı ve yeniden bağlantı sonrası geçmişi kapsar.

Ana uygulama/start komutu, gerçek JWT/DB/queue/redaction adaptörleri, gateway rate
limit'i ve dağıtık yayın henüz bu modüllere bağlanmadı. `app.ts`, ana `index.ts`
ve Prisma şeması bu iki bölümde değiştirilmedi. Yeni kod yorumları TR/EN'dir.

Socket.IO'nun varsayılan teslim davranışı ve sunucu odaları için resmi kaynaklar:
[Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/),
[Rooms](https://socket.io/docs/v4/rooms/).
