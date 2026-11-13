# Asistandan uzmana devir — Bölüm 3

**Sorumlu:** Hasti. **Durum:** Servis mantığı ve dört Express router işlemi hazır;
gerçek auth, chat, PostgreSQL ve BullMQ adaptörlerine bağlanmayı bekliyor.
Önerilen yol ve veri modeli kararları Bölüm 1'deki taslağa dayanır.

## Eklenen dosyalar

| Dosya | İşlev |
| --- | --- |
| `api/src/modules/support/handoff.service.ts` | Girdi doğrulama, erişim ve durum geçişleri; transaction/outbox arayüzleri |
| `api/src/modules/support/support.routes.ts` | Auth adaptörüne bağlanan dört HTTP işlemi ve JSON hata zarfı |
| `api/tests/support/handoff.service.test.ts` | Tekrar, yetki, yarış ve rollback testleri |
| `api/tests/support/support.routes.test.ts` | Supertest ile HTTP akışı ve hata yanıtları |
| `api/tests/support/helpers/handoff.fixture.ts` | Yalnızca testlerde kullanılan seri, rollback destekli bellek deposu |

`app.ts`, ana `index.ts`, Prisma şeması ve Seyit'in kuyruk dosyaları değiştirilmedi.
Express çalışma zamanı, Supertest ve tip paketleri geliştirme bağımlılığı olarak eklendi.

## Çalışan servis davranışları

- Kullanıcı yalnızca kendi sohbetinden devir başlatabilir. `userId`, `agentId`,
  `source` gibi istemci alanları kabul edilmez. Sahiplik chat adaptöründen doğrulanır.
- İlk devir queued oturum ve `support.queued` outbox kaydı oluşturur. Tekrar aynı
  queued/active oturumu döner; kapalı sohbetin oturumu yeniden açılmaz.
- `requestAssistantHandoff({ conversationId })` yalnızca güvenilir sunucu kodu içindir.
  Kullanıcı kimliğini chat kaynağından alır; `source = assistant_escalation` sunucuda
  belirlenir. Bu fonksiyonun public HTTP karşılığı yoktur.
- Yalnızca geçerli teklif sahibi uzman kabul edebilir. Aynı oturuma iki uzmandan
  biri atanır. Kazananın tekrarı yeni revision veya olay üretmez.
- Sahip veya atanmış uzman oturumu kapatabilir. Queued oturumu yalnızca sahibi
  iptal edebilir. Tekrar kapanış aynı sonucu döner; admin ayrıcalığı verilmez.
- Her gerçek değişiklik revision artırır ve aynı transaction'da tek outbox olayı
  üretir. Yazım başarısızsa başarı sonucu döndürülmez.
- Yanıtlar şema kontrolünden geçirilir; ham adapter exception veya stack istemciye verilmez.

## HTTP entegrasyonu

Router `/support` altında bağlanır:

| İşlem | Sonuç |
| --- | --- |
| `POST /support/handoffs` | İlk istek 201, açık oturumun tekrarı 200 |
| `GET /support/sessions/:sessionId` | Yetkili katılımcıya güncel oturum |
| `POST /support/sessions/:sessionId/accept` | Uzman kabulü; aynı uzmanın tekrarı 200 |
| `POST /support/sessions/:sessionId/close` | Kapatma; yetkili tekrar 200 |

Devir gövdesi yalnızca `{ "conversationId": "..." }` içerir. Diğer üç işlemde gövde,
bu dört yolda sorgu parametresi kabul edilmez. Router JSON gövdesini en fazla 8 KiB
olarak ayrıştırır; bozuk JSON, farklı içerik türü, sıkıştırılmış gövde ve boyut aşımı
`400 INVALID_PAYLOAD` döner. Tüm yanıtlar `Cache-Control: no-store` kullanır.
401 yanıtında `WWW-Authenticate: Bearer` vardır.

Örnek entegrasyon biçimi; aşağıdaki adapter değişkenleri ekip tarafından sağlanmalıdır:

```typescript
import { createHandoffService } from "./modules/support/handoff.service.js";
import { createSupportRouter } from "./modules/support/support.routes.js";

const handoff = createHandoffService({
  store: supportDatabaseAdapter,
  conversations: chatOwnershipAdapter,
});

app.use("/support", createSupportRouter({
  service: handoff,
  resolvePrincipal: resolveVerifiedHttpPrincipal,
}));
```

`resolvePrincipal(request)` auth middleware'inin doğruladığı kullanıcıyı döndürür:
`{ userId, role, expiresAt }`. expiresAt Unix milisaniyesidir. Kimlik bulunmazsa
`null` döner; altyapı hatasında throw eder. **Body/query veya doğrulanmamış JWT decode
sonucu kullanılmaz.** JWT imzası, issuer, audience, iptal ve süre kontrolü auth
adaptörünün sorumluluğudur. Adapter timeout ve istek rate limit'i gateway'de uygulanır.
Router aktörü yeniden şema/süre kontrolünden geçirir; bu kontrol imza doğrulamaz.

Router kendi JSON parser'ını kullanır. Genel bir parser daha önce kurulmuşsa genel
parser hatalarının ortak hata middleware'inde de JSON olarak karşılanması gerekir.
Mesaj geçmişi `GET /support/sessions/:sessionId/messages` bu bölümde uygulanmadı.

## Eren: kalıcı transaction adaptörü

`SupportStore.transaction(work)` üretim için zorunludur; varsayılan bellek deposu yoktur.
`work(tx)` şu fonksiyonları kullanır:

