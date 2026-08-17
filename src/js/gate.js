/**
 * PomboGate client — the on-chain side of gated channels (N-C).
 *
 * One EIP-1167 clone per channel, deployed through the PomboGateFactory. The
 * clone is the channel's on-wire publisher for every member (ERC-1271), and
 * two views drive the client:
 *
 *   isValidSignature — consumed by the Streamr SDK, never called here.
 *   checkAccess      — the CURRENT gate. Decides epoch-key distribution
 *                      (answering a KEY_REQUEST) and UI state. Cached per
 *                      (gate, user) like the SDK caches isValidSignature.
 *
 * Membership is sticky on-chain (everMember); this module only ever needs the
 * current state. Writes (createGate / allow / ban / …) are owner transactions
 * signed with the local account wallet — the same wallet that already pays for
 * stream creation, so no new signing path.
 *
 * All reads go through a plain JsonRpcProvider with endpoint failover. The
 * Streamr SDK's provider is not reachable from app code, and GasEstimator's
 * raw fetch has no ABI layer — a lazy ethers provider is the smallest correct
 * tool.
 */

import { CONFIG, getRpcEndpoints } from './config.js';
import { Logger } from './logger.js';

const GATE_ABI = [
    'function initialize(address owner, uint8 mode, address token, uint256 minBalance, uint256 price, uint64 duration)',
    'function owner() view returns (address)',
    'function mode() view returns (uint8)',
    'function token() view returns (address)',
    'function minBalance() view returns (uint256)',
    'function price() view returns (uint256)',
    'function duration() view returns (uint64)',
    'function everMember(address) view returns (bool)',
    'function banned(address) view returns (bool)',
    'function erased(address) view returns (bool)',
    'function allowlist(address) view returns (bool)',
    'function paidUntil(address) view returns (uint64)',
    'function checkAccess(address user) view returns (bool)',
    'function accessUntil(address user) view returns (uint64)',
    'function allow(address user)',
    'function allowBatch(address[] users)',
    'function revokeAllow(address user)',
    'function join()',
    'function pay()',
    'function ban(address user, bool eraseHistory)',
    'function unban(address user)',
    'function unerase(address user)',
    'function moderators(address) view returns (bool)',
    'function setModerator(address user, bool enabled)',
    'event ModeratorSet(address indexed user, bool enabled)',
    'event Allowed(address indexed user)',
    'event AllowRevoked(address indexed user)',
    'event MemberJoined(address indexed user)',
    'event Paid(address indexed user, uint64 paidUntil)',
    'event Banned(address indexed user, bool erasedHistory)',
    'event Unbanned(address indexed user)',
    'event Unerased(address indexed user)',
    'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)'
];

const FACTORY_ABI = [
    'function createGate(uint8 mode, address token, uint256 minBalance, uint256 price, uint64 duration) returns (address)',
    'event GateCreated(address indexed gate, address indexed owner, uint8 mode)'
];

/** Mirrors PomboGate.Mode on-chain — order is part of the ABI, never reorder. */
export const GATE_MODE = Object.freeze({
    NONE: 0,            // Closed: owner-managed allowlist
    TOKEN_BALANCE: 1,
    NFT_OWNERSHIP: 2,
    PAID: 3
});

const GATE_MODE_NAMES = ['none', 'token', 'nft', 'paid'];

class GateManager {
    constructor() {
        this._provider = null;
        this._rpcIndex = 0;
        // (gate, user) → { value, at } — TTL'd like the SDK's ERC-1271 cache
        this._accessCache = new Map();
        // gate → immutable params ({ owner, mode, token, minBalance, price, duration })
        this._infoCache = new Map();
    }

    // ------------------------------------------------------------- provider

    _currentRpcUrl() {
        // getRpcEndpoints() reads the user's RPC preference (Settings) —
        // entries are Streamr-SDK-shaped ({ url }), not plain strings, and
        // JsonRpcProvider needs the string or it treats the object as a
        // FetchRequest ("url.clone is not a function").
        const endpoints = getRpcEndpoints();
        const entry = endpoints[this._rpcIndex % endpoints.length];
        return typeof entry === 'string' ? entry : entry?.url;
    }

    _makeProvider(url) {
        return new ethers.JsonRpcProvider(url, CONFIG.network.chainId, {
            staticNetwork: true,
            batchMaxCount: 1
        });
    }

    _getProvider() {
        // Re-resolve on every call so a Settings RPC change takes effect
        // immediately instead of after the next failure rotation.
        const url = this._currentRpcUrl();
        if (!this._provider || this._providerUrl !== url) {
            this._provider = this._makeProvider(url);
            this._providerUrl = url;
        }
        return this._provider;
    }

