# Canlı destek bağlantı altyapısı — Bölüm 2

**Sorumlu:** Hasti. **Durum:** TypeScript modülü ve yerel bağlantı testleri hazır.
Namespace ve mesaj adları Bölüm 1'deki önerilen sözleşmeye dayanır; ekipçe onaylanmış
bir üretim API'si olduğu iddia edilmez.

## Tamamlanan kapsam

`api/src/sockets/index.ts`, dışarıdan verilen Node HTTP/HTTPS sunucusuna Socket.IO
ekler. `/support` namespace'i ve `/socket.io` taşıma yolu kullanılır.
Bu modül kendi portunu açmaz. `app.ts` ve ana `index.ts` için değişiklik yapılmadı.

- Token yalnızca `handshake.auth.token` alanından alınır; eksik, fazla veya hatalı
  handshake alanları reddedilir. Token socket verisine veya loglara yazılmaz.
- Auth ekibinin `verifyAccessToken` adaptörü zorunludur; kabul eden bir varsayılan
  veya yalnızca JWT decode eden alternatif yoktur.
- Doğrulanmış kullanıcı kimliği, rolü ve son kullanma zamanı Zod ile kontrol edilir.
- Her istemci komutundan önce token tekrar doğrulanır. Kimlik/rol değişirse komut
  işleyiciye ulaşmaz ve bağlantı kesilir. Kaynak/oda yetkisi sonraki iş katmanına aittir.
- Token'ın süresi dolunca boşta duran bağlantı da kesilir. Uzun süreler Node timer
  sınırını aşmayacak parçalara bölünür; ayrılmada timer ve odalar temizlenir.
- Auth çağrısı varsayılan 5 saniyede zaman aşımına uğrar. Ayrılma/kapanış/zaman aşımı
  adaptöre `AbortSignal` ile iletilir. Adaptör kendi ağ isteğini bu sinyalle iptal etmelidir.
- Müşteriye auth servisinin exception/stack/token içeriği verilmez. Geçersiz token
  `UNAUTHENTICATED`, auth altyapı hatası/zaman aşımı `SERVICE_UNAVAILABLE` olur.
- Origin listesi hem polling hem WebSocket el sıkışmasına uygulanır. Namespace `/`
  reddedilir. İstemci paketi sunucudan dağıtılmaz; giriş paketi sınırı 64 KiB'dir.