| Fonksiyon | Gereken garanti |
| --- | --- |
| `findByConversationId` | Yokluk dahil aynı conversationId için eşzamanlı oluşturmayı korur |
| `findById` | Kabul/kapatma yarışlarında tutarlı, kilitli veya serializable görünüm |
| `hasAgentOffer` | Uzmanın geçerli teklifini aynı transaction içinde kontrol eder |
| `saveSession` | Oturumu aynı transaction'a yazar |
| `appendOutbox` | Teslim olayını aynı transaction'a yazar; olay kimliği benzersiz |

Başarılı callback **commit tamamlanmadan** dönülmüş sayılmaz. Callback veya commit
hatasında oturum ve outbox birlikte rollback edilmelidir. Serializability/unique
yarışlarında adaptör callback'i sınırlı sayıda yeniden çalıştırmalıdır; ardından
uygun servis hatası dönmelidir. `conversationId` için unique constraint gerekir.
Yalnızca mevcut satıra row lock koymak, henüz olmayan iki oturumun oluşturulmasını
engellemez; o yarış da korunmalıdır. Aynı kurallar birden çok uygulama sürecinde geçerlidir.

Bu servisin callback'lerinde dış ağ servisine yan etki yapılmaz; tekrar çalıştırılabilir.
Gelecekteki mesaj yazımı da kabul/kapatmayla aynı oturum kilidi veya transaction
sıralamasına katılmalıdır. Şu anki testler SQL/Prisma transaction davranışını kanıtlamaz;
gerçek adaptör eklendiğinde bu senaryolar PostgreSQL üzerinde tekrar doğrulanmalıdır.

## Seyit: uzman teklifi ve outbox tüketimi

`hasAgentOffer(sessionId, agentId)` uzmanı o görüşmeyi kabul etmeye yetkili kılan
teklifi kontrol eder; "oturum hâlâ queued mı?" sorusunun cevabı değildir.
Durum kontrolünü servis yapar. Aynı anda teklif almış iki uzmandan kaybeden geçerli
teklifini taşıyorsa `409 ALREADY_ASSIGNED` alır; teklifi olmayan kişiye 404 döner.
Atanmış uzmanın tekrarı için teklifin hâlâ bulunması gerekmez.
Teklifin süre/iptal/kapasite kuralları kuyruk adaptöründe atomik olarak sağlanmalıdır.

Önerilen outbox kayıtları:

| type | Tüketicinin işi |
| --- | --- |
| `support.queued` | Kuyruk talebi oluşturma, AI üretimini durdurma entegrasyonu |
| `support.accepted` | Kuyruk beklemesini bitirme, katılımcılara durum bildirimi |
| `support.closed` | Kuyruk işini iptal/geçersiz kılma, kapanışı bildirme |

Olay kimliği `support:<sessionId>:<revision>` biçimindedir. Olay tam oturum
görünümünü içerir; sohbet metnini içermez. Tüketici olay kimliğiyle tekilleştirmeli,
teslimi kalıcı takip etmeli ve başarısız teslimi tekrar denemelidir. İşlem sırasında
**güncel oturum durumunu/revision'ı kontrol etmelidir**: geç ulaşan queued olayı
kapatılmış/atanmış oturumu yeniden kuyruğa sokamaz. Olayların sırasız veya tekrar
teslimi mümkün kabul edilir. Outbox satırını yazmak BullMQ'ya teslim edildiği anlamına gelmez.

Bu bölüm outbox arayüzünü ve ona yazan servis mantığını içerir; kalıcı tablo,
dispatcher, BullMQ işi ve Socket.IO durum yayını henüz uygulanmadı. API 201,
adaptör bağlandığında oturum ve teslim kaydı commit edildi demektir; uzman atandı demek değildir.

## Furkan: sohbet sahipliği ve AI devri

`conversations.getOwnerId(conversationId)` sohbetin gerçek sahibini veya null döndürür.
Servis sahiplik sorgusunu transaction öncesi yapar; sohbet sahipliği değişmez kabul
edilir. Sohbet silme/erişim kaldırma politikası değişirse ortak transaction veya
erişim sürümüyle tekrar kontrol entegrasyonu gerekir.
AI için yalnızca güvenilir sunucu kodu `handoff.requestAssistantHandoff(...)` çağırır.
AI üretiminin gerçekten durdurulması outbox/chat entegrasyonuna bağlıdır; bu aşamada
AI servisine çağrı yapılmaz ve durdurulmuş olduğu varsayılmaz.

## Doğrulama ve kalan işler

`api` içinde `npm run typecheck`, `npm test`, `npm run build` çalıştırılır.
Testler aynı sohbet için 20 eşzamanlı istek, iki uzman yarışı, iki sırada kabul/kapanış
yarışı, outbox hatasında oluşturma/atama/kapanış rollback'i, izinler, süre aşımı,
HTTP hata zarfı ve tekrar çağrıların etkisizliğini kapsar.

Test deposu yalnızca `api/tests/` altındadır ve üretim build'ine dahil edilmez.
Çalışan tam uygulama için gerçek auth/chat/DB/kuyruk adaptörleri ve ana giriş
bağlantısı gerekir. Sonraki bölüm: yetkili Socket.IO odaları, kullanıcı–uzman
mesajlaşması ve mesaj geçmişi.

Router ve asenkron hata yönetimi için resmi kaynaklar:
[Express routing](https://expressjs.com/en/guide/routing/),
[Express error handling](https://expressjs.com/en/guide/error-handling/).