    /**
     * Run an RPC operation, rotating to the next endpoint once on failure.
     * Mirrors GasEstimator's sticky-with-failover behaviour.
     */
    async _withProvider(op) {
        try {
            return await op(this._getProvider());
        } catch (firstError) {
            this._rpcIndex++;
            Logger.debug('gate: RPC failed, rotating endpoint:', firstError.message);
            return op(this._getProvider());
        }
    }

    _readContract(gateAddress) {
        return new ethers.Contract(gateAddress, GATE_ABI, this._getProvider());
    }

    /** The local account wallet, connected for transactions. */
    async _txSigner() {
        const { authManager } = await import('./auth.js');
        const signer = authManager.getSigner();
        if (!signer) throw new Error('Wallet locked — cannot send gate transaction');
        return signer.connect(this._getProvider());
    }

    // ---------------------------------------------------------------- reads

    /**
     * Immutable gate parameters, fetched once per gate.
     * @returns {Promise<{owner: string, mode: number, modeName: string,
     *   token: string, minBalance: bigint, price: bigint, duration: bigint}>}
     */
    async getGateInfo(gateAddress) {
        const key = gateAddress.toLowerCase();
        if (this._infoCache.has(key)) return this._infoCache.get(key);
        const info = await this._withProvider(async () => {
            const gate = this._readContract(gateAddress);
            const [owner, mode, token, minBalance, price, duration] = await Promise.all([
                gate.owner(), gate.mode(), gate.token(),
                gate.minBalance(), gate.price(), gate.duration()
            ]);
            return {
                owner: owner.toLowerCase(),
                mode: Number(mode),
                modeName: GATE_MODE_NAMES[Number(mode)] ?? 'unknown',
                token: token.toLowerCase(),
                minBalance, price, duration
            };
        });
        this._infoCache.set(key, info);
        return info;
    }

    /**
     * The CURRENT gate for a user — key distribution and UI, never history.
     * Cached for CONFIG.gate.checkAccessCacheMs per (gate, user).
     *
     * Fail-closed: an RPC outage reports no access rather than wrapping an
     * epoch key for someone the chain might have cut. The requester retries
     * (N-B backoff) and a healthy responder or recovered RPC answers then.
     */
    async checkAccess(gateAddress, userAddress) {
        const key = `${gateAddress.toLowerCase()}|${userAddress.toLowerCase()}`;
        const cached = this._accessCache.get(key);
        if (cached && Date.now() - cached.at < CONFIG.gate.checkAccessCacheMs) {
            return cached.value;
        }
        let value;
        try {
            value = await this._withProvider(() =>
                this._readContract(gateAddress).checkAccess(userAddress));
        } catch (error) {
            Logger.warn('gate: checkAccess failed (fail-closed):', error.message);
            return false;
        }
        this._accessCache.set(key, { value, at: Date.now() });
        if (this._accessCache.size > 2000) {
            const oldest = this._accessCache.keys().next().value;
            this._accessCache.delete(oldest);
        }
        return value;
    }

    /** @returns {Promise<bigint>} 0 = no access, 2^64-1 = boolean gate open */
    accessUntil(gateAddress, userAddress) {
        return this._withProvider(() =>
            this._readContract(gateAddress).accessUntil(userAddress));
    }

    /**
     * The CURRENT on-chain state of a set of candidate addresses, plus the
     * owner — what the permissions panel renders.
     *
     * The candidate set (not the flags) comes from the caller: on a Closed
     * (NONE) gate only the owner mints members, so the locally-synced member
     * cache already names everyone. Free-tier RPCs cap eth_getLogs at 10k
     * blocks, which rules out an event scan from genesis; enumerating
     * join()/pay() members for TOKEN/PAID gates will need an indexer (N-D).
     *
     * @param {string} gateAddress
     * @param {string[]} [candidates] - Addresses to check (owner is implicit)
     * @returns {Promise<Array<{address: string, isOwner: boolean,
     *   allowed: boolean, banned: boolean, everMember: boolean, erased: boolean}>>}
     */
    async getGateMembers(gateAddress, candidates = []) {
        return this._withProvider(async () => {
            const gate = this._readContract(gateAddress);
            const owner = (await gate.owner()).toLowerCase();

            const gateAddr = gateAddress.toLowerCase();
            const addresses = new Set([owner]);
            for (const candidate of candidates) {
                const addr = String(candidate || '').toLowerCase();
                if (/^0x[0-9a-f]{40}$/.test(addr) && addr !== gateAddr) addresses.add(addr);
            }

            const members = await Promise.all(Array.from(addresses).map(async (address) => {
                const [allowed, banned, everMember, erased, moderator] = await Promise.all([
                    gate.allowlist(address), gate.banned(address),
                    gate.everMember(address), gate.erased(address),
                    // v1 gates predate the moderators getter — read as false
                    gate.moderators(address).catch(() => false)
                ]);
                return { address, allowed, banned, everMember, erased, moderator, isOwner: address === owner };
            }));
            // Owner first, then moderators, then current members, then the rest
            return members.sort((a, b) =>
                (b.isOwner - a.isOwner) || (b.moderator - a.moderator)
                || (b.allowed - a.allowed) || a.address.localeCompare(b.address));
        });
    }

