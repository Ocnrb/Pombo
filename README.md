# Pombo Web

**Pombo** is a decentralized P2P chat app built on the
[Streamr](https://streamr.network) network — own your channels, messages, and
identity with zero central servers. This is the web client (also installable
as a PWA), live at [app.pombo.cc](https://app.pombo.cc). It is the reference
implementation of the Pombo wire protocol; the Android client (a native
Compose UI over this same JavaScript protocol stack) mirrors it byte-for-byte
so both talk on the same channels and DMs.

· Website: [pombo.cc](https://pombo.cc)  

· App: [app.pombo.cc](https://app.pombo.cc)  

· Docs: [docs.pombo.cc](https://docs.pombo.cc) 


## Features

- **Public channels** — create/join, native (non-Streamr-hosted) channel
  membership and moderation, password-protected channels (AES-GCM), invites
  with QR codes.
- **Direct messages** — end-to-end encrypted via ECDH + HKDF + AES-GCM, with
  sealed-sender envelopes, ephemeral presence and typing indicators.
- **Identity is a wallet** — an Ethereum private key (generated or imported),
  encrypted at rest; no accounts, no passwords, no e-mail. Multiple profiles
  supported, with deterministic SVG avatars and ENS resolution.
- Reactions, message edit/delete, pinning, read/unread tracking, chat history
  via Streamr resend.
- **Media & file sharing** — P2P transfer over the ephemeral stream, plus
  persistent file sharing through storage nodes.
- **Privacy-preserving push notifications** — senders publish short
  K-anonymous tags (with proof-of-work anti-spam) to a shared push stream; a
  relay forwards them as Web Push wake-ups. The service worker matches the
  tag against locally-known channels, fetches the real message over Streamr,
  and decrypts it locally — the relay never sees content or recipients.
- **Cross-device sync** of channels, contacts, and settings (E2E encrypted).
- **On-chain awareness** — gas estimation and balance checks before any
  Polygon transaction, chain-mismatch guard, user-selectable RPC endpoints
  with automatic failover.
- **Explore** — curated channel discovery (`curation/explore.json`).

## Architecture

Everything runs in the browser; there is no backend. Transport is the Streamr
network, on-chain operations (stream registry, permissions) go to Polygon via
public RPCs, and history lives on Streamr storage nodes.

Each regular channel uses up to three streams derived from a base ID
(see `src/js/streamConstants.js` — protocol constants, not tunable config):

```
-1  Message stream   (WITH storage)  content, reactions, edits/deletes, file chunks
-2  Ephemeral stream (NO storage)    presence, typing, P2P media coordination
-3  Admin stream     (WITH storage)  owner-only moderation state (bans, hides, pins)
```

DMs use a per-identity inbox stream whose partitions also carry sync and
notification traffic. Message envelopes are canonically hashed
(`{"protocol":"POMBO","version":1,...}` → keccak256 → `personal_sign`) so any
client can verify authorship.

Heavy crypto runs off the main thread in a worker pool
(`src/js/workers/`); a service worker (`sw.js`) provides offline support and
push handling.

## Tech stack

Vanilla JS (ES modules, no framework) + Tailwind CSS, bundled with webpack.
Key dependencies: `@streamr/sdk`, `ethers` 6, `dompurify`, `qrcode`.
Tests run on Vitest with happy-dom/jsdom.

## Development

Requires Node.js 18+.

```
npm install
npm run build        # build CSS + JS bundles
npm run watch        # rebuild on change
npm run serve        # build and serve locally
```

`npm run build:minify` produces the production bundles.

## Testing

```
npm run test:run       # full suite (tests/unit, tests/smoke)
npm run test:coverage  # with V8 coverage
npm run test:ui        # Vitest UI
```

Unit tests (`tests/unit/`, ~70 files) cover the UI modules, crypto, push
protocol, sync/merge logic, and utilities; `tests/smoke/` holds in-browser
smoke pages that exercise the app against the real Streamr network.

## Deployment

Deployed as a static site (Vercel — see `vercel.json`, which also sets the
security headers and CSP, mirrored in `index.html` for other hosts).

## Project layout

```
src/js/
├── app.js               Entry point and app orchestration
├── streamConstants.js   Wire-protocol constants (triple-stream layout)
├── config.js            Network/RPC configuration and app settings
├── crypto.js, dmCrypto.js, publisherProof.js   Crypto primitives and proofs
├── channels.js, dm.js, streamr.js              Messaging core
├── syncManager.js, historyManager.js           Cross-device sync, history
├── ui/                  UI modules (one per surface: chat, channels, DMs, …)
├── workers/             Crypto worker pool and sync worker
└── utils/               Retry/backoff and error normalization
tests/                   Vitest unit and smoke tests
curation/                Explore-tab curated channel list
sw.js                    Service worker (offline + web push)
```

## License

[MIT](LICENSE)