Devir [Bölüm 3'te](support-handoff-setup.md) uygulandı. Kuyruk, veritabanı,
destek odasına katılma ve mesaj gönderme bu bölümde uygulanmadı.
`support:join` / `support:message:send` işleyicileri sonraki bölümlerde
`registerHandlers` üzerinden bağlanacaktır. Şu an bu komutlardan başarı yanıtı beklenmez.

## Yerel kontrol

Proje kökündeki `api` klasöründe:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 24+ kullanılır. `package-lock.json` sürümleri sabitler; çalışma zamanı
bağımlılıkları Socket.IO ve Zod'dur. Socket.IO client ve Vitest testler içindir;
TypeScript ve Node tipleri derleme içindir. `dist/`, `node_modules/` repoya eklenmez.

Testler yerel `127.0.0.1` adresinde rastgele port açar, gerçek Socket.IO istemcisiyle
bağlanır ve bitince sunucuyu kapatır. Harici auth/DB servisi kullanılmaz.
Test adaptörünün döndürdüğü kullanıcılar yalnızca test dosyasındadır.

## Amir Ali / Buse için sunucuya bağlama

Aşağıdaki örnek ana girişte yapılacak entegrasyonun biçimini gösterir; hazır bir
Express uygulaması ve gerçek token doğrulama fonksiyonu gerektirir:

```typescript
import { createServer, type RequestListener } from "node:http";
import {
  createSupportSocketServer,
  type SupportSocketOptions,
} from "./sockets/index.js";

export function prepareServer(
  app: RequestListener,
  verifyAccessToken: SupportSocketOptions["verifyAccessToken"],
  allowedOrigins: string[],
) {
  const httpServer = createServer(app);
  const support = createSupportSocketServer(httpServer, {
    allowedOrigins,
    allowRequestsWithoutOrigin: true, // Android istemcisi için bilinçli tercih.
    verifyAccessToken,
  });
  return { httpServer, support };
}
```

Portu ana giriş `httpServer.listen(...)` ile açar; aynı sunucuya ikinci bir
Socket.IO örneği eklenmez. Kapanışta `await support.close()` çağrılır. Bu çağrı
Socket.IO **ve bağlı HTTP sunucusunu** kapatır; tekrar çağrıldığında aynı Promise döner.

`verifyAccessToken(token, { signal })` geçerli kimlik için yalnızca şu alanları döndürür:

```typescript
type VerifiedPrincipal = {
  userId: string;
  role: "user" | "expert" | "admin";
  expiresAt: number; // Unix milisaniyesi; JWT exp saniye ise exp * 1000.
};
```

Adaptör JWT imzasını, izin verilen algoritmayı, issuer/audience, süre ve iptal
durumunu doğrulamalıdır. Geçersiz/iptal edilmiş token'da `null`; servis arızasında
exception döner. Mevcut JWT rol/kimlik alanları bu şekle auth katmanında çevrilir.
Tam kullanıcı kaydı doğrudan döndürülmez. Bir token için expiresAt her kontrolde
aynı olmalıdır; yeni token ile yeni bağlantı kurulur.

`registerHandlers(socket)` senkron bir kurulum fonksiyonudur. İçindeki asenkron iş
olayları kendi doğrulama, kaynak yetkisi ve hata/ack yönetimini yapmalıdır; bu
fonksiyonun tamamlanmamış bir Promise döndürmesine güvenilmez.

## Web / Android bağlantısı

Web tarafında istemci örneği (adres ve token uygulama tarafından sağlanır):

```typescript
import { io } from "socket.io-client";

const socket = io(`${apiBaseUrl}/support`, {
  path: "/socket.io",
  auth: { token: accessToken },
});

socket.on("connect_error", (error) => {
  // Uygulama error.data?.code üzerinden giriş/yeniden deneme akışını seçer.
});
socket.on("support:error", (error) => {
  // UNAUTHENTICATED durumunda auth modülünden yeni token alınır.
});
```

Sunucunun kestiği bağlantıda yeni token alındıktan sonra `socket.auth` güncellenir
ve `socket.connect()` çağrılır. Origin göndermeyen Android istemciler varsayılan
olarak kapalıdır; `allowRequestsWithoutOrigin: true` ile açılır, JWT yine zorunludur.
Origin kontrolü kimlik doğrulamanın yerine geçmez. Origin değerleri tam eşleşir:
örneğin `https://kalkan.example`; wildcard, yol ve sondaki `/` kabul edilmez.

## Sınırlar ve sonraki bağlantılar

- Bu aşama JWT üretmez/doğrulama algoritması yazmaz; gerçek auth adaptörünün
  güvenliği bu yerel testlerle doğrulanmış değildir.
- `disconnectUser(userId)` yalnızca bu süreçteki mevcut bağlantıları keser ve
  sayısını döndürür. Auth ekibi önce token'ı iptal etmeli, sonra bu metodu çağırmalıdır.
  Süre dolması dışında boşta duran bağlantıların anlık iptali için bu bildirim gerekir.
  Bekleyen doğrulamalar ve yeniden bağlanmalar auth adaptörünün iptal kontrolüne dayanır.
- Çok süreçli dağıtım için Redis adapter ve tüm süreçlere iptal bildirimi henüz yoktur.
- IP/kullanıcı bazlı hız sınırları Amir Ali'nin gateway katmanıyla bağlanacaktır;
  paket boyutu ve auth zaman aşımı tek başına rate limiting değildir.
- Admin bağlantısı açılabilmesi konuşma erişimi vermez. Oturum/oda/mesaj yetkileri
  sonraki bölümde ayrı kontrol edilir. Bu aşamada hiçbir konuşma odası açılmaz.
- Bölüm 3'te dört HTTP yolu ve devir servisi eklendi. Gerçek DB/kuyruk ve ana
  uygulamaya bağlantı halen beklenir. Mesaj geçmişi ve mesaj kalıcılığı sonraki bölümdedir.

Kurulum, middleware ve Origin kontrolünde kullanılan resmi kaynaklar:
[Socket.IO middleware](https://socket.io/docs/v4/middlewares/),
[CORS ve allowRequest](https://socket.io/docs/v4/handling-cors/),
[Server API](https://socket.io/docs/v4/server-api/).
