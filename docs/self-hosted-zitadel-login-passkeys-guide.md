# Self-Hosted Zitadel + Login V2 + Passkeys — Implementation Guide

Portable guide distilled from the Tuệ Tâm migration (Supabase → self-hosted
Zitadel v4.15.3, Login V2, OIDC for 1 backend + 3 frontends, Google IdP, in-app
passkey/password self-service). Covers architecture, exact config, the API
surface used, and **every issue hit + its fix** so the next project skips the pain.

Verified stack: Zitadel **v4.15.3**, `ghcr.io/zitadel/zitadel-login:latest`
(Login V2, Next.js 16), Postgres, Traefik v3, Cloudflare Tunnel, FastAPI backend,
Flutter (web/PWA) + Next.js frontends.

---

## 1. Architecture

```
Browser ──HTTPS──► Cloudflare (TLS term) ──tunnel──► Traefik (:80) ──► {
   /ui/v2/login/*  → zitadel-login  (Login V2 Next.js, plain HTTP :3000)
   everything else → zitadel        (gRPC-gateway, h2c :8080)
}
Backend ──(service-account JWT)──► zitadel  (Management v1 + User/Session v2 APIs)
```

Key idea: **Login V2 and Zitadel core share ONE external origin** (`auth.<domain>`).
Traefik path-splits `/ui/v2/login/*` to the login app; everything else to core.
Passkeys (WebAuthn) bind to that origin's registrable domain (the RP ID), so the
login MUST always happen on the stable external domain (never `localhost`, never
a different host per app).

---

## 2. Zitadel core deployment (the non-obvious env)

```yaml
zitadel:
  image: ghcr.io/zitadel/zitadel:latest
  command: 'start-from-init --masterkey "${MASTERKEY}" --tlsMode external'
  environment:
    ZITADEL_EXTERNALSECURE: "true"      # generate https URLs
    ZITADEL_EXTERNALDOMAIN: auth.<domain>
    ZITADEL_EXTERNALPORT: "443"
    ZITADEL_DATABASE_POSTGRES_...        # standard PG wiring
    ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME/PASSWORD: admin bootstrap
    ZITADEL_FIRSTINSTANCE_MACHINEKEYPATH: /keys/sa-key.json  # SA key written here on init
```

- **`--tlsMode external` is mandatory behind a TLS-terminating proxy.** With
  `--tlsMode disabled`, Zitadel emits **`http://`** for the Console's `api` URL
  (derived from request scheme) even when `EXTERNALSECURE=true` — see Issue #2.
- `EXTERNALDOMAIN` is written into the instance at first init; changing it later
  on a live instance is not cleanly supported → set it correctly from day one.
  (Dev workaround: drop the `zitadel` DB + re-init.)
- After init, copy the generated SA key (`/keys/sa-key.json`) to where the backend
  + bootstrap read it.

---

## 3. Reverse proxy (Traefik file provider)

```yaml
http:
  routers:
    zitadel:        { rule: "Host(`auth.<d>`) && !PathPrefix(`/ui/v2/login`)", service: zitadel,       middlewares: [force-https-proto] }
    zitadel-login:  { rule: "Host(`auth.<d>`) && PathPrefix(`/ui/v2/login`)",  service: zitadel-login, middlewares: [force-https-proto], priority: 100 }
  middlewares:
    force-https-proto: { headers: { customRequestHeaders: { X-Forwarded-Proto: "https" } } }
  services:
    zitadel:       { loadBalancer: { passHostHeader: true, servers: [ { url: "h2c://zitadel:8080" } ] } }   # h2c! gRPC
    zitadel-login: { loadBalancer: { servers: [ { url: "http://zitadel-login:3000" } ] } }
```

