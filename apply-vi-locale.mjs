#!/usr/bin/env node
// Overlay that turns an upstream zitadel/zitadel checkout into the
// Vietnamese fork of the Login V2 UI. Run from the monorepo root (the Dockerfile
// runs it right after `git clone` of the pinned release tag).
//
// It performs idempotent, anchor-based source edits 1–6 (5 = vi.json wins
// over core's hosted translations for `vi`; 6 = runtime LOGIN_BRAND_NAME). Each FAILS LOUDLY if
// its anchor text is missing, which is the signal that the upstream source
// moved and this script must be re-checked against the new release tag.
//
//   1. apps/login/src/lib/i18n.ts     -> register `vi` in the LANGS array so
//      it becomes a first-class UI locale (LANGS drives the switcher list and
//      the base allow-list for locale resolution).
//
//   2. apps/login/src/app/(login)/layout.tsx -> re-add `vi` to the switcher's
//      language list. WHY: the layout intersects LANGS with Zitadel's
//      getGeneralSettings().allowedLanguages, and Zitadel core does NOT list
//      `vi` as a supported language, so the raw intersection silently drops it
//      even though it is in LANGS. Without this the switcher never shows
//      "Tiếng Việt".
//
//   3. apps/login/src/i18n/request.ts -> (a) re-add `vi` to the resolved
//      `allowedLanguages` for the same intersection reason as (2) — otherwise
//      the cookie / Accept-Language / default can never select vi; and (b)
//      honour an optional LOGIN_DEFAULT_LOCALE env var as the base default UI
//      locale (Zitadel's instance default cannot be `vi`).
//
//   4. apps/login/src/i18n/request.ts -> when LOGIN_DEFAULT_LOCALE is set, do
//      NOT let the browser Accept-Language header override it. WHY: the target
//      audience is Vietnamese; an English-locale browser would otherwise pull
//      the UI back to English. An explicit NEXT_LOCALE cookie (set when the
//      user picks a language in the switcher) still wins, so a user's manual
//      choice is preserved. Remove this edit for "soft" default behaviour
//      (default only when the browser has no supported language).
//
// The Vietnamese message file itself (apps/login/locales/vi.json) is copied in
// by the Dockerfile, not by this script.

import { readFileSync, writeFileSync } from "node:fs";

function edit(path, { marker, anchor, mode, addition, replacement }) {
  let src = readFileSync(path, "utf8");
  if (src.includes(marker)) {
    console.log(`[=] ${path}: already patched (marker present) — skipping`);
    return;
  }
  if (!src.includes(anchor)) {
    throw new Error(
      `[x] ${path}: anchor not found — upstream source changed for this ` +
        `release. Re-check apply-vi-locale.mjs against the pinned tag.\n` +
        `    anchor:\n${anchor}`,
    );
  }
  if (mode === "after") {
    src = src.replace(anchor, anchor + addition);
  } else if (mode === "before") {
    src = src.replace(anchor, addition + anchor);
  } else if (mode === "replace") {
    src = src.replace(anchor, replacement);
  } else {
    throw new Error(`[x] ${path}: unknown edit mode "${mode}"`);
  }
  writeFileSync(path, src, "utf8");
  console.log(`[+] ${path}: patched`);
}

// 1) Register `vi` in LANGS (inserted right after the English entry).
edit("apps/login/src/lib/i18n.ts", {
  marker: 'code: "vi"',
  anchor: '  {\n    name: "English",\n    code: "en",\n  },',
  mode: "after",
  addition: '\n  {\n    name: "Tiếng Việt",\n    code: "vi",\n  },',
});

// 2) Keep `vi` in the switcher list after the Zitadel allowedLanguages
//    intersection drops it (Zitadel core doesn't list vi as supported).
edit("apps/login/src/app/(login)/layout.tsx", {
  marker: "Vietnamese fork: always offer Vietnamese",
  anchor:
    '  } catch (e) {\n' +
    '    console.error("Failed to load supported languages", e);\n' +
    "  }",
  mode: "after",
  addition:
    "\n\n  // Vietnamese fork: always offer Vietnamese. Zitadel core does not list\n" +
    "  // `vi` in getGeneralSettings().allowedLanguages, so the intersection\n" +
    "  // above drops it even though it is in LANGS — re-add it here.\n" +
    '  const viLang = LANGS.find((l) => l.code === "vi");\n' +
    '  if (viLang && !languages.find((l) => l.code === "vi")) {\n' +
    "    languages = [...languages, viLang];\n" +
    "  }",
});

// 3) request.ts: keep `vi` in allowedLanguages (same intersection reason as 2)
//    + honour LOGIN_DEFAULT_LOCALE as the base default locale.
edit("apps/login/src/i18n/request.ts", {
  marker: "LOGIN_DEFAULT_LOCALE",
  anchor: "  let locale: string = defaultLanguage;",
  mode: "before",
  addition:
    "  // Vietnamese fork: `vi` is a login-only locale Zitadel core does not list\n" +
    "  // in allowedLanguages, so the intersection above drops it. Re-add it so\n" +
    "  // the cookie / Accept-Language / default below can actually select vi.\n" +
    '  if (LANGS.some((l) => l.code === "vi") && !allowedLanguages.includes("vi")) {\n' +
    '    allowedLanguages = [...allowedLanguages, "vi"];\n' +
    "  }\n" +
    "  // Vietnamese fork: allow an env-provided default UI locale (Zitadel's\n" +
    "  // instance default cannot be `vi`).\n" +
    "  if (\n" +
    "    process.env.LOGIN_DEFAULT_LOCALE &&\n" +
    "    allowedLanguages.includes(process.env.LOGIN_DEFAULT_LOCALE)\n" +
    "  ) {\n" +
    "    defaultLanguage = process.env.LOGIN_DEFAULT_LOCALE;\n" +
    "  }\n",
});

