# Kalkan – Proje Rehberi

> **Kalkan**, şüpheli SMS, link, e-posta ve dosyaları analiz edip kullanıcıya risk seviyesini ve ne yapması gerektiğini sade bir dille anlatan, **yapay zeka destekli bir dijital güvenlik ve dolandırıcılık danışma platformudur.**
>
> Slogan: *"Tıklamadan önce sor."*

Bu dosya projenin tamamını özetler. Hem ekip üyeleri hem de Claude Code için ana başvuru kaynağıdır. Her alanın daha detaylı görev dokümanı `docs/` klasöründe yer alır.

---

## 1. Proje Özeti

Kalkan bir **web sitesi** ve bir **Android uygulamasından** oluşur. Kullanıcı şüpheli bir içerikle karşılaştığında bunu Kalkan'a gönderir:

1. **Gönder:** SMS metni, link, e-posta, dosya veya ekran görüntüsü
2. **Analiz:** Yapay zeka modelleri ve kural tabanlı güvenlik araçları içeriği değerlendirir
3. **Sonuç:** Risk seviyesi (düşük / orta / yüksek), gerekçesi ve ne yapılması gerektiği
4. **Uzman:** Gerekirse kullanıcı canlı destekte bir insan güvenlik uzmanına aktarılır
5. **Veri:** Vaka anonimleştirilir; Türkiye'deki dolandırıcılık trendlerini gösteren herkese açık dashboard'a ve erken uyarı sistemine katkı sağlar

### Ana modüller

| Modül | İçerik |
|---|---|
| **Yapay Zeka Asistanı & Canlı Destek** | Türkçe sohbet asistanı (LLM + RAG), içerik analizi, insana devir, ajan paneli, talep sistemi |
| **Güvenlik Araçları** | Link/QR tarayıcı, dosya hash kontrolü, parola sızıntı kontrolü, e-posta başlığı analizi |
| **İhbar & Veri Merkezi** | Anonim ihbarlar, dolandırıcılık dashboard'u, Türkiye haritası, erken uyarı sistemi |
| **Farkındalık Akademisi** | Kısa dersler, quizler, "Bu mesaj sahte mi?" oyunu |

### Kalkan ne değildir?

- Kesin hüküm vermez: "%100 güvenli / sahte" yerine **gerekçeli risk seviyesi** sunar.
- Kullanıcının SMS'lerini **kendiliğinden okumaz**; yalnızca kullanıcının gönderdiğini analiz eder.
- Dolandırıcılara veya bildirilen sitelere **saldırmaz**, müdahale etmez.
- Polis veya bankanın yerini tutmaz; kullanıcıyı doğru resmi kanala yönlendirir.

---

## 2. Programlama Dilleri

| Alan | Diller | Çalışma ortamı / framework |
|---|---|---|
| **Frontend (Web)** | **HTML, CSS, JavaScript** | React (Vite), Tailwind CSS |
| **Backend** | **TypeScript, JavaScript, Python** | Node.js + Express, Next.js (API Routes) · Python + FastAPI |
| **Android** | **Kotlin, XML** (manifest, kaynaklar), **Gradle Kotlin DSL** | Android SDK, Jetpack Compose |
| **Yapay Zeka** | **Python** | PyTorch, Hugging Face, FastAPI |
| **Veri Bilimi** | **Python, SQL** | pandas, Jupyter, PostgreSQL |
| **Siber Güvenlik** | **Python, Bash**, YAML / XML (kural dosyaları) | Wazuh, Semgrep, OWASP ZAP |
| **Ortak altyapı** | YAML, Dockerfile, Markdown | Docker Compose, GitHub Actions |

### Backend'de dillerin kullanım alanı

| Dil | Nerede kullanılır? |
|---|---|
| **TypeScript** | Ana API'nin varsayılan dili: kimlik doğrulama, kullanıcılar, ihbarlar, canlı destek, akademi |
| **JavaScript** | Küçük yardımcı betikler, hızlı prototipler ve TypeScript'e geçirilecek eski kodlar |
| **Next.js (API Routes)** | Gerekirse web'e özel hafif uç noktalar ve sunucu tarafı işlemler |
| **Python** | Yapay zeka ve veri servisleriyle doğrudan çalışan entegrasyonlar, güvenlik araçları servisleri |

