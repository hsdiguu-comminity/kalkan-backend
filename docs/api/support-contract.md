# Canlı destek sözleşmesi — Bölüm 1

**Durum:** Ekip incelemesine açık sözleşme taslağı. Bağlantı altyapısı Bölüm 2'de
uygulandı; Bölüm 3 devir servisini ve dört HTTP yolunu ekler. Mesajlaşma ve gerçek
auth/DB/kuyruk entegrasyonları henüz tamamlanmadı.
**Sorumlu:** Hasti (Kullanıcı-4).
**Planlanan branch:** `feature/backend-live-support`.

Görev dağılımı PDF'sinin 2–3. sayfaları Hasti'ye Socket.IO sunucusunu,
asistandan uzmana devir akışını ve uzman–kullanıcı mesajlaşmasını atar.
PDF belirli URL'ler, olay adları, rol değerleri veya veritabanı modelleri vermez.
Bu belgede bunlar uygulama için **önerilen kararlar** olarak tanımlanmıştır.
HTTP ve veri şemalarının kaynağı [openapi.yaml](openapi.yaml) dosyasıdır.

## 1. Kapsam ve dosyalar

| Sonraki bölümlerde yazılacak dosya | Sorumluluk |
| --- | --- |
| `api/src/sockets/index.ts` | Socket.IO kurulumu, kimlik doğrulama, bağlantı yaşam döngüsü |
| `api/src/sockets/support.socket.ts` | Odaya katılma, mesaj doğrulama, ack ve olay yayını |
| `api/src/modules/support/support.routes.ts` | Aşağıdaki HTTP işlemleri ve Zod doğrulaması |
| `api/src/modules/support/handoff.service.ts` | Devir, yetkili durum geçişleri ve entegrasyonlar |

Bu bölüm yalnızca sözleşmeyi hazırlar. `app.ts`, `index.ts`, auth, chat,
Prisma, kuyruk ve bildirim uygulamaları ilgili ekip üyelerinin sorumluluğundadır.
Socket.IO kurulumunun HTTP sunucusuna bağlanması Amir Ali ile yapılacaktır.

## 2. Oturum akışı

1. Kullanıcı kendi AI sohbetinden destek ister. `POST /support/handoffs`,
   `conversationId` alır ve sohbetin sahibini chat katmanından doğrular.
2. Oturum `queued` oluşturulur. Oturum ve kuyruk teslim kaydı aynı kalıcı işlemde
   yazılır. Seyit'in kuyruğuna teslim tekrar denenebilir ve oturum kimliğiyle tekilleştirilir.
3. Uygun uzman, kuyruk katmanından aldığı oturum kimliğiyle `/accept` çağırır.
   Uygunluk ve atomik atama sonucunda oturum `active` olur.
4. Kullanıcı ve atanmış uzman yetkili odaya katılır; mesajlar kalıcı kaydedilip yayınlanır.
5. Kullanıcı veya atanmış uzman `/close` çağırır; oturum `closed` olur.

| Başlangıç | İşlem / yetki | Sonuç |
| --- | --- | --- |
| Oturum yok | Sohbet sahibi destek ister | `queued`, `agentId = null`, `revision = 1` |
| `queued` | Kuyruğun uygun bulduğu uzman kabul eder | `active`, uzman atanır, revision artar |
| `queued` | Oturum sahibi kapatır | `closed`, `closeReason = user_closed` |
| `active` | Oturum sahibi / atanmış uzman kapatır | `closed`, aktöre göre kapanış nedeni |
| `closed` | Yetkili katılımcı yeniden kapatır | Aynı kapalı oturum; revision değişmez |

Her değişiklikte `updatedAt` ve `revision` güncellenir. `createdAt` sabittir.
`queued` ve `active` durumunda `closedAt`/`closeReason` null olur.
`closed` durumunda ikisi de doludur; atanmış uzman varsa `agentId` korunur.
Zamanlar sunucunun ürettiği UTC RFC 3339 değerleridir.

