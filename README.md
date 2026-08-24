# Pombo Web

**Pombo** is an open-source peer-to-peer messaging and social app: group
channels and private direct messages, with no company in the middle. Your
channels, your messages and your identity are yours.

This is the web client, also installable as a PWA, live at
[app.pombo.cc](https://app.pombo.cc). It is the reference implementation of the
Pombo wire protocol.

· Website: [pombo.cc](https://pombo.cc)  

· App: [app.pombo.cc](https://app.pombo.cc)  

· Docs: [docs.pombo.cc](https://docs.pombo.cc) 


## Features

- **Five channel types**. Open and Protected (AES-GCM under a shared password),
  plus three backed by a per-channel PomboGate contract on Polygon: Closed
  (owner allowlist), Gated (token or NFT holding) and Paid (subscription, sent
  straight to the channel owner). Moderation and QR-code invites throughout.
- **Epoch keys**: contract-backed channels encrypt content with a rotating
  channel key handed out over a dedicated keys stream. Any member holding the
  key can answer a request, and the key hash announced by the admin is the
  trust anchor.
- **Direct messages**: end-to-end encrypted via ECDH + HKDF + AES-GCM, with
  sealed-sender envelopes, ephemeral presence and typing indicators.
- **Identity is a wallet**: an Ethereum private key (generated or imported),
  encrypted at rest; no accounts, no passwords, no e-mail. Multiple profiles
  supported, with deterministic SVG avatars and ENS resolution.
- Reactions, message edit/delete, pinning, read/unread tracking, chat history
  via Streamr resend.
- **Media & file sharing**: P2P transfer over the ephemeral stream, plus
  persistent file sharing through storage nodes.
- **Privacy-preserving push notifications**: senders publish short
  K-anonymous tags (with proof-of-work anti-spam) to a shared push stream; a
  relay forwards them as Web Push wake-ups. The service worker matches the
  tag against locally-known channels, fetches the real message over Streamr,
  and decrypts it locally, so the relay never sees content or recipients.
- **Cross-device sync** of channels, contacts, and settings (E2E encrypted).
- **On-chain awareness**: gas estimation and balance checks before any
  Polygon transaction, chain-mismatch guard, user-selectable RPC endpoints
  with automatic failover.
- **Explore**: curated channel discovery (`curation/explore.json`).

## Architecture

Everything runs in the browser; there is no backend. Transport is the [Streamr network](https://streamr.network),
on-chain operations (stream registry, permissions) go to Polygon via
public RPCs, and history lives on Streamr storage nodes.

Each regular channel uses up to four streams derived from a base ID
(see `src/js/streamConstants.js`; these are protocol constants, not tunable
config):

```
-1  Message stream   (WITH storage)  content, reactions, edits/deletes, file chunks
-2  Ephemeral stream (NO storage)    presence, typing, P2P media coordination
-3  Admin stream     (WITH storage)  owner-only moderation state (bans, hides, pins)
-4  Keys stream      (WITH storage)  epoch-key distribution (contract-backed channels)
```

DMs use a per-identity inbox stream whose partitions also carry sync and
notification traffic.

Channel messages go out under a throwaway key, so authorship travels as a
**publisher proof** in the payload: the account signs the ephemeral address,
and readers recover the signer from that signature and check it against the
publisherId that arrived on the wire. In gated channels the publisher is the
gate contract, and the author comes from the ERC-1271 envelope signature that
the network already validated.

Heavy crypto runs off the main thread in a worker pool
(`src/js/workers/`); a service worker (`sw.js`) provides offline support and
push handling.

## Tech stack

Vanilla JS (ES modules, no framework) + Tailwind CSS, bundled with webpack.
Key dependencies: `@streamr/sdk`, `ethers` 6, `dompurify`, `qrcode`.
Tests run on Vitest under jsdom, with the SDK parity suite pinned to node.

## Development

Built and tested on Node.js 24.

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

Unit tests (`tests/unit/`, 84 files) cover the UI modules, crypto, push
protocol, sync/merge logic, and utilities; `tests/smoke/` holds in-browser
smoke pages that exercise the app against the real Streamr network.

## Deployment

Deployed as a static site to [app.pombo.cc](https://app.pombo.cc), built from
source by `.github/workflows/deploy-pages.yml` so what is served is provably
the committed source. Pull requests run the unit suite before merge.
Security headers and the CSP live in `vercel.json`, mirrored in `index.html`
for other hosts.

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