> **Kural:** Ana API'de yeni kod **TypeScript** ile yazılır. JavaScript yalnızca yardımcı betiklerde kullanılır. Python servisleri ana API'ye HTTP üzerinden bağlanır.

---

## 3. Sistem Mimarisi

```
     [Web - React · HTML/CSS/JS]        [Android - Kotlin]
                   \                        /
                    \                      /
          [Ana API & Gateway - Node.js · TypeScript]  <---- Siber: WAF, Wazuh SIEM, CI taramaları
           |         |           |              |                |                 |
     [PostgreSQL] [Redis] [Socket.IO]   [Araç Servisi]     [AI Servisi]     [Veri Servisi]
                           (canlı destek) (Python·FastAPI) (Python·FastAPI) (Python·FastAPI)
```

- Web ve Android **aynı API'yi** kullanır.
- **Ana API** Node.js + TypeScript ile yazılır.
- **AI Servisi**, **Veri Servisi** ve **Güvenlik Araçları Servisi** Python (FastAPI) ile ayrı servisler olarak çalışır. Ana API bu servisleri HTTP üzerinden çağırır.
- Tüm servisler Docker ile çalışır, loglar Wazuh'a gönderilir.

---

## 4. Repo Yapısı (Monorepo)

```
kalkan/
├── CLAUDE.md              # Bu dosya
├── README.md
├── docker-compose.yml     # Tüm servisleri yerelde ayağa kaldırır
├── .github/workflows/     # CI/CD ve güvenlik taramaları
├── docs/                  # Alan dokümanları, API sözleşmesi, kararlar
│   ├── frontend.md
│   ├── backend.md
│   ├── android.md
│   ├── yapay_zeka.md
│   ├── veri_bilimi.md
│   ├── siber_guvenlik.md
│   └── api/openapi.yaml
├── web/                   # Frontend (HTML, CSS, JavaScript · React)
├── backend/
│   ├── api/               # Ana API (Node.js, TypeScript)
│   └── tools-service/     # Güvenlik araçları servisi (Python, FastAPI)
├── ai-service/            # Yapay zeka servisi ve modeller (Python)
├── data/                  # Veri pipeline'ları, analizler, veri servisi (Python, SQL)
├── android/               # Android uygulaması (Kotlin, XML, Gradle Kotlin DSL)
└── security/              # Güvenlik kuralları, betikler, pentest raporları (Python, Bash, YAML)
```

---

## 5. Alanlar

### 5.1 Frontend (Web)

**Ekip:** ~14 kişi · **Sorumlu:** Ümmügülsüm Söğüt · **Diller:** HTML, CSS, JavaScript

Kalkan web sitesinin kullanıcıya görünen tüm yüzünü geliştirir: ana site, yapay zeka sohbet ekranı, canlı destek ajan paneli, veri dashboard'ları, akademi ve admin paneli. Ayrı bir UI/UX ekibi olmadığı için ekipten 1-2 kişi tasarım sistemini (Figma, renkler, bileşenler) üstlenir.

| Alt ekip | Kişi |
|---|---|
| Ana site & tasarım sistemi | 4 |
| Asistan sohbet arayüzü & canlı destek ajan paneli | 4 |
| Veri dashboard'ları & ihbar formu | 3 |
| Akademi & admin paneli | 3 |

**Dillerin rolü:**
- **HTML:** Sayfa yapısı ve anlamsal (semantic) işaretleme; erişilebilirlik için doğru etiketler (`<nav>`, `<main>`, `<button>`, `alt` metinleri)
- **CSS:** Görünüm, responsive tasarım ve tasarım sistemi (Tailwind CSS + gerektiğinde özel CSS)
- **JavaScript:** Etkileşim, API çağrıları, sohbet ekranı, grafikler ve form doğrulama

**Teknolojiler:** React (Vite), React Router, Tailwind CSS, TanStack Query, Zustand, React Hook Form + Zod, Recharts/Chart.js, Leaflet, Socket.IO client, Vitest, Playwright

**Önemli kurallar:**
- Backend hazır olmadan OpenAPI sözleşmesine göre **mock veriyle** (MSW) çalışılır.
- Her sayfa mobil uyumlu (responsive) olmalıdır.
- Kullanıcı girdisi `innerHTML` veya `dangerouslySetInnerHTML` ile sayfaya basılmaz (XSS önlemi).
- Analiz sonuçları her zaman risk seviyesi olarak gösterilir, "kesin" ifadesi kullanılmaz.