MVP önerisi: bir AI sohbetinin yalnızca bir destek oturumu vardır. Aynı sohbet
için queued/active devir isteği mevcut oturumu döndürür; closed oturum için
`SESSION_CLOSED` döner. Yeni destek görüşmesi yeni sohbetle başlar. Yeniden açma,
uzman değiştirme ve otomatik kapanma bu ilk sözleşmenin kapsamı dışındadır.

Bir bağlantının kopması oturumu kapatmaz veya uzman atamasını kaldırmaz.
Uzman yoksa oturum queued kalır; kullanıcı bekleyebilir veya kapatabilir.
Bekleme süresi/konumu bu taslakta taahhüt edilmez; kuyruk ve ticket politikası Seyit'e aittir.

## 3. HTTP işlemleri

Tüm yollar ana API köküne göredir. Önek/port henüz belirlenmedi.
İsteklerde `Authorization: Bearer <accessToken>` kullanılır.

| Yöntem ve yol | Girdi | Başarılı yanıt |
| --- | --- | --- |
| `POST /support/handoffs` | `{ conversationId }` | Yeni kayıt `201`, mevcut açık kayıt `200`; `SupportSession` |
| `GET /support/sessions/{sessionId}` | Yol kimliği | `200 SupportSession` |
| `GET /support/sessions/{sessionId}/messages` | `afterSequence=0`, `limit=50` (en çok 100) | `200 MessagePage` |
| `POST /support/sessions/{sessionId}/accept` | Gövde yok | `200 SupportSession` |
| `POST /support/sessions/{sessionId}/close` | Gövde yok | `200 SupportSession` |

Örnek devir gövdesi:

```json
{ "conversationId": "chat_example_1" }
```

Mesajlar `sequence` artan sırada döner. `nextAfterSequence` son dönen mesajın
sırasıdır; boş sayfada girişteki `afterSequence` korunur. `hasMore = true` ise
sonraki istek bu sıra değeriyle yapılır. `hasMore = false`, gelecekte mesaj
gelmeyeceği anlamına gelmez. AI geçmişi bu listede çoğaltılmaz; atanmış uzmanın
AI geçmişine erişimi Furkan ile ayrıca bağlanır.

## 4. Kimlik ve erişim

Önerilen rol değerleri `user`, `expert`, `admin`; kesin JWT alan adları auth ekibiyle
eşleştirilecektir. İstemcinin gönderdiği rol, senderId, userId veya agentId güvenilmez.
Bu alanlar istemci istek şemalarında bulunmaz; bilinmeyen alanlar reddedilir.

| İşlem | İzin |
| --- | --- |
| Devir başlatma | Yalnızca sohbet sahibi `user` |
| Kabul etme | Yalnızca kuyruk tarafından uygun bulunan `expert` |
| Durum, geçmiş, odaya katılma | Oturum sahibi veya atanmış uzman |
| Yeni mesaj | Yalnızca `active` oturumun sahibi veya atanmış uzman |
| Kapatma | Oturum sahibi; active/closed oturumda atanmış uzman |

Rol uygun değilse `403 FORBIDDEN`; rol uygun olup kaynak kendisine ait değilse
`404 NOT_FOUND` verilir. Admin olmak tek başına konuşmalara erişim sağlamaz.
Atanmamış uzman görüşme içeriğini veya AI geçmişini okuyamaz.
Kuyruktan aday listeleme bu API'nin parçası değildir; Seyit'in entegrasyonundan gelir.

Her HTTP isteği ve socket komutunda kimlik, kaynak erişimi ve oturum durumu yeniden
kontrol edilir. Odaya daha önce katılmış olmak sonraki işlemlere otomatik izin vermez.
Token süresi dolan socket, artık yayın alamadan odalardan çıkarılır ve kapatılır;
istemci auth modülünden yeni token alıp yeniden bağlanır. Token iptalinin aktif
bağlantılara nasıl iletileceği auth entegrasyonunda kesinleştirilecektir.

## 5. Socket.IO sözleşmesi