- Core MUST be reached over **`h2c://`** (HTTP/2 cleartext) — it's gRPC-gateway.
- Trust forwarded headers on the entrypoint: `--entrypoints.web.forwardedheaders.insecure=true`.
- `force-https-proto` belt-and-suspenders for proxies that don't forward proto.
  (NOTE: inbound `Host`/`X-Forwarded-Host` from Cloudflare tunnel already arrive
  correct as `auth.<domain>` — you do NOT need to pin the WebAuthn host; see
  Issue #6 which looked like a host problem but wasn't.)

---

## 4. Bootstrap (idempotent, via service-account)

Authenticate with the FirstInstance SA key (JWT-bearer grant), then create
idempotently: SMTP, project, roles, OIDC apps (API + each frontend, PKCE public
clients), and a v1 Action on the Complement-Token flow that copies a user
metadata `role` → an `app_metadata.role` token claim (so the backend reads role
from the JWT). APIs: Management `/management/v1/*`, Admin `/admin/v1/*`,
resource `…/v2/*`.

**Per-frontend role derivation:** map each OIDC client id (`azp`) → a role, so the
app a user registers through decides their initial role (no blanket default).

---

## 5. Login V2 — enablement (THE critical, easily-missed step)

Login V2 is a **separate container**; enabling it has THREE parts:

1. **Container** `ghcr.io/zitadel/zitadel-login` with:
   ```yaml
   ZITADEL_API_URL: http://zitadel:8080           # internal
   NEXT_PUBLIC_BASE_PATH: /ui/v2/login
   ZITADEL_SERVICE_USER_TOKEN_FILE: /etc/login/login-client.pat
   CUSTOM_REQUEST_HEADERS: "x-zitadel-public-host:auth.<d>,Host:auth.<d>"  # outbound→core, so it resolves the instance
   ```
2. **Service user** = a machine user with the **`IAM_LOGIN_CLIENT`** role; mint a
   PAT, write to the file mounted above.
3. **Instance feature flag** (the step that silently breaks everything if missed):
   ```
   PUT /v2/features/instance  {"loginV2": {"required": true, "baseUri": "https://auth.<d>/ui/v2/login"}}
   ```
   Without `required: true`, OIDC login **falls back to the legacy V1 hosted login**
   (`/ui/login`) — see Issue #1, the single biggest time-sink.

Verify: `GET /v2/features/instance` → `loginV2.required == true`.

---

## 6. Social IdP (Google) — redirect URI

- Provision via Admin API `POST /admin/v1/idps/google` (template) then link to the
  default login policy (`POST /admin/v1/policies/login/idps`). **Update path is
  `PUT /admin/v1/idps/google/{id}`** — create is skip-on-exists, so changed
  client id/secret won't propagate unless you UPDATE (Issue #4).
- **Authorized redirect URI in Google** depends on the active login UI:
  - **Login V2:** `https://auth.<d>/idps/callback`
  - **Login V1:** `https://auth.<d>/ui/login/login/externalidp/callback`
  - If login isn't fully on V2 yet, Zitadel sends the **V1** callback → register
    **both** in Google to be safe (Issue #5).
- Authorized JavaScript origins: **leave empty** (server-side code exchange).

---

## 7. Passkeys (WebAuthn) + password self-service — API + all 3 clients

Passkey enrollment needs a **WebAuthn ceremony in a browser on the RP-ID domain** —
do NOT reimplement it in-app. The pattern is the same for every client:

```
[client Security menu] → [your backend /me/security/*] → [Zitadel v2 API via SA]
       │                                                        └─ mints a one-time code
       └─ opens the returned Login V2 URL in a browser → user does fingerprint/face
```

The client never speaks to Zitadel directly and never handles WebAuthn — it just
opens a URL your backend builds. List/remove/reset are plain JSON calls.

### 7.1 Zitadel User Service v2 endpoints (backend → Zitadel, SA token)
| Action | Method + path |
| --- | --- |
| Create registration link | `POST /v2/users/{id}/passkeys/registration_link` body `{"returnCode":{}}` → `{code:{id,code}}` |
| List | `POST /v2/users/{id}/passkeys/_search` → `{result:[{id,name,state}]}` |
| Remove | `DELETE /v2/users/{id}/passkeys/{passkeyId}` |
| Password reset | `POST /management/v1/users/{id}/_reset_password` (v1 — mixed generation, see note) |
| Begin login (debug) | `POST /v2/sessions` then `PATCH /v2/sessions/{id}` with `{challenges:{webAuthN:{domain:"auth.<d>",userVerificationRequirement:"…REQUIRED"}}}` |

Passkey/session endpoints live at `{issuer}/v2/...` (NOT under `/management/v1`);
password reset is still v1. In this repo the SA wrappers are
`apps/api/app/clients/zitadel_admin.py` (`create_passkey_registration_link`,
`list_passkeys`, `remove_passkey`, `recover_password`).

### 7.2 Your backend self-service API (what the clients call)
Expose a thin, per-user router so clients never touch Zitadel or the Console.
In this repo: `apps/api/app/routers/security.py`, prefix `/me/security`, guarded by
the current principal (400 if the session isn't a Zitadel one):

| Route | Method | Response |
| --- | --- | --- |
| `/me/security/passkey/registration-link` | POST | `{ "url": "<login-v2 enroll url>" }` |
| `/me/security/passkeys` | GET | `[{ id, name?, state? }]` |
| `/me/security/passkeys/{id}` | DELETE | `{ "message": "…" }` |
| `/me/security/password/reset-email` | POST | `{ "message": "…" }` (uses the token's own email → no account enumeration) |

**Enrollment URL builder** — the deployed login app (`zitadel/zitadel:apps/login`)
reads **`codeId`**, NOT `id` (Issue #3):
```python
base = settings.zitadel_login_v2_url_resolved  # → {issuer}/ui/v2/login
params = {"userId": user_id, "code": code["code"], "codeId": code["code_id"]}
if principal.org_id:
    params["organization"] = principal.org_id
url = f"{base}/passkey/set?{urlencode(params)}"
# → https://auth.<d>/ui/v2/login/passkey/set?userId=…&code=…&codeId=…&organization=…
```

### 7.3 Flutter clients (member-app + expert-app)
`SecuritySelfService` (static methods) + a `_PasskeySheet` bottom sheet, wired from
the Profile screen. Files: `apps/{member,expert}-app/lib/core/auth/security_self_service.dart`
(logic is byte-identical between the two apps — only the SnackBar messenger source
differs: member uses `ScaffoldMessenger.maybeOf(context)`, expert a global
`rootScaffoldMessengerKey`).

Methods: `addPasskey` (POST link → open URL), `fetchPasskeys` (GET), `deletePasskey`
(DELETE), `sendPasswordReset` (POST), `managePasskeys` (shows the sheet). No
dedicated provider — they take `WidgetRef` and read `apiClientProvider` (Dio).

**The launchUrl gotcha (Issue #9):** after an `await`, opening a *new* tab loses the
user gesture and is popup-blocked on web. So web navigates the **current** tab
(`_self`); native opens the external browser:
```dart
final ok = await launchUrl(
  Uri.parse(url),
  mode: kIsWeb ? LaunchMode.platformDefault : LaunchMode.externalApplication,
  webOnlyWindowName: kIsWeb ? '_self' : '_blank',
);
```
The sheet re-fetches the passkey list on `AppResumed`
(`didChangeAppLifecycleState`) so a passkey added in the browser appears on return.

### 7.4 Next.js web-admin
API client `apps/web-admin/src/lib/api/security.ts` (`createPasskeyRegistrationLink`,
`listPasskeys`, `removePasskey`, `sendPasswordResetEmail` — all via `fetchWithAuth`);
UI in the "Bảo Mật" card of `apps/web-admin/src/app/(dashboard)/profile/page.tsx`.

Web can't use the Flutter `_self` trick (it would navigate away from the admin).
Instead **open a blank tab synchronously inside the click** (before any `await`, so
the gesture is still valid), then set its `location.href` once the URL resolves:
```js
const win = window.open('', '_blank', 'noopener,noreferrer')  // sync — keeps the gesture
try {
  const url = await createPasskeyRegistrationLink()
  if (win) win.location.href = url
  else window.location.href = url        // popup blocked → fall back to same tab
} catch (e) { win?.close(); toast.error(/* … */) }
```

### 7.5 Rules that bite
- **Three open strategies, one goal (beat the popup blocker):** Flutter-web = current
  tab; Flutter-native = external browser; web = pre-opened blank tab then redirect.
  Pick per platform; don't copy the web trick into Flutter or vice-versa.
- **Never deep-link end-users to the Zitadel Console** — it hides the passkey/MFA
  cards for users without Zitadel management roles (Issue #7). Always go through your
  own `/me/security/*` API.
- One RP-ID domain for every client (login always on `auth.<domain>`), or WebAuthn
  credentials won't verify across apps.

---

## 8. Backend OIDC integration

- Validate access tokens: RS256 via JWKS `{issuer}/oauth/v2/keys`; check `iss` ==
  configured issuer; enrich from `/oidc/v1/userinfo` (cache it).
- Service-account client: JWT-bearer grant from the SA key JSON; cache token until
  ~30s before expiry. Scope `openid urn:zitadel:iam:org:project:id:zitadel:aud`.
- Carry both the internal user id and the **raw Zitadel user id (`sub`)** on your
  principal — passkey/session APIs need the Zitadel id; the org id (`resourceOwner`)
  comes from the token too.

---

## 9. Custom Login V2 image (Vietnamese `vi` fork)

Full in-repo reference: `deploy/zitadel-login/` (`Dockerfile`, `apply-vi-locale.mjs`,
`README.md`) + the strings in `deploy/zitadel/login_v2_vi_translations.json`.

### 9.1 Why a custom image is unavoidable for `vi`
- Login V2 bundles ~14 locales; **Vietnamese is NOT among them, and Zitadel core
  does NOT list `vi` as a supported instance language** → `PUT
  /admin/v1/languages/default/vi` returns `400 LANG-lg4DP`. You cannot set `vi` as
  default/allowed (Issue #8).
- `PUT /v2/settings/hosted_login_translation` accepts a `vi` payload but it's inert
  without `vi` being a *selectable* locale.

⇒ To truly ship a Vietnamese login you must **bake `vi` into a custom Login V2
image at build time.**

### 9.2 Why a source rebuild, NOT a `FROM …zitadel-login` overlay
Two upstream facts (verified on `v4.15.3`) make a runtime overlay impossible:
1. **Supported locales are a hardcoded `LANGS` array** (`apps/login/src/lib/i18n.ts`).
   The switcher AND the Accept-Language / `NEXT_LOCALE`-cookie gates all key off it.
   In the published image `LANGS` is minified into the server bundle → not patchable.
2. **Messages are bundled at build time** via `import(\`../../locales/${locale}.json\`)`
   — a webpack context module fixed at build. A `vi.json` COPYed into a running
   container is never in the map, so it's ignored.

So the fork **clones the pinned upstream source, patches it, and rebuilds.**

### 9.3 The overlay — 4 idempotent, anchor-based edits (`apply-vi-locale.mjs`)
Each edit fails **loudly** if its upstream anchor text is gone (the signal to
re-check the script against a new release tag):
1. `apps/login/src/lib/i18n.ts` — add `{name:"Tiếng Việt", code:"vi"}` to `LANGS`.
2. `apps/login/src/app/(login)/layout.tsx` — **re-add `vi` to the switcher list.**
3. `apps/login/src/i18n/request.ts` — **re-add `vi` to `allowedLanguages`** + honour
   a `LOGIN_DEFAULT_LOCALE` env var as the base default locale.
4. `apps/login/src/i18n/request.ts` — when `LOGIN_DEFAULT_LOCALE` is set, do NOT let
   the browser `Accept-Language` override it (hard default; remove for soft default).

**The real gotcha behind edits 2 & 3 (the intersection):** both files intersect
`LANGS` with the instance's `getGeneralSettings().allowedLanguages`. That call
returns Zitadel's supported set **even with no restrictions**, and it doesn't
include `vi` — so a bare `LANGS` patch silently drops `vi` again. The fork treats
`vi` as a **login-only locale**, re-added after the intersection, independent of any
instance language setting.

### 9.4 The Dockerfile (build-time bake)
Multi-stage, pinned to the exact server release; build context = `deploy/`:
```dockerfile
ARG ZITADEL_VERSION=v4.15.3
ARG NEXT_PUBLIC_BASE_PATH=/ui/v2/login   # basePath is baked in — must match the proxy path
FROM node:24-bookworm-slim AS builder
RUN git clone --depth 1 --branch ${ZITADEL_VERSION} https://github.com/zitadel/zitadel.git .
COPY zitadel/login_v2_vi_translations.json apps/login/locales/vi.json   # the strings
COPY zitadel-login/apply-vi-locale.mjs /tmp/apply-vi-locale.mjs
RUN node /tmp/apply-vi-locale.mjs                                        # the 4 edits
RUN pnpm install --frozen-lockfile && pnpm exec nx build @zitadel/login  # heavy: proto→client→login
FROM node:24-alpine AS runtime   # mirrors upstream apps/login/Dockerfile (same user/env/healthcheck)
COPY --from=builder --chown=nextjs:nodejs /src/apps/login/.next/standalone ./
ENTRYPOINT ["/app/entrypoint.sh", "node", "apps/login/server.js"]
```
Notes: the `vi.json` is the **single source of truth** — the same file the bootstrap
uploads via the hosted-login-translation API. `NEXT_PUBLIC_BASE_PATH` is frozen at
build; change the serve path ⇒ rebuild.

### 9.5 Locale resolution at runtime (`LOGIN_DEFAULT_LOCALE`)
Order, after `vi` is re-added to `allowedLanguages`:
1. Instance default (can't be `vi`) → overridden by **`LOGIN_DEFAULT_LOCALE=vi`** →
   base default for everyone.
2. `Accept-Language` header — **skipped** while `LOGIN_DEFAULT_LOCALE` is set (hard
   default: an English browser still lands on Vietnamese).
3. `NEXT_LOCALE` cookie / OIDC `?ui_locales=<code>` — still highest. Switcher choice
   sticks; a client can force English with `?ui_locales=en`.

`LOGIN_DEFAULT_LOCALE=vi` is set in both compose files. For **soft** default (respect
the browser, fall back to `vi`) remove edit 4 and rebuild. For a **vi-only** UI, trim
`LANGS` to `[en, vi]`.

### 9.6 Build / deploy / rollback
```bash
# Build (context = deploy/)
docker build -f deploy/zitadel-login/Dockerfile \
  -t tuetam/zitadel-login-vi:v4.15.3 --build-arg ZITADEL_VERSION=v4.15.3 deploy
# Or via compose (build: block already wired into dev + prod)
docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env.dev up -d --build zitadel-login
```
Both compose files point `zitadel-login` at the fork image + `LOGIN_DEFAULT_LOCALE=vi`;
all other env, the PAT volume, Traefik `/ui/v2/login/*` routing and
`CUSTOM_REQUEST_HEADERS` are unchanged. **Rollback** = point the service back at
`ghcr.io/zitadel/zitadel-login:<ver>`, drop the `build:` block, restart — the uploaded
`vi` hosted-login-translation stays harmless (stock image never selects `vi`).

Verify: open `https://auth.<d>/ui/v2/login` → renders Vietnamese by default; switcher
lists "Tiếng Việt"; an English-locale browser still shows Vietnamese; `?ui_locales=en`
switches to English. Sanity-check the image:
```bash
docker run --rm --entrypoint sh <image> \
  -c 'grep -rl "Chào mừng\|Tiếng Việt" /app/apps/login/.next >/dev/null && echo "vi bundled OK"'
```

### 9.7 Version-pin upgrade (future Zitadel bump)
1. Bump `ZITADEL_VERSION` in the Dockerfile + both compose `build.args` + the image tag.
2. Rebuild. If `apply-vi-locale.mjs` throws "anchor not found", upstream `i18n.ts` /
   `request.ts` / `layout.tsx` moved — update the anchors, then rebuild.
The **server** may track `zitadel:latest` while the login image is pinned to a source
tag (compatible via the shared v2 gRPC API); if a future server bump breaks the login
gRPC calls, pin the server too.

### 9.8 Reusing this fork in another project
The fork is only **3 small files + one JSON of strings** — deliberately portable.
To reuse across repos, publish them as a standalone artifact (see the "Publishing the
fork" note where this guide is applied), then in the new project either:
- **Pull a prebuilt image** — reference `…/zitadel-login-vi:<ver>` in that project's
  compose (zero rebuild; but the image bakes `NEXT_PUBLIC_BASE_PATH` + version — rebuild
  if either differs), or
- **Copy the 3 files** (`Dockerfile`, `apply-vi-locale.mjs`, `*_vi_translations.json`)
  and build locally with that project's own base path / pinned version.
Nothing in the fork is Tuệ Tâm-specific except the translated strings, which any
project can reuse or re-translate.

---

## 10. Issues & Solutions (the field notes)

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | Passkey **registration works but passwordless LOGIN fails** with `WebAuthN.BeginLoginFailed` / "Found no credentials" | OIDC login fell back to **V1 hosted login** (`/ui/login`); `loginV2.required` was not `true`. V1's passkey ceremony broke; registration only used V2 because the link hit `/ui/v2/login/...` directly. Confirm by packet-capturing core :8080 — failing response served `/ui/login/resources/scripts/webauthn_login.js` (V1). | `PUT /v2/features/instance {"loginV2":{"required":true,"baseUri":"…/ui/v2/login"}}`. Re-bootstrap must keep this set. |
| 2 | Zitadel **Console** (`/ui/console/users/me`) blank, all gRPC-web calls `blocked:csp` | `environment.json` `api:"http://auth.<d>"` on an https page (CSP `connect-src` only allows https) — Zitadel emitted http because `--tlsMode disabled`. | Set `--tlsMode external` (with `EXTERNALSECURE=true`), recreate core. |
| 3 | Passkey enroll page shows "Missing code for user-based registration" | Built the URL with `id=` (old `zitadel/typescript`); deployed `apps/login` reads **`codeId`**. | Use `…/passkey/set?userId=&organization=&code=&codeId=`. |
| 4 | New Google client id/secret not taking effect | `ensure_social_idps` was create-only (skip-on-exists). | Add `PUT /admin/v1/idps/google/{id}` update branch. |
| 5 | Google `redirect_uri_mismatch` | Zitadel sent the **V1** IdP callback while only `/idps/callback` was whitelisted. | Register BOTH callbacks in Google; once V2 is enforced, V2 callback is used. |
| 6 | (Red herring) thought login sent wrong WebAuthn domain | Inbound `Host`/`X-Forwarded-Host` were already correct (`auth.<d>`); login code injects them fine. Domain was never the issue — it was Issue #1. | Don't over-engineer host pinning; verify with a header-echo behind the same route. |
| 7 | Member can't find passkey UI in Console (admin can) | Console self-page **gates the passkey/MFA cards behind Zitadel management permissions**; plain users see only Profile/Contact. | Build in-app self-service via the API; don't send end-users to Console. |
| 8 | Can't default login to Vietnamese | `vi` unsupported by Zitadel core. | See §9; fork login image if mandatory. |
| 9 | Web "add passkey" button does nothing | `launchUrl(_blank)` AFTER an `await` → browser popup blocker (gesture lost). | On web open same-tab (`_self`); native uses external browser. |
| 10 | Whole stack 502 after Docker Desktop restart | Docker Desktop host port-forwards go stale (TCP accepts, data dropped mid-handshake) — affects Traefik AND Postgres/pgbouncer. | `docker compose up -d --force-recreate traefik postgres pgbouncer`. |
| 11 | Traefik dynamic config edits don't apply | Windows bind-mount inotify doesn't propagate → file provider doesn't reload. | `docker restart <traefik>` after editing dynamic config. |

---

## 11. Quick verification checklist

- `GET /v2/features/instance` → `loginV2.required: true`.
- `GET {issuer}/ui/console/assets/environment.json` → `api` is **https**.
- `GET {issuer}/.well-known/openid-configuration` → issuer == external https domain.
- Passkey: register via link on a real device → `passkeys/_search` shows `READY` →
  passwordless login on V2 succeeds.
- Google: button on V2 login → `/idps/callback` round-trip → JIT user provisioned.
- Each OIDC client login + logout (web + native custom-tab).

## 12. Gotchas to carry forward

- Set `EXTERNALDOMAIN` + Login V2 from the start (avoid the re-init).
- Keep `loginV2.required=true` in your bootstrap's default path, not behind a flag.
- One RP-ID domain for all apps (login always on `auth.<domain>`).
- Console is admin-only UX; build user-facing security yourself.
- Prod parity: carry `--tlsMode external`, the proxy + login container, real SMTP.

---

## 13. Production deployment notes (carry-over, not blockers)

`docker-compose.prod.yml` now carries all the pieces (Traefik file provider, the
`zitadel-login` container, `--tlsMode external`, the API SA-key mount). These are
**one-time first-deploy steps** the compose can't do for you — also noted in the
compose comments:

1. **Tunnel ingress.** In the Cloudflare Zero Trust dashboard, point the prod
   tunnel ingress `auth.<domain>` → `traefik:80` (not straight to `zitadel:8080`,
   else `/ui/v2/login/*` won't route to the login app).
2. **Bootstrap with the right flags.** Run
   `bootstrap_zitadel.py … --login-client --enable-login-v2 --social-idps` so
   `deploy/secrets/login-client.pat` is written (the Login V2 container needs it)
   and `loginV2.required=true` is set on the prod instance. Without this, login
   falls back to the broken V1 hosted UI (breaks passwordless + Google callback).
3. **Auth domain in Traefik.** If the prod auth domain ≠ `auth.vitacell.net`,
   update the `Host(...)` rule in `deploy/traefik/dynamic.yml` (two routers).
4. **Real SMTP.** Configure a real SMTP provider for password-reset / verification
   emails — dev used Mailpit (catch-all, no delivery). Set it via Zitadel SMTP
   settings (Admin API / Console) so `/me/security/password/reset-email` delivers.