---

### 5.2 Backend

**Ekip:** ~9 kişi · **Sorumlu:** İrem Karabıyık · **Diller:** TypeScript, JavaScript, Python

Web ve mobilin ortak kullandığı ana API'yi, kimlik doğrulamayı, gerçek zamanlı sohbet ve canlı destek altyapısını, veritabanını ve servisler arası bağlantıları geliştirir. Ana API Node.js + TypeScript ile, güvenlik araçları servisi Python ile yazılır. Yapay zeka ve veri ekipleri kendi Python servislerini kendileri yazar; backend bu servisleri ana API'ye bağlar.

| Alt ekip | Kişi | Dil |
|---|---|---|
| Kimlik doğrulama & API gateway | 2 | TypeScript |
| Sohbet, canlı destek & kuyruk (Socket.IO) | 3 | TypeScript |
| Güvenlik araçları servisi & dış API entegrasyonları | 2 | Python |
| İhbar & veri API'leri, veritabanı | 2 | TypeScript, SQL |

**Teknolojiler:**
- **Node.js tarafı:** Express (veya NestJS), Next.js API Routes (gerekirse), Prisma ORM, PostgreSQL, Redis, BullMQ (iş kuyruğu), Socket.IO, JWT + TOTP (2FA), Zod, Jest/Vitest + Supertest
- **Python tarafı:** FastAPI, httpx, Pydantic, pytest

**Temel endpoint grupları:** `/auth`, `/chat`, `/support`, `/tools`, `/reports`, `/stats`, `/academy`

**Önemli kurallar:**
- Tüm endpoint'ler önce `docs/api/openapi.yaml` dosyasında tanımlanır.
- Parolalar yalnızca Argon2 veya bcrypt ile saklanır.
- İhbarlardaki kişisel veriler (telefon, isim, IBAN) **veritabanına yazılmadan önce maskelenir**.
- Veritabanı sorguları Prisma veya parametreli sorgularla yazılır (SQL injection önlemi).
- Tüm gelen istekler Zod (TypeScript) veya Pydantic (Python) ile doğrulanır.
- Gizli anahtarlar koda yazılmaz, ortam değişkenlerinden okunur.

---

### 5.3 Android (Mobil Uygulama)

**Ekip:** ~5 kişi · **Sorumlu:** Ali Alp Kocaoğlu · **Diller:** Kotlin, XML, Gradle Kotlin DSL

Kalkan'ın Android uygulamasını geliştirir. Ekip küçük olduğu için uygulama sitenin tamamını değil **çekirdeğini** içerir.

| Rol | Kişi |
|---|---|
| Sohbet & canlı destek | 2 |
| Araçlar & paylaş menüsü | 1 |
| Bildirimler & ihbar | 1 |
| Test & arayüz | 1 |

**Dillerin rolü:**
- **Kotlin:** Uygulama mantığı, ekranlar (Jetpack Compose), ağ istekleri
- **XML:** `AndroidManifest.xml` (izinler, paylaş menüsü intent filtreleri), `res/` kaynakları (metinler `strings.xml`, renkler, ikonlar, temalar)
- **Gradle Kotlin DSL:** `build.gradle.kts` ve `settings.gradle.kts` ile bağımlılıklar, derleme ayarları, sürüm yönetimi

**Native ekranlar:** Giriş ve 2FA, asistan ve canlı destek, link & QR tarayıcı (kamera), **"Paylaş → Kalkan ile tara"**, ihbar formu, push bildirimleri
**WebView ile:** Veri dashboard'ları, akademi

**Teknolojiler:** Jetpack Compose, Material 3, MVVM, Retrofit + OkHttp, Hilt, Room, DataStore, CameraX + ML Kit, Firebase Cloud Messaging, EncryptedSharedPreferences / Android Keystore, JUnit, Compose UI Test

**Önemli kurallar:**
- Google Play SMS okuma iznini kısıtladığı için **READ_SMS izni kullanılmaz**; kullanıcı mesajı paylaşarak veya kopyalayarak gönderir.
- Kullanıcıya görünen tüm metinler `strings.xml` içinde tutulur, koda gömülmez.
- Uygulamaya hiçbir gizli anahtar gömülmez.
- Yalnızca gereken izinler istenir (kamera, bildirim).