Namespace `/support`, taşıma yolu `/socket.io` önerilir; bunlar farklı kavramlardır.
JWT bağlantıda `handshake.auth.token` içinden alınır; URL sorgusuna yazılmaz.
İzin verilen web origin'leri gateway yapılandırmasından gelir.
Şemalar OpenAPI `components/schemas` altında ortak tanımlıdır; `x-socketio`
özel uzantısı olay–şema eşlemesini içerir. Bu uzantı standart OpenAPI HTTP işlemi değildir.

### İstemci → sunucu

| Olay | Girdi şeması | Ack şeması |
| --- | --- | --- |
| `support:join` | `JoinSupportRequest` | `SessionAck` |
| `support:message:send` | `SendSupportMessageRequest` | `MessageAck` |

`support:join`, sunucunun türettiği `support:session:<sessionId>` odasına yalnızca
yetkili katılımcıyı ekler. Oda adı istemciden alınmaz. Tekrar katılmak güvenlidir.
Sunucu önce yetkiyi doğrular, odaya ekler ve sonra güncel oturum görünümünü ack ile
döner; araya giren olaylarda istemci `revision` ile eski görünümü eler.
Mesaj göndermek odaya katılmış olmayı gerektirmez, fakat her gönderim bağımsız
yetkilendirilir. Odaya katılım karşı tarafın yayınlarını almak için gereklidir.
Devir/kabul/kapatma HTTP üzerinden yapılır; aynı işlemler için ikinci socket komutu yoktur.

```json
{
  "sessionId": "support_example_1",
  "clientMessageId": "8b841b65-1249-4de9-a7bc-0d676ff47ff1",
  "text": "Bu mesajın güvenli olup olmadığını anlamak istiyorum."
}
```

Her komut callback ack ister; callback yoksa hiçbir durum değişikliği yapılmaz,
`support:error` ile `INVALID_PAYLOAD` gönderilir. Başarı `{ "ok": true, "data": ... }`,
hata `{ "ok": false, "error": { "code": "...", "message": "..." } }` biçimindedir.
Join ack `SupportSession`, gönderim ack `SupportMessage` içerir.
Başarı ack'i veritabanına kayıt tamamlandıktan sonra gönderilir; karşı tarafın
mesajı aldığı veya okuduğu anlamına gelmez. Bu sürümde okundu/teslim edildi olayı yoktur.

### Sunucu → istemci

| Olay | Veri | Hedef |
| --- | --- | --- |
| `support:session:updated` | Tam `SupportSession` | İlgili oturum odası |
| `support:message:created` | Tam `SupportMessage` | Gönderen dahil ilgili oturum odası |
| `support:error` | `SupportError` | Yalnızca ilgili socket; ör. token süresi dolması |

İlk bağlantının reddi Socket.IO `connect_error` üzerinden bildirilir; `error.data`
bir `SupportError` içerir. Bağlantı kurulmadan uygulama olayına güvenilmez.
Aktif bağlantıda token süresi dolarsa `support:error` için en iyi gayret gösterilir
ve bağlantı kapatılır; istemci yalnızca bu olayın teslimine güvenmez.

### Sıralama, tekrar ve yeniden bağlantı

- `id`, `senderId`, `senderRole`, `sequence`, `createdAt` sunucu tarafından üretilir.
- `text` 1–4000 Unicode kod noktasıdır; yalnızca boşluk içeren içerik reddedilir.
  JavaScript UTF-16 uzunluğu yerine kod noktası sayımıyla aynı sınır uygulanmalıdır.
  Metin düz metindir; istemci HTML olarak yorumlamaz. Ek/dosya desteği bu kapsamda yoktur.
- `clientMessageId` istemcinin bir kez oluşturduğu UUID'dir. Veritabanında
  `(sessionId, senderId, clientMessageId)` benzersizdir. Aynı anahtar ve aynı metin
  yeniden gelirse aynı kayıt ack ile döner; yeni kayıt/yayın oluşturulmaz.
  Aynı anahtar farklı metinle gelirse `MESSAGE_ID_CONFLICT` döner.