// 4) request.ts: when a default locale is forced, don't let the browser
//    Accept-Language header override it (an explicit NEXT_LOCALE cookie, set by
//    the switcher, still wins in the block right after). Remove for soft default.
edit("apps/login/src/i18n/request.ts", {
  marker: "languageHeader && !process.env.LOGIN_DEFAULT_LOCALE",
  anchor: "  if (languageHeader) {",
  mode: "replace",
  replacement: "  if (languageHeader && !process.env.LOGIN_DEFAULT_LOCALE) {",
});

// 5) request.ts: for `vi`, merge vi.json AFTER the hosted translations.
//    WHY: Zitadel core does not know `vi`, so GetHostedLoginTranslation for
//    locale `vi` returns core's full English default set (measured on v4.20.2:
//    304 keys, "Welcome back!"…). Upstream merges hosted translations last, so
//    that English set overwrote every vi.json string. Other locales keep the
//    upstream order (hosted translations still win there).
edit("apps/login/src/i18n/request.ts", {
  // marker = the comment line: edit 6b later rewrites the merge lines themselves.
  marker: "vi.json wins over core's English hosted set for `vi`.",
  anchor:
    "    messages: mergeMessages(fallbackMessages, localeMessages, customMessages) as Record<string, string>,",
  mode: "replace",
  replacement:
    "    // Vietnamese fork: vi.json wins over core's English hosted set for `vi`.\n" +
    "    messages: (locale === \"vi\"\n" +
    "      ? mergeMessages(fallbackMessages, customMessages, localeMessages)\n" +
    "      : mergeMessages(fallbackMessages, localeMessages, customMessages)) as Record<string, string>,",
});

// 6) request.ts: optional brand name from LOGIN_BRAND_NAME, read on the server
//    at REQUEST time (never NEXT_PUBLIC_*, never baked into the image), so one
//    image serves any deployment. It overrides only the two strings that name
//    a product (`common.title` — also the page <title> — and
//    `register.description`) for `vi` and `en`, and is merged LAST so it wins
//    over vi.json, en.json and hosted translations alike.
//    Valid name: trimmed, control characters removed, 1–40 characters, and no
//    `{ } < >` (next-intl parses messages as ICU: those characters break
//    formatting whenever a caller passes values, and quoting them breaks the
//    calls that pass none — measured with use-intl 4.15). Missing/invalid ⇒
//    brand-free wording, so nothing names another product.
//    6a declares the helper before `return`; 6b adds it as the last merge source.
edit("apps/login/src/i18n/request.ts", {
  marker: "function vietnameseForkBrandMessages(",
  anchor: "  return {\n    locale,\n",
  mode: "before",
  addition:
    "  // Vietnamese fork: runtime brand name (see apply-vi-locale.mjs, edit 6).\n" +
    "  function vietnameseForkBrandMessages(loc: string): Record<string, unknown> {\n" +
    '    const raw = (process.env.LOGIN_BRAND_NAME ?? "").replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, "").trim();\n' +
    '    const brand = raw.length >= 1 && raw.length <= 40 && !/[{}<>]/.test(raw) ? raw : "";\n' +
    '    if (loc === "vi") {\n' +
    "      return {\n" +
    '        common: { title: brand ? `Đăng nhập vào ${brand}` : "Đăng nhập" },\n' +
    '        register: { description: brand ? `Tạo tài khoản ${brand} của bạn.` : "Tạo tài khoản của bạn." },\n' +
    "      };\n" +
    "    }\n" +
    '    if (loc === "en") {\n' +
    "      return {\n" +
    '        common: { title: brand ? `Sign in to ${brand}` : "Login" },\n' +
    '        register: { description: brand ? `Create your ${brand} account.` : "Create your account." },\n' +
    "      };\n" +
    "    }\n" +
    "    return {};\n" +
    "  }\n" +
    "  const brandMessages = vietnameseForkBrandMessages(locale);\n\n",
});
edit("apps/login/src/i18n/request.ts", {
  marker: "customMessages, localeMessages, brandMessages)",
  anchor:
    "      ? mergeMessages(fallbackMessages, customMessages, localeMessages)\n" +
    "      : mergeMessages(fallbackMessages, localeMessages, customMessages)) as Record<string, string>,",
  mode: "replace",
  replacement:
    "      ? mergeMessages(fallbackMessages, customMessages, localeMessages, brandMessages)\n" +
    "      : mergeMessages(fallbackMessages, localeMessages, customMessages, brandMessages)) as Record<string, string>,",
});

console.log("[✓] Vietnamese fork overlay applied");
