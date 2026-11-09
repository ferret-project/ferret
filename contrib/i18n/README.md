# Application localization

Ferret supports English (`en`, the source and fallback language) and Hungarian (`hu`). This covers application screens, accessible labels, user-facing validation and authentication errors, and newly generated server notifications. The documentation, developer CLI output, MCP descriptions, technical protocols and historical activity records are not translated.

## Choosing a language

The sign-in screen offers a language selector. Before sign-in, the selection is kept on that browser; the browser language supplies the initial default. After sign-in, **Settings → Language** stores a personal preference on the server, so it follows the account to another device and supplies background notification language. Household owners and admins can also choose a household default. A person's explicit preference takes priority over the household default, then English is the fallback.

Changing language does not translate user-entered names, notes, addresses or documents. Language and currency are independent: select `HUF` for forints in the household's currency settings. This does not perform currency conversion or rewrite stored amounts.

## Message catalogs

- `packages/shared/src/locales/en.json`: English source messages, keyed by readable source text.
- `packages/shared/src/locales/hu.json`: Hungarian translations with identical keys.
- `packages/shared/src/locales/unchanged.json`: reviewed source-identical translations, such as product names and technical terms.
- `auth-messages.json`: source errors from the pinned Better Auth dependency, included in the application catalog.
- `packages/shared/src/labels.ts`: presentation labels for stable data values.

Use `t("Complete source sentence", { value })` for text and `tr(...)` for messages containing React nodes. Use the plural helpers for complete singular/plural messages; do not concatenate translated fragments around a count. Preserve `{placeholder}` names exactly. Interpolation is one-pass, and rich values remain React nodes: never use translated HTML or translate arbitrary user data.

Backend translations run within request/job-local asynchronous context, not a process-global language. Scheduled notifications resolve a recipient or household language before formatting text. New notification paths need an explicit language context and an integration test.

Keep enum values, API identifiers, database keys, route paths, MIME types, machine-readable CSV headers, timestamps and environment-variable names unchanged. English remains the fallback when a message is missing.

## Updating the catalogs

From the repository root with the required Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm i18n:extract
# Translate new keys in hu.json, preserving placeholder multisets.
pnpm i18n:check
pnpm typecheck
pnpm test
pnpm build
```

`i18n:extract` updates the English catalog from application source; it does not translate Hungarian or approve exclusions. Review the resulting diff. `scripts/sync-auth-messages.mjs` is a separate maintenance tool for dependency error strings and should only be run deliberately when the Better Auth version changes; re-extract and review afterward.

The AST residual audit records remaining literals in `contrib/i18n/exclusions.json`. Each exclusion needs a concrete reason. Do not regenerate this list to make failures disappear. The placement check catches translations in selected technical contexts, but it does not replace code review or an audit of files outside its declared scope.

## Verification

- Shared catalog tests verify key parity, placeholder multisets and reviewed unchanged strings.
- Server integration tests cover persisted preferences and permissions, concurrent language isolation, authenticated errors and scheduled notification paths.
- Playwright tests exercise the actual application with a disposable database, language switching/persistence, mobile and desktop widths, accessible sign-in controls and localized money.
- Existing server tests protect API, encryption, import/export and data semantics.

Install the Playwright Chromium browser before the browser tests (`pnpm exec playwright install chromium`, plus system dependencies where required). Never point tests at a real Ferret data directory. A passing residual audit is a review aid, not a guarantee of translation quality: review complete messages, especially recovery, consent and destructive actions, and test long Hungarian labels on a phone.

## Terminology

Use consistent Hungarian UI terminology: household → háztartás; property → ingatlan; place/location → hely; container → tároló; item/thing → tárgy; stock → készlet; maintenance → karbantartás; warranty → garancia. Prefer clear neutral sentences or consistent informal singular address. Preserve product names, protocols and user-entered content.

## Contribution disclosure

This localization was developed with AI assistance at a Hungarian user's request. Automated extraction and translation were followed by structural checks, code/copy review and executable tests. Reviewers should assess both the localization architecture and the wording; translation assistance is not a substitute for maintainer review.