- Yetki kontrolünden sonra tekrar kaydı aranır. Önceden kabul edilmiş mesaj,
  oturum sonradan kapansa bile aynı sonuçla dönebilir; yeni mesaj kapalı oturumda reddedilir.
- Maskeleme yapılırsa tekrar karşılaştırması için ham içerik saklanmaz; sunucuya
  ait gizli anahtarla üretilen içerik HMAC'i kullanılması önerilir. Anahtar yönetimi
  ve maskeleme sürümü Eren ile netleştirilir; token/metin uygulama loglarına yazılmaz.
- `sequence` oturum başına artar ve kalıcı depoda benzersizdir; arada boşluk olabilir.
  UI, ack ve yayından gelen aynı mesajı `id` ile tekilleştirir, sequence ile sıralar.
- İstemci ack zaman aşımında yeni kimlik üretmez. Önerilen başlangıç: 10 saniye
  bekleme, aynı kimlikle en çok 3 otomatik tekrar; sonra kullanıcıya yeniden deneme
  gösterilir. Bunlar ayarlanabilir istemci tercihleri, servis süre garantisi değildir.
- Yeniden bağlanınca önce `support:join`, sonra kayıtlı son geçmiş imlecinden
  HTTP geçmiş isteği yapılır. Canlı yayınlar arada tamponlanır ve `id` ile birleştirilir.
  Kalıcı geçmiş imleci yalnızca HTTP sayfalarının `nextAfterSequence` değerinden
  ilerletilir; rastgele canlı olaydan ilerletilmez. Böylece eksik olay atlanmaz.
- `hasMore` bitene kadar geçmiş tamamlanır. Oturum görünümünde yalnızca daha yüksek
  `revision` uygulanır. Kayıttan sonra yayın başarısız olursa veri geçmişten alınır.
  Bu taslak ağ üzerinden tam bir kez teslim garantisi vermez.

## 6. Hatalar ve yarış durumları

HTTP hata gövdesi `{ "error": { "code": "...", "message": "..." } }` biçimindedir.
Mesaj Türkçedir; istemci mantığı `code` alanını kullanır.

| Kod | HTTP karşılığı | Anlam |
| --- | --- | --- |
| `INVALID_PAYLOAD` | 400 | Eksik/geçersiz/fazladan alan, boş metin, geçersiz sayfalama |
| `UNAUTHENTICATED` | 401 | Kimlik bilgisi yok, geçersiz veya süresi dolmuş |
| `FORBIDDEN` | 403 | İşlem için yanlış rol |
| `NOT_FOUND` | 404 | Kaynak yok veya kaynak erişimi yok |
| `SESSION_CLOSED` | 409 | Kapalı oturumda devir, kabul veya yeni mesaj |
| `SESSION_NOT_ACTIVE` | Socket ack | Queued oturumda yeni mesaj |
| `ALREADY_ASSIGNED` | 409 | Başka uzman atomik kabul yarışını kazandı |
| `MESSAGE_ID_CONFLICT` | Socket ack | Aynı istemci kimliği farklı içerikle kullanıldı |
| `RATE_LIMITED` | 429 | Sınır aşıldı; `retryAfterSeconds`, HTTP'de ayrıca `Retry-After` |
| `SERVICE_UNAVAILABLE` | 503 | Gerekli kalıcı depo/entegrasyon kullanılamıyor |
| `INTERNAL_ERROR` | 500 | Beklenmeyen hata; teknik ayrıntı istemciye verilmez |

İki uzman aynı anda kabul ederse yalnızca bir atama yapılır. Kabul/kapatma ve
mesaj/kapatma yarışları da aynı kalıcı oturum durumu üzerinde sıralanır.
Kapatmadan önce kaydedilmiş mesaj korunur; kapatmadan sonra yeni mesaj kaydedilmez.
Kapalı oturumun gecikmiş kuyruk işi atama oluşturamaz. Tekrar edilen işlemler
revision artırmaz veya ikinci yan etki üretmez.

