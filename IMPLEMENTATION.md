# Bir Web Uygulamasını Hayrat Hesabım'a Bağlama (JavaScript SDK)

> Bu doküman, tarayıcıda çalışan bir uygulamaya (SPA) **"Hesabım ile giriş"**
> eklemek için gereken her şeyi anlatır. Hedef: bir geliştiriciye ya da bir AI
> kodlama ajanına _"bu projeyi `hesabim-sdk-js`'in `IMPLEMENTATION.md`'sine göre
> entegre et"_ denildiğinde, **soru sormadan** uçtan uca bitirebilmesi.
>
> Sunucu tarafı (API'nin token doğrulaması, ya da token'ı tarayıcıya hiç
> indirmeyen BFF kurulumu) Go SDK'nın dokümanındadır:
> <https://github.com/hayrat/hesabim-sdk-go/blob/main/IMPLEMENTATION.md>

---

## 0. AI ajanı için talimat — önce bunu oku

Bu bölüm sırayla uygulanacak karar ağacıdır. Kullanıcıya soru sorma; aşağıdaki
varsayılanlarla ilerle, sonunda **§15'teki raporu** ver.

1. **Topolojiyi belirle (§1).**
   - Proje yalnızca tarayıcı uygulamasıysa (Vue/React/Svelte/vanilla) veya
     ayrı bir API'ye `fetch` atan bir SPA ise → **bu doküman** (SPA, `public`
     client).
   - Projede token'ları sunucuda tutan bir backend isteniyorsa ya da zaten
     sunucu tarafı oturum (cookie session) kullanan bir backend varsa → BFF
     yolu. O zaman bu SDK **kullanılmaz**; Go SDK dokümanına geç. Karar
     verilemiyorsa: mevcut kod sunucu tarafı oturum kullanmıyorsa **SPA**'yı seç.
2. **Framework'ü tespit et** (`package.json`):
   - `vue@3` → `@hayrat/hesabim-vue` + `@hayrat/hesabim-core` (§5.2).
   - React, Svelte, Solid, Angular, vanilla → yalnız `@hayrat/hesabim-core`
     (§5.1; React için §5.10'daki hook'u da ekle).
   - Nuxt / Next.js / SvelteKit gibi SSR çatıları → aynı paketler, ama client
     **yalnızca tarayıcıda** oluşturulur (§5.11).
3. **Değerleri koda yazma, env'den oku (§3).** Gerçek `clientId`'yi
   bilmiyorsan env okuyan kodu yaz, örnek env dosyasına boş/placeholder anahtar
   koy, eksikse uygulama açılışında anlaşılır bir hata ver. Durup sorma.
4. **Kayıt senin işin değil.** Proje/client/rol kaydını Hesabım yöneticisi
   yapar. Sen §2'deki kayıt talebini doldurup rapora koyarsın.
5. **Yerel geliştirmeyi HTTPS'e al (§4.1).** Canlı Hesabım, SPA'nın
   `http://localhost` adresine giriş yönlendirmez. Dev sunucusunu
   `https://localhost:<port>` ile çalışacak şekilde ayarla ve kayıt talebine bu
   adresi yaz.
6. **Adımların hepsini uygula** (§5.1–§5.9), §12'deki kontrol listesini kod
   üzerinde tek tek doğrula, mümkünse §13'teki testleri çalıştır.