---

### 5.4 Yapay Zeka

**Ekip:** ~12 kişi · **Sorumlu:** Furkan Erden · **Dil:** Python

Projenin beynidir. Kullanıcıyla konuşan asistanı, şüpheli içerikleri değerlendiren modelleri ve bunları ayrı bir servis olarak yayına almayı üstlenir.

| Alt ekip | Kişi |
|---|---|
| LLM asistanı & RAG | 4 |
| Türkçe dolandırıcılık metin sınıflandırma | 3 |
| Ekran görüntüsü (OCR) & URL analizi | 3 |
| MLOps & değerlendirme | 2 |

**Bileşenler:**
- **Kalkan Asistanı:** Türkçe konuşan LLM; siber ekibin hazırladığı bilgi tabanı üzerinde RAG ile çalışır, diğer modelleri araç (tool) olarak çağırır, emin olamadığında insana devreder.
- **Metin sınıflandırıcı:** `güvenli / şüpheli / dolandırıcılık` + kategori (kargo, banka, vergi iadesi, yatırım, sahte ödül vb.). BERTurk tabanlı, TF-IDF + Logistic Regression baseline ile karşılaştırılır.
- **OCR:** Ekran görüntüsündeki metni çıkarır (Tesseract / EasyOCR / PaddleOCR).
- **URL modeli:** Alan adı özelliklerinden risk skoru üretir.

**Teknolojiler:** PyTorch, Hugging Face Transformers, scikit-learn, LangChain veya LlamaIndex, pgvector/Chroma, MLflow veya W&B, FastAPI, Docker, pytest

**MVP hedefleri:** Sınıflandırıcı F1 ≥ 0.85, URL modeli ROC-AUC ≥ 0.90, asistan test setinde doğru cevap ≥ %85, sınıflandırma süresi < 1 sn

**Önemli kurallar:**
- Asistan kullanıcıdan parola, kart numarası veya doğrulama kodu **istemez**; yazılırsa uyarır ve loglamaz.
- Prompt injection'a karşı sistem promptu ve araç çağrıları korunur.
- Kullanıcı verisi izin olmadan model eğitiminde kullanılmaz.

---

### 5.5 Veri Bilimi

**Ekip:** ~14 kişi · **Sorumlu:** *(belirlenecek)* · **Diller:** Python, SQL

Platformda oluşan verinin toplanması, temizlenmesi, analizi ve içgörüye dönüştürülmesini üstlenir. Ayrıca yapay zeka ekibinin ihtiyaç duyduğu Türkçe dolandırıcılık veri setini oluşturur.

| Alt ekip | Kişi |
|---|---|
| Veri mühendisliği & ETL | 4 |
| Analitik & raporlama | 4 |
| Trend, anomali & tahmin modelleri | 3 |
| Veri seti oluşturma & etiketleme | 3 |

**Ana çıktılar:**
- **Herkese açık dolandırıcılık dashboard'u:** trendler, en çok taklit edilen kurumlar, kategori ve kanal dağılımı, şehir haritası
- **Erken uyarı sistemi:** ihbarlarda olağan dışı artış tespiti (z-skoru, Prophet/STL, Isolation Forest)
- **Türkçe dolandırıcılık veri seti:** Faz 1 sonunda ≥ 3.000, Faz 2 sonunda ≥ 8.000 etiketli mesaj; her mesaj en az 2 kişi tarafından etiketlenir
- **Aylık "Kalkan Dolandırıcılık Raporu"** ve ürün analitiği

**Teknolojiler:** pandas / Polars, NumPy, Jupyter, Plotly, Apache Superset, statsmodels, Prophet, scikit-learn, Airflow veya Prefect (gerekirse), PostgreSQL / DuckDB, Label Studio, FastAPI

**Önemli kurallar:**
- Ekip genelde **anonimleştirilmiş** veriyle çalışır; ham veriye yalnızca yetkili kişiler erişir.
- Dashboard'da kişiyi tanımlayabilecek kadar küçük gruplar gösterilmez (ör. 5'ten az ihbar).
- Açık kaynak veriler lisans koşullarına uygun kullanılır.

