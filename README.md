# zitadel-login-vi

Custom build of the Zitadel **Login V2** UI (`ghcr.io/zitadel/zitadel-login`) that
adds a **Vietnamese (`vi`)** locale.

Zitadel's instance languages do **not** include `vi`, so `vi` cannot be offered or
defaulted in the Login V2 screens without a custom login image. This repo bakes `vi`
into the login UI at build time via a tiny, anchor-based source overlay applied to a
**pinned upstream release** — no whole-repo fork to maintain.

- **Prebuilt image:** `ghcr.io/duongletsbd/zitadel-login-vi:<zitadel-version>`
  (e.g. `:v4.15.3`, plus `:latest`) — built & pushed by CI on every tag/push.
- **Pinned upstream:** `zitadel/zitadel` (the login image is versioned in lock-step
  with the server — match it to your running Zitadel).
- **Approach:** source rebuild (not a runtime `FROM …` overlay) — see _Why a rebuild_.

## Use it (pull the prebuilt image)

Point your `zitadel-login` service at this image and set the default locale:

```yaml
# docker-compose.*.yml
zitadel-login:
  image: ghcr.io/duongletsbd/zitadel-login-vi:v4.15.3
  environment:
    LOGIN_DEFAULT_LOCALE: vi              # hard default to Vietnamese (see below)
    ZITADEL_API_URL: http://zitadel:8080
    NEXT_PUBLIC_BASE_PATH: /ui/v2/login   # must match what you built with
    ZITADEL_SERVICE_USER_TOKEN_FILE: /etc/login/login-client.pat
    CUSTOM_REQUEST_HEADERS: "x-zitadel-public-host:auth.<domain>,Host:auth.<domain>"
```

All the normal Login V2 wiring (the `IAM_LOGIN_CLIENT` PAT, `loginV2.required=true`,
Traefik `/ui/v2/login/*` routing) is unchanged — see
[`docs/self-hosted-zitadel-login-passkeys-guide.md`](docs/self-hosted-zitadel-login-passkeys-guide.md)
for the full self-hosting + passkeys playbook.

> The image bakes in `NEXT_PUBLIC_BASE_PATH` and the Zitadel version. If your serve
> path differs from `/ui/v2/login`, or you run a different Zitadel version, build your
> own (below) with the matching build-args.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage: clones `zitadel/zitadel@<ver>`, applies the overlay, builds the Next.js standalone, packages a runtime image mirroring upstream `apps/login/Dockerfile`. |
| `apply-vi-locale.mjs` | Idempotent, anchor-based source overlay (4 edits). Fails loudly if an upstream anchor moved. |
| `login_v2_vi_translations.json` | The Vietnamese strings (next-intl namespaced). Copied into the build as `apps/login/locales/vi.json`. Single source of truth — also upload it via the hosted-login-translation API. |
| `.github/workflows/build-and-push.yml` | Builds the image and pushes it to GHCR. |

## Why a rebuild (not a `FROM …zitadel-login` overlay)

1. **Supported locales are a hardcoded array.** `apps/login/src/lib/i18n.ts` exports
   `LANGS` (no `vi`). The switcher **and** the Accept-Language / `NEXT_LOCALE`-cookie
   gates in `apps/login/src/i18n/request.ts` all key off it. In the published image
   `LANGS` is minified into the server bundle — not reliably patchable.
2. **Messages are bundled at build time.** `request.ts` loads them via
   `import(`../../locales/${locale}.json`)` — a webpack context module fixed at
   build. A `vi.json` COPYed into a running container is never in the map.

⇒ `vi` must be baked in at **build** time from source.

## How `vi` survives Zitadel's language intersection (the real gotcha)

Registering `vi` in `LANGS` is **not enough**. Both `layout.tsx` (switcher) and
`request.ts` (resolution) intersect `LANGS` with the instance's
`getGeneralSettings().allowedLanguages`, which returns Zitadel's supported set (no
`vi`) **even with no restrictions** — silently dropping `vi`. The overlay therefore
**re-adds `vi` after the intersection** in both files (edits 2 & 3). `vi` is treated
as a login-only locale, independent of any Zitadel instance language setting.

## Locale resolution (`LOGIN_DEFAULT_LOCALE`)

After `vi` is re-added to `allowedLanguages`:

1. `defaultLanguage` = Zitadel instance default (can't be `vi`) → overridden by
   **`LOGIN_DEFAULT_LOCALE`** (`vi`). Base default for everyone.
2. **`Accept-Language`** header — **skipped** while `LOGIN_DEFAULT_LOCALE` is set, so
   an English-locale browser still lands on Vietnamese (hard default).
3. **`NEXT_LOCALE`** cookie / OIDC `?ui_locales=<code>` — still highest. Switcher
   choice sticks; force English with `?ui_locales=en`.

For a **soft** default (respect the browser, fall back to `vi`) remove edit 4 in
`apply-vi-locale.mjs` and rebuild. For a **Vietnamese-only** UI, trim `LANGS` to
`[en, vi]`.

## Build it yourself

```bash
docker build -t zitadel-login-vi:v4.15.3 \
  --build-arg ZITADEL_VERSION=v4.15.3 \
  --build-arg NEXT_PUBLIC_BASE_PATH=/ui/v2/login \
  .
```

> Heavy first build (full pnpm workspace install + nx build of `@zitadel/proto` →
> `@zitadel/client` → `@zitadel/login`). Allow several minutes and adequate RAM/disk.

CI (`.github/workflows/build-and-push.yml`) does this automatically and pushes to
`ghcr.io/<owner>/zitadel-login-vi`. Trigger it by pushing a `v*` tag, or run it
manually (`workflow_dispatch`) with a `zitadel_version` input.

## Verify

1. Open `https://auth.<domain>/ui/v2/login`. Screens render **Vietnamese** by default
   ("Chào mừng trở lại!", "Tên đăng nhập", "Tiếp tục", …).
2. The switcher lists **Tiếng Việt**; switching to it stays Vietnamese
   (sets `NEXT_LOCALE=vi`).
3. An **English-locale browser still renders Vietnamese** by default; `?ui_locales=en`
   or the switcher flips to English.
4. Sanity-check the image bundled `vi`:
   ```bash
   docker run --rm --entrypoint sh ghcr.io/duongletsbd/zitadel-login-vi:v4.15.3 \
     -c 'grep -rl "Chào mừng\|Tiếng Việt" /app/apps/login/.next >/dev/null && echo "vi bundled OK"'
   ```

## Rollback

Point the service back at the stock image and restart — no other change needed:

```yaml
image: ghcr.io/zitadel/zitadel-login:v4.15.3   # or :latest
# LOGIN_DEFAULT_LOCALE is a no-op on the stock image (no `vi` in LANGS).
```

## Upgrading the pin (future Zitadel bump)

1. Bump `ZITADEL_VERSION` (build-arg / CI input / image tag).
2. Rebuild. If `apply-vi-locale.mjs` throws "anchor not found", the upstream
   `i18n.ts` / `layout.tsx` / `request.ts` moved — update the anchors, then rebuild.

The Zitadel **server** may track `zitadel:latest` while this login image is pinned to
a source tag (compatible via the shared v2 gRPC API). If a future server bump breaks
the login gRPC calls, pin the server too.

## License / attribution

This repo contains only a build recipe (`Dockerfile`), a locale-patch script, and
Vietnamese UI strings. It **builds from** [`zitadel/zitadel`](https://github.com/zitadel/zitadel)
at build time; the resulting image is a derivative of Zitadel's Login V2 and is
subject to Zitadel's upstream license. The overlay script and Vietnamese strings in
this repo are provided as-is for reuse.