## 7. Ekip entegrasyonları ve açık kararlar

| Kişi | Birlikte kesinleştirilecek konu |
| --- | --- |
| İrem Karabıyık | OpenAPI yolları, hata zarfı ve bu önerilen sözleşmenin değerlendirilmesi |
| Amir Ali / Buse | JWT alanları, roller, token iptali, Socket.IO kurulumu, origin ve istek sınırları |
| Furkan | Sohbet sahipliği, AI geçmişi erişimi, güvenilir iç devir çağrısı, AI yanıtlarının durdurulması |
| Seyit | Kalıcı kuyruk teslimi, uygun uzman kontrolü, kabul yarışı, iptal, ticket ve bildirim bağlantısı |
| Eren | Oturum/mesaj modelleri, transaction ve benzersizlikler, maskeleme, saklama politikası |
| Web / Android ekipleri | Namespace, ack, tekrar, geçmiş imleci ve kullanıcıya gösterilen durumlar |

AI otomatik devir önerisi dış istemcinin `source` alanıyla tetiklenmez. Furkan'ın
güvenilir sunucu kodu, sohbetin sahibini doğrulayarak handoff servisini çağırır;
`source = assistant_escalation` yalnızca bu yolda sunucuda atanır. Bu iç yolun
kimlik/çağrı biçimi entegrasyon aşamasında belirlenir; genel bir HTTP endpoint açılmaz.
Öneri: queued/active boyunca aynı sohbette AI yanıt üretimi durur; closed oturum
AI'yi otomatik yeniden başlatmaz. Bu davranış Furkan ile doğrulanmalıdır.

Veritabanı gereksinimleri: conversationId başına tek oturum, mesaj tekrar anahtarı
için unique kısıt, `(sessionId, sequence)` unique kısıtı, durum değişimlerinin
atomik yapılması ve kuyruk tesliminin kalıcı yeniden deneme kaydı. Bunlar burada
gereksinimdir; henüz Prisma migration veya çalışan kuyruk uygulanmamıştır.

## 8. Sonraki bölümlerin kabul senaryoları

- Sahibi olmayan kullanıcı bir sohbeti devredemez, odaya katılamaz veya geçmişini okuyamaz.
- Sahte senderId/rol ve bilinmeyen alanlar reddedilir; kimlik yalnızca sunucudan gelir.
- Aynı sohbet için eşzamanlı devir istekleri tek oturum ve tek kuyruk işi oluşturur.
- İki uzman yarıştığında bir uzman atanır; kaybeden içerik erişimi kazanmaz.
- Queued oturumda mesaj reddedilir; active oturumda iki yetkili taraf mesajlaşabilir.
- Aynı mesaj tekrarında tek kayıt oluşur; farklı içerikte kimlik çakışması reddedilir.
- Kayıt sonrası ack kaybolursa tekrar aynı kaydı verir; kapanış sonrası tekrar da korunur.
- Kesinti sonrası geçmiş sayfalaması canlı olaylarla birleşir; mesaj atlanmaz/çoğalmaz.
- Yetkisiz oda, token süresi dolması ve yayın anında bağlantının kapanması sınanır.
- Kuyruk/depo hatasında sahte başarı dönmez; yeniden deneme kayıtları doğrulanır.
- Kapatma/kabul/gönderim yarışları ve kapanmış oturuma geciken işler sınanır.

Bu liste devir ve mesajlaşma için planlanan kabul senaryolarını da içerir; tamamı
henüz uygulanmış değildir. Bölüm 1 sözleşme dosyalarını, [Bölüm 2](support-socket-setup.md)
Socket.IO bağlantı modülünü ve bağlantı testlerini sağlar. [Bölüm 3](support-handoff-setup.md)
devir servisini, dört HTTP yolunu ve transaction testlerini ekler. Paket ve TypeScript
ayarları eklendi; ana HTTP uygulaması, gerçek auth/DB adaptörleri ve Git deposu henüz yoktur.