    /** Drop cached access for one user (after allow/ban) or a whole gate. */
    invalidateAccess(gateAddress, userAddress = null) {
        const prefix = gateAddress.toLowerCase();
        for (const key of this._accessCache.keys()) {
            if (!key.startsWith(prefix)) continue;
            if (userAddress && key !== `${prefix}|${userAddress.toLowerCase()}`) continue;
            this._accessCache.delete(key);
        }
    }

    // ----------------------------------------------------------------- txs

    /**
     * Deploy this channel's gate clone. The caller (our wallet) becomes the
     * gate owner and is everMember from block one.
     *
     * @param {Object} [params] - Mode NONE (Closed) needs none of these
     * @returns {Promise<string>} The clone address (lowercase)
     */
    async createGate({ mode = GATE_MODE.NONE, token = ethers.ZeroAddress,
        minBalance = 0n, price = 0n, duration = 0n } = {}) {
        const signer = await this._txSigner();
        const factory = new ethers.Contract(CONFIG.gate.factoryAddress, FACTORY_ABI, signer);
        const tx = await factory.createGate(mode, token, minBalance, price, duration);
        Logger.info('gate: createGate tx', tx.hash);
        const receipt = await tx.wait();
        const created = receipt.logs
            .map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find((parsed) => parsed?.name === 'GateCreated');
        if (!created) throw new Error('createGate: no GateCreated event in receipt');
        const gateAddress = created.args.gate.toLowerCase();
        Logger.info('gate: created', gateAddress, 'mode', Number(created.args.mode));
        return gateAddress;
    }

    async _ownerCall(gateAddress, method, args, invalidateUser = null) {
        const signer = await this._txSigner();
        const gate = new ethers.Contract(gateAddress, GATE_ABI, signer);
        const tx = await gate[method](...args);
        Logger.info(`gate: ${method} tx`, tx.hash);
        await tx.wait();
        this.invalidateAccess(gateAddress, invalidateUser);
    }

    /** Closed (NONE) channels: admit a member. Sticky — also sets everMember. */
    allow(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'allow', [userAddress], userAddress);
    }

    /** Closed (NONE) channels: admit several members in one transaction. */
    allowBatch(gateAddress, userAddresses) {
        return this._ownerCall(gateAddress, 'allowBatch', [userAddresses]);
    }

    /**
     * Cut future access, keep history. In Closed channels removing a member IS
     * the ban; `eraseHistory` is the explicit owner option that additionally
     * invalidates everything they published (NONE mode only, on-chain rule).
     */
    ban(gateAddress, userAddress, eraseHistory = false) {
        return this._ownerCall(gateAddress, 'ban', [userAddress, eraseHistory], userAddress);
    }

    unban(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'unban', [userAddress], userAddress);
    }

    unerase(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'unerase', [userAddress], userAddress);
    }

    /**
     * Appoint or dismiss a moderator (owner-only on-chain; v2 gates).
     * Appointing also makes them a member — mirror the contract's semantics.
     */
    setModerator(gateAddress, userAddress, enabled) {
        return this._ownerCall(gateAddress, 'setModerator', [userAddress, enabled], userAddress);
    }

    /** Whether an address moderates this gate (v1 gates lack the getter → false). */
    async isModerator(gateAddress, userAddress) {
        try {
            return await this._withProvider(() =>
                this._readContract(gateAddress).moderators(userAddress));
        } catch {
            return false;
        }
    }

    /** Whether the given address may manage this gate's membership. */
    async canModerate(gateAddress, userAddress) {
        if (!userAddress) return false;
        try {
            const info = await this.getGateInfo(gateAddress);
            if (info.owner === userAddress.toLowerCase()) return true;
        } catch { /* fall through to the moderator read */ }
        return this.isModerator(gateAddress, userAddress);
    }
}

export const gateManager = new GateManager();