7. **Asla:** client secret kullanma (SPA'da yoktur), `hasRole`/`inScope` gibi
   yardımcı yazma (§7), token'ı `console.log`'a basma, kendi PKCE/OAuth
   akışını yazma (SDK yapar), IdP uç yollarını (`/oauth/...`) koda gömme.

---

## 1. Parçalar ve topoloji

Hesabım bir **OpenID Connect kimlik sağlayıcısıdır** (Authorization Code + PKCE).
Issuer: `https://hesabim.hayrat.com`.

**Yazmadığın şeyler:** giriş ekranı, tek kullanımlık kod (OTP) akışı, e-posta/SMS
gönderimi, bot koruması, oturum yönetimi, refresh token döngüsü, kayıt ve profil
ekranları.

**Yazdığın şeyler:** client kurulumu, bir callback sayfası, API çağrılarına
token ekleyen bir sarmalayıcı, route koruması, çıkış butonu — ve **backend'inde**
token doğrulaması (§6).

```
  Tarayıcı (SPA)                    Hesabım (IdP)               Senin API'n
       │ 1. login() ───────────────────►│                            │
       │    (Authorization Code + PKCE) │ giriş ekranı, OTP, oturum  │
       │ ◄──── 2. /auth/callback?code= ─│                            │
       │ 3. handleCallback() ──────────►│ /oauth/token               │
       │ ◄──── access + refresh + id ───│                            │
       │ 4. Authorization: Bearer ──────┼───────────────────────────►│
       │                                │◄──── JWKS (public key) ────│ 5. imza +
       │ ◄───────────────── veri ───────┼────────────────────────────│    aud doğrulama
```

- 1–3 ve token yenileme → **bu SDK**.
- 5 → backend'in. Go ise `hesabim-sdk-go`; değilse §6.2'deki kurallar.
- Access token'ı **backend yerel olarak doğrular**, IdP'ye sormaz.

| | **SPA** (bu doküman) | **BFF** (Go SDK dokümanı) |
|---|---|---|
| Token nerede | Tarayıcıda (`localStorage`) | Sunucuda; tarayıcıda yalnız HttpOnly cookie |
| Client tipi | `public` — **secret yok** | `confidential` — secret var |
| XSS'te token çalınabilir mi | Evet (kısa ömürlü, ama evet) | Hayır |
| Ek iş | Yok | Cookie oturumu, token saklama, yenileme sende |

---

## 2. Kayıt — Hesabım yöneticisine gönderilecek talep

Uygulama başına bir kez. Kaydı **Hesabım yöneticisi** yapar; sen aşağıdaki
şablonu doldurup iletirsin. (Ajan: şablonu doldurulabildiği kadar doldur,
raporuna ekle.)

```text
Konu: Hesabım entegrasyon kaydı — <Uygulama Adı>

Proje anahtarı (key) : ornek-proje          # küçük harf + tire; sonradan DEĞİŞTİRİLEMEZ
Proje adı            : Örnek Proje
Client tipi          : public (tarayıcı SPA'sı, PKCE; secret YOK)
Redirect URI'ler     : https://ornek.hayrat.com/auth/callback
                       https://localhost:5173/auth/callback      # yerel geliştirme — HTTPS (§4.1)
Çıkış sonrası dönüş  : https://ornek.hayrat.com/
                       https://localhost:5173/
Roller               : admin, moderator, viewer   # uygulamanın kendi rol sözlüğü
Kapsamlı rol var mı  : moderator → il (province) bazında
Test kullanıcısı     : <ad soyad / telefon>  → rol: moderator, kapsam: il 6
```

**Kurallar — talepte hata yapma:**

- **Redirect URI'ler birebir eşleşir.** Sondaki `/`, `http`/`https`, port farkı
  eşleşmeyi bozar. Hem prod hem geliştirme adresini yaz.
- **SPA'da (public client) `http://` redirect URI çalışmaz — localhost dahil.**
  Canlı Hesabım public client için `http://localhost` redirect'ini authorize
  adımında reddeder ve o origin'e CORS da açmaz. Yerel geliştirme adresi
  `https://localhost:<port>` olmalıdır (§4.1). (`http://localhost` yalnız
  sunucu tarafı `confidential` client'ta — BFF — geçerlidir.)
- Redirect URI **aynı zamanda CORS iznidir** (§9): tarayıcının token isteği
  yalnız kayıtlı redirect URI'lerin origin'lerinden kabul edilir.
- Proje anahtarı access token'ın `aud` değerini belirler: `api:<key>`.
- Roller kayıtta tanımlanır; tanımlı olmayan rol kullanıcıya atanamaz.

**Yöneticiden geri dönen değerler:**

| Değer | Örnek | Nereye |
|---|---|---|
| `client_id` | `ornek-proje-spa` | Frontend env (§3) — sır değildir |
| Audience | `api:ornek-proje` | **Backend** env (`HESABIM_AUDIENCE`) |
| Issuer | `https://hesabim.hayrat.com` | Frontend + backend env |

SPA için **secret yoktur**. Biri sana bir "client secret" verirse yanlış tipte
client açılmıştır — tarayıcı koduna koyma, yöneticiye bildir.

---

## 3. Konfigürasyon (env)

Frontend değerleri derleme sırasında bundle'a gömülür; **hiçbiri sır değildir**
ve olmamalıdır.

| Anlam | Vite | Next.js | Nuxt 3 | SvelteKit | CRA |
|---|---|---|---|---|---|
| Issuer | `VITE_HESABIM_ISSUER` | `NEXT_PUBLIC_HESABIM_ISSUER` | `NUXT_PUBLIC_HESABIM_ISSUER` | `PUBLIC_HESABIM_ISSUER` | `REACT_APP_HESABIM_ISSUER` |
| Client id | `VITE_HESABIM_CLIENT_ID` | `NEXT_PUBLIC_HESABIM_CLIENT_ID` | `NUXT_PUBLIC_HESABIM_CLIENT_ID` | `PUBLIC_HESABIM_CLIENT_ID` | `REACT_APP_HESABIM_CLIENT_ID` |

- Issuer varsayılanı `https://hesabim.hayrat.com`. **Sonuna `/` koyma** (SDK
  normalize eder ama tutarlı kal).
- `redirectUri` ve `postLogoutRedirectUri` env'e konmaz:
  `${location.origin}/auth/callback` ve `${location.origin}/` olarak türetilir.
  Böylece prod ve `https://localhost` aynı koddan çalışır (ikisi de kayıtlı
  olduğu sürece).
- Örnek env dosyası (Vite):

  ```dotenv
  # .env.example  — gerçek değerleri .env.local'a yaz
  VITE_HESABIM_ISSUER=https://hesabim.hayrat.com
  VITE_HESABIM_CLIENT_ID=
  ```

  Proje zaten `.env.development` / `.env.production` kullanıyorsa anahtarları
  oraya ekle. Değerler sır olmadığı için commit'lenebilir; **client_id
  bilinmiyorsa boş bırak** ve §5.1'deki açılış kontrolüne güven.

---

## 4. Kurulum

```sh
npm install @hayrat/hesabim-core                       # her framework
npm install @hayrat/hesabim-vue @hayrat/hesabim-core   # Vue 3
```

(`pnpm add` / `yarn add` eşdeğerleri de olur.) Paketlerin çalışma zamanı
bağımlılığı yoktur; Vue adaptörü yalnız `vue@^3`'ü peer olarak ister.

**Gereksinim:** tarayıcıda `crypto.subtle` → sayfa **güvenli bağlamda** açılmalı.
`http://192.168.x.x` gibi bir LAN adresinden açılan sayfada giriş çalışmaz.

### 4.1 Yerel geliştirme HTTPS ile

`http://localhost` tarayıcı açısından güvenli bağlam olsa da **canlı Hesabım
onu SPA redirect'i olarak kabul etmez** (§2). Dev sunucusunu HTTPS ile çalıştır
ve `https://localhost:<port>/auth/callback` adresini kaydettir.

- **Vite (önerilen, en basit):** `npm i -D @vitejs/plugin-basic-ssl`

  ```ts
  // vite.config.ts
  import { defineConfig } from 'vite'
  import basicSsl from '@vitejs/plugin-basic-ssl'
  export default defineConfig({
    plugins: [/* mevcut eklentiler, */ basicSsl()],
    server: { port: 5173, strictPort: true },
  })
  ```

  Tarayıcı ilk açılışta kendinden imzalı sertifika uyarısı verir; bir kez kabul
  et. Uyarısız çalışmak istersen `mkcert` ile yerel CA kur ve
  `server.https: { key, cert }` ver.
- **Next.js:** `next dev --experimental-https`
- **Nuxt 3:** `nuxi dev --https`
- **SvelteKit:** Vite tabanlıdır — yukarıdaki `basicSsl()` aynen.
- **CRA:** `HTTPS=true npm start`
- **Angular:** `ng serve --ssl`

`strictPort` önemlidir: port kayarsa (`5174`) redirect URI artık kayıtlıyla
eşleşmez.

---

## 5. Adım adım SPA entegrasyonu

Önerilen dosyalar (projenin yapısına uyarla, isimleri koru):

```
src/auth/hesabim.ts      client (tek örnek)            — §5.1
src/auth/api.ts          token ekleyen fetch            — §5.5
src/pages/AuthCallback   /auth/callback sayfası         — §5.4
router guard             korunan route'lar              — §5.6
```

### 5.1 Client'ı kur (tek örnek)

```ts
// src/auth/hesabim.ts
import { createHesabimClient } from '@hayrat/hesabim-core'

const issuer = import.meta.env.VITE_HESABIM_ISSUER || 'https://hesabim.hayrat.com'
const clientId = import.meta.env.VITE_HESABIM_CLIENT_ID

if (!clientId) {
  // Kayıt tamamlanmadan uygulama sessizce bozuk açılmasın.
  throw new Error('VITE_HESABIM_CLIENT_ID tanımlı değil — Hesabım kaydından dönen client_id değerini env\'e yaz.')
}

export const hesabim = createHesabimClient({
  issuer,
  clientId,
  redirectUri: `${window.location.origin}/auth/callback`,
  postLogoutRedirectUri: `${window.location.origin}/`,
  // scopes: 'openid profile offline_access',   // varsayılan — değiştirme
  // scopeResolver: …                            // §7, yalnız hiyerarşi gerekiyorsa
})
```

- `createHesabimClient` **senkrondur**, config yanlışsa hemen `Error` fırlatır
  ve keşif belgesini (`/.well-known/openid-configuration`) arka planda çekmeye
  başlar. Uç yollarını hiçbir yere yazma.
- **Uygulamada tek bir client olmalı.** Birden çok örnek aynı oturumu paylaşır
  ama gereksiz keşif isteği atar.
- `redirectUri` sayfayla **aynı origin'de** olmalı; değilse config hatası.
- `scopes`'tan `offline_access`'i çıkarma: o olmadan refresh token gelmez ve
  kullanıcı her 10 dakikada yeniden girişe atılır.

### 5.2 Vue 3 — plugin

```ts
// src/main.ts
import { createApp } from 'vue'
import { createHesabim } from '@hayrat/hesabim-vue'
import App from './App.vue'
import router from './router'

const issuer = import.meta.env.VITE_HESABIM_ISSUER || 'https://hesabim.hayrat.com'
const clientId = import.meta.env.VITE_HESABIM_CLIENT_ID
if (!clientId) throw new Error('VITE_HESABIM_CLIENT_ID tanımlı değil.')

const app = createApp(App)
app.use(createHesabim({
  issuer,
  clientId,
  redirectUri: `${window.location.origin}/auth/callback`,
  postLogoutRedirectUri: `${window.location.origin}/`,
}))
app.use(router)
app.mount('#app')
```

Bileşen içinde:

```ts
import { useHesabim } from '@hayrat/hesabim-vue'
const { isAuthenticated, user, login, logout, getAccessToken, can, handleCallback } = useHesabim()
// isAuthenticated: Readonly<Ref<boolean>>, user: Readonly<Ref<HesabimUser | null>>
```

Vue adaptörü hata sınıflarını da yeniden dışa aktarır. `instanceof` için
**onları `@hayrat/hesabim-vue`'dan import et** (aynı sınıf kimliği garanti olur):

```ts
import { AuthRequiredError, AuthUnavailableError, CallbackError } from '@hayrat/hesabim-vue'
```

Vue plugin'ini kullanıyorsan §5.1'deki ayrı client'ı **oluşturma** — plugin
kendi client'ını kurar. Bileşen dışı kod (router guard, `api.ts`) için §5.5 ve
§5.6'daki Vue varyantlarına bak.

### 5.3 Giriş

```ts
await hesabim.login({ returnTo: '/raporlar?sayfa=2' })
// Geri dönmez — sayfa IdP'ye yönlenir.
```

- `returnTo` yalnızca **aynı origin'deki** bir yol olabilir; başka origin,
  `javascript:` vb. sessizce yok sayılır (açık yönlendirme koruması).
- `login()` yalnızca keşif belgesi alınamazsa reddeder (`AuthUnavailableError`)
  → "Giriş servisine ulaşılamıyor, tekrar dene" göster.

Giriş butonu: genelde `returnTo: location.pathname + location.search`.

### 5.4 Callback sayfası — `/auth/callback`

Route'u oluştur; sayfa açıldığında **bir kez** `handleCallback()` çağır. Bu
route **korumasız** olmalı (guard'a takılmamalı).

**Vue Router:**

```vue
<!-- src/pages/AuthCallback.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useHesabim, CallbackError } from '@hayrat/hesabim-vue'

const { handleCallback, login } = useHesabim()
const router = useRouter()
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    const { returnTo } = await handleCallback()
    await router.replace(returnTo ?? '/')
  } catch (err) {
    error.value = err instanceof CallbackError && err.code === 'access_denied'
      ? 'Giriş iptal edildi.'
      : 'Giriş tamamlanamadı.'
  }
})
</script>

<template>
  <p v-if="!error">Giriş yapılıyor…</p>
  <div v-else>
    <p>{{ error }}</p>
    <button @click="login()">Tekrar dene</button>
  </div>
</template>
```

```ts
// router
{ path: '/auth/callback', component: () => import('@/pages/AuthCallback.vue') }
```

**React Router (v6+):**

```tsx
// src/pages/AuthCallback.tsx
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CallbackError } from '@hayrat/hesabim-core'
import { hesabim } from '../auth/hesabim'

export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)   // StrictMode effect'i iki kez çalıştırır — kod tek kullanımlıktır

  useEffect(() => {
    if (started.current) return
    started.current = true
    hesabim.handleCallback()
      .then(({ returnTo }) => navigate(returnTo ?? '/', { replace: true }))
      .catch((err) => setError(
        err instanceof CallbackError && err.code === 'access_denied'
          ? 'Giriş iptal edildi.' : 'Giriş tamamlanamadı.'))
  }, [navigate])

  if (!error) return <p>Giriş yapılıyor…</p>
  return <div><p>{error}</p><button onClick={() => hesabim.login()}>Tekrar dene</button></div>
}
```

```tsx
<Route path="/auth/callback" element={<AuthCallback />} />
```

**Vanilla:** `/auth/callback` adresinde `await hesabim.handleCallback()` sonrası
`location.replace(returnTo ?? '/')`.

`handleCallback()` hataları:

| Hata | Anlamı | Ne yap |
|---|---|---|
| `CallbackError` (`.code`) | IdP OAuth hatası döndü (`access_denied`, `invalid_request`…) | Mesaj + "Tekrar dene" |
| `AuthRequiredError` | URL'de kod/state yok ya da eşleşmiyor (sayfa yenilendi, eski link) | "Tekrar dene" → `login()` |
| `AuthUnavailableError` | Ağ / IdP geçici sorunu | "Tekrar dene" |

Callback sayfasını yenilemek kodu ikinci kez harcamaya çalışır ve
`AuthRequiredError` verir — bu normaldir; kullanıcıyı `login()`'e yönlendir.
Kod 2 dakika geçerli ve tek kullanımlıktır.

### 5.5 API çağrıları — token ekleyen sarmalayıcı

Her API çağrısından **hemen önce** `getAccessToken()` çağır. Süresi dolmak
üzereyse sessizce yeniler; sekmeler arası yenileme çakışmasını kendisi önler.
Token'ı bir değişkende **saklama**.

```ts
// src/auth/api.ts
// Vue projesinde bu import'u '@hayrat/hesabim-vue'dan yap (§5.2) — tüm projede
// hata sınıfları TEK paketten gelsin.
import { AuthRequiredError, AuthUnavailableError } from '@hayrat/hesabim-core'
import { hesabim } from './hesabim'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''   // boş = aynı origin (önerilen, aşağıya bak)

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  let token: string
  try {
    token = await hesabim.getAccessToken()
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      // Oturum bitti (ya da hiç yok): yeniden giriş.
      await hesabim.login({ returnTo: location.pathname + location.search })
    }
    // AuthUnavailableError: geçici sorun — oturumu SİLME, kullanıcıya "tekrar dene" göster
    // (ayrıntı: aşağıdaki "Geçici hata" notu).
    throw err
  }

  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    // Token tarayıcıda geçerli ama backend reddetti: büyük olasılıkla backend'in
    // HESABIM_AUDIENCE / issuer ayarı yanlış. Otomatik login'e ATMA — sonsuz
    // yönlendirme döngüsü olur. Hata göster.
    throw new ApiError(401, 'Oturum doğrulanamadı.')
  }
  if (res.status === 403) throw new ApiError(403, 'Bu işlem için yetkin yok.')
  return res
}
```

Vue'da plugin kullanıyorsan `hesabim` yerine bileşen dışından erişim için
client'ı bir kez modül değişkenine al:

```ts
// src/auth/hesabim.ts  (Vue varyantı)
import { useHesabim, type HesabimVue } from '@hayrat/hesabim-vue'
let api: HesabimVue | undefined
export function bindHesabim(app: import('vue').App) { api = app.runWithContext(() => useHesabim()) }
export function hesabim(): HesabimVue {
  if (!api) throw new Error('bindHesabim(app) çağrılmadı')
  return api
}
// main.ts: app.use(createHesabim({...})); bindHesabim(app)
```

…ve `api.ts`'te `hesabim.getAccessToken()` yerine `hesabim().getAccessToken()`.

**Bu ayrım kritik:** `AuthUnavailableError`'ı `AuthRequiredError` gibi ele
alırsan, ağdaki her titremede tüm kullanıcılar giriş ekranına atılır.

**Geçici hata — "tekrar dene" ne zaman gerçekten kurtarır:**

- Hata refresh isteği **gönderilmeden önce** oluştuysa (keşif belgesi
  alınamadı, tarayıcı depolamaya yazamadı) oturum dokunulmadan kalır;
  sonraki `getAccessToken()` normal şekilde tekrar dener.
- Hata refresh isteği **gönderildikten sonra** oluştuysa (ağ koptu, IdP 5xx
  döndü, yanıt okunamadı) refresh token'ın harcanıp harcanmadığı bilinemez.
  SDK eski token'ı tekrar göndermez — gönderseydi IdP bunu yeniden kullanım
  sayıp tüm oturum ailesini iptal ederdi. Bu durumda **sonraki**
  `getAccessToken()` oturumu temizler ve `AuthRequiredError` fırlatır: kullanıcı
  bir kez yeniden giriş yapar (IdP oturumu açıksa bu sessiz bir yönlendirmedir).

Yani "tekrar dene" butonu her durumda doğru tepkidir; ikinci denemede
`AuthRequiredError` gelirse normal `login()` yoluna düşer.

**API'yi aynı origin'den sun (varsayılan).** SPA ve API aynı origin'de
(`https://ornek.hayrat.com` + `/api/...`) olduğunda tarayıcı CORS'a hiç
girmez. Prod'da bunu reverse proxy (nginx/Traefik/Caddy: `/api` → backend)
yapar; geliştirmede dev sunucusunun proxy'si:

```ts
// vite.config.ts → server
server: {
  port: 5173, strictPort: true,
  proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
}
```

`VITE_API_BASE_URL`'i boş bırak. **API ayrı bir origin'de olmak zorundaysa**
(`https://api.ornek.hayrat.com`), backend'in kendi CORS'unu açması gerekir:
`Authorization` header'ı her istekte bir preflight (`OPTIONS`) tetikler ve bu
istek **token taşımaz**. Backend'de CORS katmanı kimlik doğrulama
middleware'inden **önce** çalışmalı, `OPTIONS`'ı token istemeden yanıtlamalı ve
yalnız izinli origin listesine `Access-Control-Allow-Origin` +
`Access-Control-Allow-Headers: Authorization, Content-Type` dönmelidir. Go
örneği: [hesabim-sdk-go → IMPLEMENTATION.md](https://github.com/hayrat/hesabim-sdk-go/blob/main/IMPLEMENTATION.md).
Bu sıralama yanlışsa her API çağrısı tarayıcıda CORS hatası olarak görünür
(preflight 401 aldığı için).

Axios kullanan projede aynı mantık bir request interceptor'dır:
`config.headers.Authorization = 'Bearer ' + await hesabim.getAccessToken()`.

### 5.6 Route koruması

`isAuthenticated()` **senkrondur** ve "access token süresi dolmuş ama
yenilenebilir" durumunu da oturum sayar — guard'da ağ beklemesi yoktur.

**Vue Router:**

```ts
// src/router/index.ts — korunan route'lara meta: { requiresAuth: true }
import { hesabim } from '@/auth/hesabim'   // §5.5'teki Vue varyantı

router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true
  if (hesabim().isAuthenticated.value) return true
  await hesabim().login({ returnTo: to.fullPath })
  return false
})
```

Rol gerektiren sayfa için `meta: { role: 'moderator' }` ekleyip guard'da
`hesabim().can(to.meta.role)` kontrol et ve `false` ise bir "yetkisiz"
sayfasına yönlendir. Bu yalnız **görünüm** içindir (§7).

**React Router:**

```tsx
import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useHesabim } from '../auth/useHesabim'   // §5.10

export function RequireAuth({ children, role }: { children: ReactNode; role?: string }) {
  const { isAuthenticated, can, login } = useHesabim()
  const location = useLocation()
  useEffect(() => {
    if (!isAuthenticated) void login({ returnTo: location.pathname + location.search })
  }, [isAuthenticated, location.pathname, location.search])
  if (!isAuthenticated) return null
  if (role && !can(role)) return <Navigate to="/yetkisiz" replace />
  return <>{children}</>
}
```

### 5.7 Kullanıcı bilgisi

```ts
const user = hesabim.getUser()
// { sub: 'uuid', name?: 'Ahmet Yılmaz', gender?: 'male' | 'female', profileVersion?: number } | null
```

- `name` tek alandır (ad + soyad birleşik).
- **E-posta ve telefon yoktur** ve gelmeyecek (§8.3).
- Değişiklikleri dinlemek için `hesabim.onAuthStateChanged(cb)` (unsubscribe
  döner). Başka sekmede çıkış yapılması da buradan gelir. Vue'da `user` ve
  `isAuthenticated` ref'leri bunu zaten yapar.

### 5.8 Çıkış

```ts
await hesabim.logout()   // yerel oturumu siler, sonra IdP'nin çıkış ucuna yönlenir
```

IdP oturumu kapatır ve kullanıcıyı `postLogoutRedirectUri`'ye döndürür. Bu URI
kayıtlı değilse IdP bir "çıkış yapıldı" sayfası gösterir ve geri dönmez — §2'de
çıkış URI'lerini kaydettirmeyi unutma. IdP'ye ulaşılamasa bile tarayıcıdaki
oturum mutlaka silinir.

Tarayıcıda saklı bir oturum yoksa (hiç giriş yapılmamış, başka sekmede çıkılmış)
IdP'ye gidilmez — Hesabım'ın çıkış ucu `id_token_hint` olmadan istek kabul
etmez. SDK yalnız yerel durumu temizler ve doğrudan `postLogoutRedirectUri`'ye
(yoksa uygulamanın köküne) döner.

### 5.9 Profil senkronu (opsiyonel — backend kullanıcı tablosu tutuyorsa)

Backend'in kendi `users` tablosu varsa (§10) kullanıcıyı ilk girişte
oluşturup her girişte güncellemesi gerekir. Access token'da **isim yoktur**;
`sub` ve `hayrat_profile_ver` vardır. İsim ve cinsiyet yalnızca ID token'dadır
ve SDK ham ID token'ı dışarı vermez — `getUser()` üzerinden okunur.

Desen: callback'ten sonra (ve `user.profileVersion` değiştiğinde) backend'e
bildir:

```ts
// handleCallback() başarılı olduktan sonra
const u = hesabim.getUser()
if (u) {
  await api('/api/me/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: u.name ?? null, gender: u.gender ?? null }),
  })
}
```

Backend tarafında **kimlik (`sub`) her zaman doğrulanmış access token'dan**
alınır, gövdeden asla. `name`/`gender` gövdesi kullanıcının kendi tarayıcısından
gelen beyan değeridir: yalnızca o kullanıcının kendi kaydının **görünen
bilgisi** olarak kullanılabilir, yetki kararında kullanılamaz. Backend ucu Go
SDK dokümanında tarif edilir.

### 5.10 React — küçük hook (paket yoktur, kendin yaz)

```tsx
// src/auth/useHesabim.ts
import { useSyncExternalStore } from 'react'
import type { HayratScope, HesabimUser } from '@hayrat/hesabim-core'
import { hesabim } from './hesabim'

type AuthSnapshot = { isAuthenticated: boolean; user: HesabimUser | null }

// Snapshot abonelerden bağımsız tutulur: getSnapshot her çağrıldığında SDK'nın
// GÜNCEL durumunu okur ve yalnız değer değiştiyse yeni nesne döner. Böylece
// hiçbir bileşen abone değilken olan değişiklik (ör. callback sayfasında
// handleCallback()) da kaçmaz; React aynı referansı aldığı sürece yeniden
// çizmez (useSyncExternalStore'un istediği kararlılık budur).
let snapshot: AuthSnapshot = { isAuthenticated: false, user: null }
function getSnapshot(): AuthSnapshot {
  const isAuthenticated = hesabim.isAuthenticated()
  const user = hesabim.getUser()
  const same =
    snapshot.isAuthenticated === isAuthenticated &&
    snapshot.user?.sub === user?.sub &&
    snapshot.user?.name === user?.name &&
    snapshot.user?.gender === user?.gender &&
    snapshot.user?.profileVersion === user?.profileVersion
  if (!same) snapshot = { isAuthenticated, user }
  return snapshot
}
function subscribe(onChange: () => void) {
  return hesabim.onAuthStateChanged(() => onChange())
}

export function useHesabim() {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  return {
    ...state,
    login: (opts?: { returnTo?: string }) => hesabim.login(opts),
    logout: () => hesabim.logout(),
    getAccessToken: () => hesabim.getAccessToken(),
    can: (role: string, ...targets: HayratScope[]) => hesabim.can(role, ...targets),
  }
}
```

### 5.11 SSR çatıları (Nuxt, Next.js, SvelteKit)

Paketi sunucuda **import etmek** güvenlidir; `createHesabimClient()`'ı sunucuda
**çağırmak** değildir — `location` ve Web Storage gerektirdiği için fırlatır.

- **Nuxt 3:** `plugins/hesabim.client.ts` (`.client` soneki) içinde
  `nuxtApp.vueApp.use(createHesabim({...}))`; değerler
  `useRuntimeConfig().public.hesabimIssuer` / `hesabimClientId`.
  Callback sayfası `pages/auth/callback.vue`, `ssr: false` route rule'u ile
  ya da `<ClientOnly>` içinde.
- **Next.js (App Router):** client modülü `'use client'` bir dosyada, tembel
  oluşturulur (`let c; export const getHesabim = () => c ??= createHesabimClient({...})`);
  callback `app/auth/callback/page.tsx` bir client component.
- **SvelteKit:** client'ı `browser` kontrolüyle (`$app/environment`)
  oluştur; callback route'unda `export const ssr = false`.

Sunucu tarafında render edilen sayfalar kullanıcıyı **bilemez** (token
tarayıcıdadır). Sunucuda kimlik gerekiyorsa SPA değil BFF yolu doğrudur.

---

## 6. Backend tarafı — token doğrulama

Frontend'in `can()` sonucu **yalnızca görünüm** içindir. Her yetki kararı
backend'de, doğrulanmış access token üzerinden verilir.

### 6.1 Backend Go ise

`hesabim-sdk-go` kullan:
<https://github.com/hayrat/hesabim-sdk-go/blob/main/IMPLEMENTATION.md>.
Backend env: `HESABIM_ISSUER_URL=https://hesabim.hayrat.com`,
`HESABIM_AUDIENCE=api:<proje-key>`.

### 6.2 Backend Go değilse — doğrulama kuralları

Olgun bir JWT/JOSE kütüphanesi kullan ve **hepsini** uygula. Bu liste Go
SDK'nın doğrulayıcısıyla birebir aynıdır; herhangi bir kural ihlali token'ın
**tamamını** reddeder (kısmi okuma yok):

1. **Boyut:** 4096 bayttan uzun token'ı ayrıştırmadan reddet (IdP daha büyüğünü
   üretmez).
2. **Keşif:** `GET <issuer>/.well-known/openid-configuration` → `jwks_uri` ve
   `issuer`. Sondaki `/` dışında yapılandırdığın issuer ile aynı olmalı.
3. **İmza:** JWKS'teki public key ile. **Algoritma yalnızca `ES256`** — `alg`
   ne derse desin başkası kabul edilmez (`none`, `HS256` dahil); bu kontrol
   anahtar aranmadan önce yapılır. Header'da `kid` **zorunlu**; `kid`siz token
   reddedilir ("her anahtarı dene" yok). Bilinmeyen `kid`'de JWKS'i yeniden çek
   — hız sınırlı (en fazla dakikada bir).
4. **`iss`:** keşif belgesindeki `issuer` ile **bayt bayt** aynı (normalize
   etme).
5. **`aud`:** ya tek bir string ya da **tek elemanlı** bir dizi ve değeri tam
   olarak `api:<proje-key>`. Birden çok elemanlı dizi, içinde senin audience'ın
   olsa bile **reddedilir** (IdP token başına tek audience basar).
6. **Zaman (tolerans 30 sn):** `exp`, `iat`, `nbf` üçü de **zorunlu** ve sayı.
   `now < exp + 30sn`; `iat ≤ now + 30sn`; `nbf ≤ now + 30sn`. Yıl 1–9999
   aralığı dışındaki değer tarih sayılmaz → ret.
7. **Zorunlu string claim'ler** (boş olamaz): `jti`, `client_id`, `sub`, `sid`.
8. **`amr`:** boş olmayan dizi, her elemanı boş olmayan string.
9. **`hayrat_principal`** claim'i **varsa** (değeri ne olursa olsun) → ret. Bu
   bir servis token'ıdır, kullanıcı token'ı değil.
10. **`hayrat_ver`:** **sayı** olarak `1`. `"1"` (string) ya da başka bir değer →
    ret.
11. **`hayrat_grants`:** dizi olmalı (`null`/yok → ret; boş dizi `[]` geçerli).
    Her eleman `{ "role": <boş olmayan string>, "scopes": <dizi> }`:
    - Aynı `role` iki kez geçerse → ret.
    - `scopes` yok ya da `null` → ret (boş dizi = **proje geneli**, yokluk
      değil).
    - Her kapsam `{ "type": <boş olmayan string>, "id": <tam sayı> }`; `id`
      **1 ile 2^53−1 arasında tam sayı** (`1.0`, `1e2`, `0`, negatif → ret).
      Büyük sayıları kayıpsız okuyan bir JSON ayrıştırıcısı kullan.
    - Tanımadığın bir `type` reddedilmez; yalnız hiçbir hedefle eşleşmez.
12. `hayrat_profile_ver` opsiyoneldir; yok/bozuk ise `0` say, **reddetme**.
13. Başarısızlıkta **401**; yetkisi olmayan doğrulanmış kullanıcıya **403**.

Yetki kontrolü için `hayrat_grants`'ı §7'deki semantikle yorumla.

---

## 7. Yetki modeli — `can(rol, hedefler…)`

Access token her rolü **kendi kapsamıyla** taşır:

```json
"hayrat_grants": [
  { "role": "moderator", "scopes": [{ "type": "province", "id": 6 }] },
  { "role": "viewer",    "scopes": [] }
]
```

```ts
hesabim.can('moderator', { type: 'province', id: 6 })   // true
hesabim.can('moderator', { type: 'province', id: 35 })  // false
hesabim.can('viewer')                                   // true  — boş scopes = proje geneli
hesabim.can('moderator')                                // false — kapsamlı rol proje geneli DEĞİLDİR
hesabim.can('moderator', ankara, izmir)                 // AND — her hedef kapsanmalı
```

**`hasRole()` / `inScope()` yazma.** `hasRole('moderator') && inScope(İzmir)`
kimsenin vermediği bir kombinasyonu yetkilendirir — rolün kapsamıyla birlikte
taşınmasının sebebi budur. Rol listesi gerekirse bile yetki kararı `can()`
ile verilir.

**Kapsam sözlüğü:** `region` (bölge) · `province` (il) · `district` (ilçe) ·
`school` (okul). Ülke seviyesi yoktur — "her yer" demek **kapsamsız rol**
demektir. Kapsam `id`'leri Hesabım'ın referans verisinin sayısal kimlikleridir.
Yerlerde köprü **guid**'dir: Hesabım yer kaydının sahibidir ve guid'ler eski yer
servisinin (yer.hayrat.dev) guid'leriyle aynıdır. id↔guid listesini Hesabım
yöneticisinden iste.

Türkiye'nin 81 ili ve İçişleri Bakanlığı listesindeki 973 ilçenin hepsi vardır.
Vakfın kendi ilçeleri de (büyükşehirde "Merkez", ilçe gibi yürütülen belde/köy)
geçerli kapsam hedefidir; Hesabım bunları `is_official: false` olarak işaretler.
`can()` bu ayrımı umursamaz — yalnız `(type, id)` karşılaştırır.

**Hiyerarşi (il → ilçe):** eşleşme `(type, id)` üzerinde birebirdir; SDK "il,
ilçelerini kapsar" bilgisini bilmez. Gerekiyorsa çözücü ver — yalnız birebir
eşleşme başarısız olunca çağrılır:

```ts
createHesabimClient({
  // …
  scopeResolver: (granted, target) =>
    granted.type === 'province' && target.type === 'district'
    && districtsOf(granted.id).includes(target.id),   // kendi verinden
})
```

Hatalı hedef (boş `type`, tam sayı olmayan `id`) her zaman reddedilir.

---

## 8. Token sözleşmesi ve süreler

### 8.1 Access token (JWT, ES256)

| Claim | Değer |
|---|---|
| `iss` | `https://hesabim.hayrat.com` |
| `sub` | Kullanıcının **kalıcı UUID**'si |
| `aud` | `api:<proje-key>` |
| `client_id` | Token'ı alan client |
| `exp` / `iat` | §8.2 |
| `sid` | Oturum kimliği |
| `amr` | Bugün `["otp"]` |
| `hayrat_ver` | Sözleşme sürümü, `1` |
| `hayrat_profile_ver` | Kullanıcının profil sürümü (sayı) — profil değişince artar |
| `hayrat_grants` | §7 |

**ID token** (`profile` scope ile): `sub`, `name`, `gender` (`male`/`female`),
`hayrat_profile_ver`. SDK bunu `getUser()` ile verir.

### 8.2 Süreler

| Ne | Süre |
|---|---|
| Authorization code | 2 dk, tek kullanımlık |
| **Access token** | **10 dk** — rol değişikliği en geç bu kadar sonra yansır |
| Oturum | **90 gün, kayan** — her yenileme uzatır; düzenli kullanan yeniden giriş yapmaz |
| Refresh token | Oturumun kalan ömrü; **her kullanımda döner** (rotation) |

Aynı refresh token'ın ikinci kez kullanılması tüm oturumu iptal eder. SDK bunu
sekmeler arası kilitle önler — **refresh'i elle yapmaya çalışma.**

IdP tarafında çıkış yapıldığında uygulamaya bildirim gitmez: refresh token
anında ölür, elindeki access token en fazla 10 dk daha geçerli kalır.

### 8.3 Kesinlikle olmayanlar (tasarım kararı)

- `/userinfo` ucu yok.
- `email`, `phone`, `address` scope'ları ve claim'leri yok — e-posta/telefon
  hiçbir token'da gelmez. Gerekirse uygulama kendisi sorar.
- Bu SDK'larla entegre edilen uygulama client'larına `client_credentials`
  verilmez; servis-servis token alınamaz (bir servis kendi adına Hesabım'dan
  token isteyemez).
- Introspection / revocation uçları yok.
- Back-channel / front-channel logout bildirimi yok.

---

## 9. Redirect URI ve CORS

- Tarayıcının token isteği (`/oauth/token`) **yalnız kayıtlı redirect URI'lerin
  origin'lerinden** kabul edilir. Ayrı CORS ayarı yoktur.
- Yeni kayıt / değişiklik en geç **~1 dakika** içinde etkinleşir.
- Canlı Hesabım'da yalnız `https` origin'leri sayılır — **`http://localhost`
  dahil hiçbir `http` origin'i açılmaz**. Yerel geliştirme
  `https://localhost:<port>` ile yapılır (§4.1).
- Joker karakter (wildcard) yoktur. Her ortam (staging dahil) ayrı ayrı
  kaydedilir.

CORS engelinin görünümü: konsolda `blocked by CORS policy`, SDK'dan
`AuthUnavailableError`, network panelinde `/oauth/token`'a giden ve yanıtında
`Access-Control-Allow-Origin` olmayan bir istek. SDK'nın token isteği
form-encoded bir `POST`'tur ve çoğu tarayıcıda **preflight (`OPTIONS`)
gerektirmez** — engellenen istek doğrudan `POST` olarak görünebilir, `OPTIONS`
aramaya kalkma. Çözüm koda değil **kayda** dokunmaktır.

---

## 10. Kullanıcı verisi — Hesabım ne tutar, sen ne tutarsın

- **`sub` birincil anahtarındır.** Kalıcıdır, yeniden kullanılmaz, e-posta /
  telefon değişse de değişmez. Kendi tablolarında kullanıcıyı bu UUID ile
  anahtarla; e-posta ya da isimle eşleme yapma.
- Hesabım bir **kullanıcı dizini sunmaz**: kullanıcı listeleme/arama API'si
  yoktur. Uygulamanın kendi projeksiyonunu tutar:

  ```sql
  users(sub UUID PRIMARY KEY, name TEXT, gender TEXT, profile_ver BIGINT, last_seen_at TIMESTAMPTZ, …)
  ```

  Satır ilk girişte yaratılır, her girişte güncellenir (§5.9). Uygulamaya özgü
  her şey (sınıf, okul, durum…) burada ya da yanındaki tablolarda yaşar.
- Hiç giriş yapmamış bir kullanıcının adını gösteremezsin. Göç edilen eski
  veri için toplu eşleme gerekiyorsa bu Hesabım yöneticisiyle yapılan bir
  kerelik veri devridir, API değildir.
- Kullanıcı adını/e-postasını Hesabım'da değiştirmek isterse onu
  `https://hesabim.hayrat.com`'a yönlendir.

---

## 11. Güvenlik notları

- Token'lar `localStorage`'dadır (bilinçli karar). **Uygulamandaki her XSS tam
  hesap ele geçirmedir.** Sıkı bir CSP (`script-src 'self'`, inline script yok)
  burada asıl korumadır. `v-html` / `dangerouslySetInnerHTML`'e kullanıcı
  verisi verme.
- Token'ı loglama, hata izleyiciye (Sentry vb.) gönderme, URL'e koyma.
- SDK tarayıcıda imza doğrulamaz (token'ı kendisi TLS üzerinden aldı); bu
  yüzden **backend doğrulaması zorunludur** (§6).
- `can()` / `getUser()` görünüm içindir; güvenlik sınırı backend'dir.

---

## 12. Kontrol listesi

**Kayıt (yönetici):**
- [ ] Proje anahtarı kesin (değiştirilemez); audience `api:<key>`
- [ ] Client tipi `public`
- [ ] Redirect URI'ler prod **ve** `https://localhost:<port>` için birebir
      (`/auth/callback`); listede hiç `http://` yok
- [ ] Çıkış URI'leri kayıtlı
- [ ] Roller tanımlı; test kullanıcısına rol (+ gerekiyorsa kapsam) atandı

**Kod:**
- [ ] Issuer ve client id env'den okunuyor; eksikse açılışta net hata
- [ ] Uygulamada tek client örneği (Vue'da yalnız plugin)
- [ ] `/auth/callback` route'u var, korumasız, `handleCallback()` **bir kez**
- [ ] Her API çağrısından önce `getAccessToken()`; token bir yerde saklanmıyor
- [ ] `AuthRequiredError` → `login()`, `AuthUnavailableError` → "tekrar dene"
      (**ayrı** ele alınıyor)
- [ ] Backend 401'i otomatik login'e yönlendirmiyor (döngü riski)
- [ ] Korunan route'larda guard var
- [ ] Çıkış `hesabim.logout()` ile
- [ ] Yetki `can(rol, hedef)` ile; `hasRole` benzeri yardımcı **yok**
- [ ] Kapsam hiyerarşisi gerekiyorsa `scopeResolver` ile
- [ ] Hiçbir yerde client secret yok; token loglanmıyor
- [ ] Backend access token'ı doğruluyor, `aud` = `api:<key>` (§6)
- [ ] SSR çatısında client yalnız tarayıcıda oluşturuluyor
- [ ] Dev sunucusu HTTPS ve sabit portta (§4.1)
- [ ] API aynı origin'de (proxy) ya da backend CORS'u auth'tan önce çalışıyor (§5.5)

---

## 13. Doğrulama

**Otomatik (ajan çalıştırır):**

1. `typecheck` + `build` + mevcut testler yeşil.
2. Varsa birim testinde `@hayrat/hesabim-core` mock'lanarak `api()`
   sarmalayıcısının üç yolu test edilir: token eklenir; `AuthRequiredError`'da
   `login` çağrılır; `AuthUnavailableError`'da `login` **çağrılmaz**.

**Elle (kayıt tamamlandıktan sonra):**

1. `npm run dev` → `https://localhost:<port>` (sertifika uyarısını bir kez
   kabul et) → korunan bir sayfaya git → Hesabım giriş ekranına yönlenmeli.
2. Giriş yap → `/auth/callback` → başlangıçtaki sayfaya dönmeli.
3. Network: `/oauth/token` isteği 200; API isteklerinde
   `Authorization: Bearer …` var; API 200 dönüyor.
4. Sayfayı yenile → yeniden giriş istenmemeli.
5. İkinci sekme aç → oturum açık olmalı. Bir sekmede çıkış → diğeri de
   çıkmış görünmeli.
6. 10+ dk bekle, bir API çağrısı yap → sessizce yenilenmeli (`/oauth/token`
   `grant_type=refresh_token`).
7. Access token geçerliyken ağı kes, API çağrısı yap → "tekrar dene" görünmeli,
   **çıkışa atılmamalı**. (Ağ tam refresh sırasında koparsa bir sonraki denemede
   yeniden giriş istenir — §5.5 "Geçici hata"; bu beklenen davranıştır.)

---

## 14. Sık yapılan hatalar

| Belirti | Sebep |
|---|---|
| IdP "invalid redirect_uri" | Redirect URI birebir kayıtlı değil (sondaki `/`, port, `http`/`https`) |
| IdP "redirect_uri is http and is not allowed" | SPA `http://localhost`'tan açılmış — public client'ta `http` yasak; dev sunucusunu HTTPS'e al (§4.1) |
| Token isteğinde CORS hatası | Origin kayıtlı redirect URI'lerden türemiyor; ya da kayıt yeni (~1 dk bekle); ya da sayfa `http`'den açılmış |
| API çağrılarında CORS hatası, IdP'de değil | API ayrı origin'de ve backend preflight'ı auth middleware'ine sokuyor (§5.5) — proxy kullan ya da CORS'u öne al |
| Dev sunucusu başka portta açıldı, giriş kırıldı | Port kaydı tutmuyor — `strictPort: true` (§4.1) |
| `config.redirectUri` hatası | Redirect URI sayfayla aynı origin'de değil |
| Giriş LAN IP'sinde çalışmıyor | Güvenli bağlam yok (`crypto.subtle`) ve adres kayıtlı değil — `https://localhost` kullan |
| Token alınıyor ama API 401 | Backend audience'ı yanlış (`api:` öneki dahil, key birebir) ya da issuer farklı ortam |
| Her 10 dakikada login | `scopes`'tan `offline_access` çıkarılmış |
| Callback'te `AuthRequiredError` | Callback sayfası yenilendi / iki kez çalıştı (React StrictMode) — kod tek kullanımlık |
| Ağ titremesinde herkes login'e atılıyor | `AuthUnavailableError` da `AuthRequiredError` gibi ele alınmış |
| Kullanıcılar rastgele çıkıyor | Refresh elle yapılmış / iki client örneği farklı ayarla — SDK'nın kilidi devre dışı |
| Çıkıştan sonra uygulamaya dönmüyor | `postLogoutRedirectUri` kayıtlı değil |
| `login()` hemen `AuthUnavailableError` | Tarayıcı `sessionStorage`'a yazmıyor (gizli mod kısıtı, depolama engeli) — giriş akışı bu tarayıcıda tamamlanamaz |
| `can('moderator')` false | Kapsamlı rol proje geneli değildir — hedef ver |
| Token'da e-posta/telefon yok | Yok ve gelmeyecek (§8.3) |
| Sunucuda `createHesabimClient` fırlatıyor | SSR — client yalnız tarayıcıda (§5.11) |

---

## 15. Ajanın teslim raporu

Entegrasyon bitince şu başlıklarla kısa bir rapor ver:

1. **Seçilen yol:** SPA / BFF ve framework; eklenen paketler.
2. **Değişen dosyalar** (yol listesi).
3. **Env anahtarları** ve hangilerinin boş/placeholder kaldığı.
4. **Hesabım yöneticisine gönderilecek kayıt talebi** (§2 şablonu, doldurulmuş:
   redirect ve çıkış URI'leri projenin gerçek dev portu ve prod domain'iyle).
5. **Yöneticiden beklenen değerler:** `client_id`, audience.
6. **Backend durumu:** token doğrulama var mı / Go SDK dokümanına göre
   yapılacak mı.
7. Çalıştırılan doğrulamalar ve sonuçları; çalıştırılamayanlar.
