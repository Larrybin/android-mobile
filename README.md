# Cashback Mobile

Single-device Android automation for opening a cashback app through its normal
accessibility UI, activating a merchant offer, and preserving the resulting
Chrome or in-app WebView shopping session.

## Run

Prerequisites:

- `gost`, `adb`, `emulator`, and `curl` are available in `PATH`.
- The `cashback-phase0` AVD is API 35, `arm64-v8a`.
- Android Chrome has completed its first-run screens.
- The selected cashback app is installed, logged in, and on an explicitly
  calibrated version.
- A RubyLink API key is exported or copied from `.env.example`.

```bash
export RUBYLINK_API_KEY="..."

pnpm cashback:run -- \
  --platform rakuten \
  --merchant "Nike" \
  --expected-domain nike.com
```

The process verifies the host and Android Chrome use the same US exit, drives
the app with `uiautomator` nodes and derived bounds, arms Chrome CDP, the
required app WebView CDP, and the Activity observer before activation, captures
top-level document redirects, and waits for the final domain to remain stable
for five seconds.

`success` and `partial` runs keep the shopping session and all owned resources
open until Ctrl+C. Pre-activation failures clean them immediately.

## Evidence

Each run writes:

```text
artifacts/runs/<run-id>/
├── result.json
└── landing.png
```

Run directories are mode `0700`; files are `0600`. Full URLs, including
attribution parameters, exist only in `result.json`. Console output removes URL
queries and fragments.

## Platform calibration

Package identities and version-bound accessibility profiles live in
[`scripts/platforms.ts`](scripts/platforms.ts). A version without a verified
profile fails with `APP_VERSION_UNSUPPORTED` or `PLATFORM_NOT_CALIBRATED`;
there is no coordinate, OCR, Appium, injection, MITM, or guessed-locator
fallback.

Current repository calibration state:

- Rakuten (`com.ebates`): version `13.13.1` (`13130101`) has a verified
  accessibility profile. A run fails before activation if its WebView does not
  expose a fully initialized CDP page session.
- Ibotta (`com.ibotta.android`): version `6.346.1` registered from the local
  APK; accessibility profile not yet verified.

Real platform calibration requires the corresponding installed, logged-in app
on the local AVD. It must be completed in Rakuten-first order before an
end-to-end run can report `success`.

## Validation

```bash
pnpm test
pnpm test:coverage
pnpm typecheck
```

The coverage gate enforces 100% line, function, and branch coverage for the
deterministic UI/XML, redirect, domain, error, status-machine, and result
serialization core. The live CDP observer has a separate regression floor of
60% lines, 65% functions, and 58% branches, including its pre-activation
WebView readiness and cleanup paths.