---

### 5.6 Siber Güvenlik

**Ekip:** ~11 kişi · **Sorumlu:** Kerim Yorulmaz · **Diller:** Python, Bash (+ YAML/XML kural dosyaları)

Bu projede siber güvenlik yan alan değil, **ürünün kendisidir**. Ekip hem kullanıcılara sunulan güvenlik araçlarının mantığını ve içeriği üretir, hem de platformun kendisini korur ve test eder. Ayrı bir DevOps ekibi olmadığı için Blue Team'den 1-2 kişi Docker ve CI/CD işlerini de üstlenir (DevSecOps).

| Alt ekip | Kişi | Görev |
|---|---|---|
| **Blue Team** | 4 | Platform güvenliği, WAF, Wazuh SIEM, güvenlik dashboard'u, CI güvenlik taramaları, KVKK uyumu |
| **Red Team** | 3 | Web, API, Android ve yapay zeka asistanına pentest; iç bug bounty |
| **Araç Motoru & İçerik** | 4 | Link analiz kuralları, araçların mantığı, bilgi tabanı ve akademi içeriği, canlı destekte uzman rolü |

**Güvenlik araçlarının mantığı** (backend'in Python araç servisiyle birlikte):
- **Link tarayıcı:** typosquatting, IP adresli link, kısaltılmış link çözme, şüpheli TLD, yeni kayıtlı alan adı + PhishTank, URLhaus, Google Safe Browsing + AI URL modeli
- **Dosya hash kontrolü:** VirusTotal API (dosyanın kendisi değil, hash'i gönderilir)
- **Parola sızıntı kontrolü:** Have I Been Pwned API, k-anonymity ile
- **E-posta başlığı analizi:** SPF, DKIM, DMARC, gönderici tutarsızlıkları

**Teknolojiler:** Burp Suite, OWASP ZAP, sqlmap, ffuf, nmap, MobSF, jadx, Frida, Wazuh, Grafana, Semgrep, Trivy, gitleaks, Dependabot, npm audit
**Standartlar:** OWASP Top 10, OWASP API Top 10, OWASP ASVS, OWASP MASVS, OWASP Top 10 for LLM

**Önemli kurallar:**
- Red Team **yalnızca Kalkan'ın kendi sistemlerini** test eder. Kullanıcıların bildirdiği linklere, sitelere veya kişilere kesinlikle saldırı veya aktif tarama yapılmaz.
- Linklerin içeriğine bakılması gerekiyorsa yalnızca izole bir ortamda (sandbox) ve pasif olarak yapılır.

---

## 6. Ekipler Arası Bağlantılar

| Kaynak | → | Hedef | Ne aktarılır? |
|---|---|---|---|
| Veri Bilimi | → | Yapay Zeka | Etiketli Türkçe dolandırıcılık veri seti |
| Siber Güvenlik | → | Yapay Zeka & Backend | Bilgi tabanı içeriği, URL kural motoru, araç mantığı |
| Yapay Zeka | → | Backend | AI servisi (FastAPI), akışlı (streaming) cevaplar |
| Backend | → | Web & Android | Tek ortak API (OpenAPI sözleşmesi) |
| Siber Güvenlik | → | Canlı Destek | İnsan uzmanlar, erken uyarı doğrulama |
| Red Team | → | Tüm ekipler | Pentest bulguları, iç bug bounty |

---

## 7. Zaman Planı (~14 Hafta)

| Faz | Hafta | Hedef |
|---|---|---|
| **Faz 0 – Hazırlık** | 1–2 | Tasarım, OpenAPI sözleşmesi, veritabanı şeması, repo ve CI kurulumu, veri seti toplamaya başlama |
| **Faz 1 – MVP** | 3–8 | Giriş/kayıt, yazılı asistan, link tarayıcı, ihbar formu, temel dashboard, ilk pentest |
| **Faz 2 – Genişleme** | 9–12 | Canlı destek, Android uygulaması, ekran görüntüsü analizi, akademi, erken uyarı |
| **Faz 3 – Lansman** | 13–14 | Final pentest, hata düzeltme, performans, yayına alma, sunum |

---

## 8. Çalışma Kuralları

- **Git:** Tek GitHub organizasyonu. `main` korumalıdır; her değişiklik ayrı bir branch ve pull request ile gelir, en az 1 onay gerekir.
- **Branch adları:** `feature/<alan>-<kısa-açıklama>`, `fix/<alan>-<kısa-açıklama>` (ör. `feature/web-chat-ui`)
- **Commit mesajları:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- **CI:** Her PR'da lint, test ve güvenlik taramaları (Semgrep, Trivy, gitleaks, npm audit) çalışır.
- **API önce:** Yeni endpoint önce OpenAPI sözleşmesine eklenir, sonra kodlanır.
- **Sprintler:** 2 haftalık sprint, sprint sonunda tüm ekibe demo. Alan sorumluları haftada bir toplanır.
- **Gizli bilgiler:** `.env` dosyaları repoya eklenmez; örnek değerler `.env.example` içinde tutulur.

### Kod stili

| Dil | Araçlar |
|---|---|
| HTML / CSS | Prettier, Stylelint (özel CSS için) |
| JavaScript | ESLint, Prettier |
| TypeScript | ESLint, Prettier, `strict` mod açık |
| Python | Ruff (lint + format), type hint zorunlu, mypy önerilir |
| Kotlin | ktlint, Android Studio varsayılan stili |
| Gradle Kotlin DSL | Bağımlılık sürümleri `gradle/libs.versions.toml` (version catalog) içinde |
| Bash | ShellCheck |

---

## 9. Etik ve Hukuki İlkeler

- **KVKK:** Kişisel veriler maskelenir, açık rıza alınır, veriler anonim olarak analiz edilir.
- **Yalnızca kendi sistemlerimiz:** Hiçbir üçüncü taraf sisteme saldırı veya izinsiz tarama yapılmaz.
- **Yapay zeka kesin hüküm vermez:** Sonuçlar gerekçeli risk seviyesi olarak sunulur.
- **Hassas bilgi istenmez:** Parola, kart numarası, doğrulama kodu hiçbir ekranda istenmez ve loglanmaz.
- **Resmi yönlendirme:** Maddi kayıp durumunda kullanıcı bankasına ve resmi şikâyet kanallarına yönlendirilir.

---

## 10. Claude Code İçin Notlar

- Kullanıcıya görünen tüm metinler, arayüz yazıları ve dokümantasyon **Türkçe** olmalıdır. Kod içindeki değişken, fonksiyon ve sınıf adları **İngilizce** yazılır.
- Her klasörde ilgili alanın dilini kullan:
  - `web/` → HTML, CSS, JavaScript (React)
  - `backend/api/` → TypeScript (Node.js); yardımcı betiklerde JavaScript
  - `backend/tools-service/`, `ai-service/`, `data/` → Python
  - `android/` → Kotlin, XML, Gradle Kotlin DSL
  - `security/` → Python, Bash, YAML
- Yeni bir özellik eklerken önce ilgili alanın `docs/<alan>.md` dosyasını ve `docs/api/openapi.yaml` sözleşmesini kontrol et.
- Listede olmayan yeni bir kütüphane eklemeden önce gerekçesini belirt.
- Kişisel veri işleyen her kodda maskeleme ve KVKK kurallarını uygula.
- Güvenlik araçlarını yazarken bildirilen linklere **aktif saldırı veya tarama** yapan kod yazma; yalnızca pasif kontroller ve tehdit istihbaratı API'leri kullanılır.
- Analiz sonucu döndüren her fonksiyon "kesin" bir sonuç değil, `risk_level` + `reasons` yapısında sonuç döndürmelidir.
- Testleri ilgili alanın test aracıyla yaz: Vitest/Playwright (web), Jest/Vitest + Supertest (Node.js API), pytest (Python servisleri), JUnit/Compose UI Test (Android).

---

## 11. İletişim ve Sorumlular

| Rol | Kişi |
|---|---|
| Proje yöneticisi & Android sorumlusu | Ali Alp Kocaoğlu |
| Frontend sorumlusu | Ümmügülsüm Söğüt |
| Backend sorumlusu | İrem Karabıyık |
| Siber Güvenlik sorumlusu | Kerim Yorulmaz |
| Yapay Zeka sorumlusu | Furkan Erden |
| Veri Bilimi sorumlusu | *(belirlenecek)* |
