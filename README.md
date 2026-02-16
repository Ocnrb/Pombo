# Pombo - P2P Decentralized Chat

P2P decentralized chat using the Streamr Network, Ethereum and Web3.

## Project Structure

```
Pombo/
├── index.html              # Main UI (references dist/* bundles)
├── src/
│   ├── js/                 # Source JavaScript modules
│   │   ├── app.js          # Entry point and orchestration
│   │   ├── auth.js         # Authentication (Local Wallet + Keystore V3)
│   │   ├── crypto.js       # AES-GCM encryption utilities (Web Crypto API)
│   │   ├── streamr.js      # Streamr Client wrapper (partitions)
│   │   ├── channels.js     # Channel manager
│   │   ├── ui.js           # UI controller and QR codes
│   │   ├── identity.js     # Identity and username management
│   │   ├── notifications.js # Notification system
│   │   ├── secureStorage.js # Wallet-encrypted storage
│   │   ├── graph.js        # Integration with The Graph API
│   │   └── logger.js       # Logging utilities
│   ├── styles/
│   │   └── input.css       # Tailwind CSS source
│   └── streamr-bundle.js   # Vendor entry (Streamr SDK + Ethers.js)
├── dist/                   # Build outputs (git-ignored or committed)
│   ├── js/
│   │   ├── app.bundle.js   # Bundled application code
│   │   └── vendor.bundle.js # Bundled Streamr SDK + Ethers.js
│   └── css/
│       └── output.css      # Compiled Tailwind CSS
├── package.json
├── webpack.config.js
├── tailwind.config.js
└── README.md
```

## Technologies

- **Frontend**: Vanilla JavaScript (ES6 Modules), Tailwind CSS
- **Blockchain**: Ethereum (Ethers.js v6)
- **P2P Network**: Streamr Network SDK
- **Storage**: Encrypted LocalStorage (Keystore V3)
- **Cryptography**: Native Web Crypto API (AES-GCM, PBKDF2)

## Features

### Implemented (Phase 1)

- ✅ Local wallet authentication (Keystore V3)
- ✅ Generation and import of private keys
- ✅ Encrypted wallet storage (scrypt + AES-128-CTR)
- ✅ Channel creation (Public, Password-protected, Native private)
- ✅ Partitioning system (Control, Messages, Media)
- ✅ Client-side AES-GCM encryption
- ✅ WhatsApp-like UI
- ✅ QR code generation for invites
- ✅ Local storage of channels
- ✅ Trusted contacts system
- ✅ "typing..." indicators
- ✅ Message reactions
- ✅ User presence indication

### In Development (Phases 2-4)

- 🔄 Media upload and sharing
- 🔄 Direct messages (DM)
- 🔄 Performance optimizations

## How to Run

### Option 1: Local Server (Recommended)

```bash
# Python 3
python -m http.server 8000

# Node.js (http-server)
npx http-server -p 8000

# PHP
php -S localhost:8000
```

Open: http://localhost:8000

### Option 2: Live Server (VS Code)

1. Install the "Live Server" extension
2. Right-click `index.html`
3. Select "Open with Live Server"

## How to Use

### 1. Connect Wallet

- **Generate New**: Creates a new local wallet (⚠️ save the private key!)
- **Import**: Use an existing private key
- **Load Saved**: If you previously saved an encrypted wallet
- **Import Keystore**: Import a Keystore V3 file

### 2. Create a Channel

1. Click "+ New Channel"
2. Choose a name
3. Select the type:
   - **Public**: Anyone can read and write (no encryption)
   - **Password**: Client-side AES-GCM encryption (low gas)
   - **Native**: Streamr native encryption + on-chain permissions (high gas)

### 3. Share a Channel

- Generate an invite link or QR code
- Share it with others
- They can join using the link/QR

### 4. Chat

- Select a channel from the sidebar
- Type messages in the input box
- Messages are published via the Streamr Network

## Technical Architecture

### Streams and Partitions

Each channel uses a single Stream ID with 3 partitions:

- **Partition 0 (Control)**: Metadata, typing indicators, membership updates
- **Partition 1 (Messages)**: Chat text messages
- **Partition 2 (Media)**: Images, audio, files

### Channel Types

| Type | Permissions | Encryption | Gas Cost |
|------|-------------|------------|----------|
| **Public** | Everyone | None | Low (1 tx) |
| **Password** | Everyone (on network) | AES-GCM client-side | Low (1 tx) |
| **Native** | AllowList | Streamr native | High (1 tx + 1 tx/member) |

### Encryption

For password-protected channels:
- PBKDF2 (100k iterations, SHA-256) to derive keys
- AES-GCM 256-bit for encryption
- Random salt and IV per message
- No external dependencies (Web Crypto API)

## Security

⚠️ **Important Warnings**:

1. **Private Keys**: Never share your private key. If you generate a local wallet, save it immediately.
2. **Passwords**: Use strong passwords for password-protected channels. The password is shared among channel members.
3. **Public Channels**: Messages in public channels are visible to anyone on the network.
4. **Local Storage**: Wallets and channels are stored in the browser's localStorage. Clearing browser data = losing access.

## Troubleshooting

### "StreamrClient is not defined"

If you see this error in the console:

1. Check the console for Streamr SDK debug logs
2. The library may be loading differently than expected
3. Temporary workaround: the code includes fallbacks to detect the library

### Wallet won't unlock

- Verify the password is correct
- Keystore V3 decryption may take several seconds
- If you lost the password, import the private key again

### Messages not showing

- Ensure you are online
- Check the console for errors
- Try reloading the page and reconnecting

## Development

### Build Commands

```bash
# Build all (CSS + JS bundles)
npm run build

# Build minified production bundle
npm run build:minify

# Watch mode (development)
npm run watch

# Build CSS only
npm run build:css

# Build JS only
npm run build:js
```

### Module Structure (src/js/)

- `app.js`: Main orchestration, initialization
- `auth.js`: Local wallet management (Keystore V3, import/export)
- `crypto.js`: Cryptography utilities (AES, PBKDF2, hashing)
- `streamr.js`: Streamr SDK interface (pub/sub, streams)
- `channels.js`: Channel logic (create, join, messages)
- `ui.js`: DOM manipulation, rendering, events
- `identity.js`: Identity and username management
- `notifications.js`: Notification system
- `secureStorage.js`: Wallet-encrypted storage
- `graph.js`: Integration with The Graph API
- `logger.js`: Logging utilities

### Adding New Features

1. To add new message types: edit `src/js/channels.js` and add handlers
2. For UI changes: edit `src/js/ui.js` and `index.html`
3. For encryption updates: add methods in `src/js/crypto.js`
4. After changes, run `npm run build` to regenerate bundles

## Roadmap

- [ ] New message notifications
- [ ] Message search
- [ ] Reactions and emojis
- [ ] Customizable themes
- [ ] Conversation export
- [ ] ENS integration (.eth names)
- [ ] Multi-network support (Polygon, Gnosis, etc.)
- [ ] PWA (Progressive Web App)

## License

MIT

## Support

For issues and bugs, open an issue in the repository.

---

**Built with** ⚡ **Streamr Network** • 🔐 **Web3** • 💎 **Ethereum**
