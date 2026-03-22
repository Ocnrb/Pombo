/**
 * Auth Module Tests
 * Tests for Ethereum wallet management (KeystoreV3, private keys, guest mode)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Logger before import
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

// Mock ethers
const mockWallet = {
    address: '0x1234567890AbCdEf1234567890aBcDeF12345678',
    privateKey: '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    signMessage: vi.fn().mockResolvedValue('0xsigned'),
    encrypt: vi.fn().mockResolvedValue(JSON.stringify({
        version: 3,
        crypto: {
            cipher: 'aes-128-ctr',
            ciphertext: 'encrypted',
            cipherparams: { iv: 'iv' },
            kdf: 'scrypt',
            kdfparams: { n: 131072, r: 8, p: 1 },
            mac: 'mac123'
        }
    }))
};

globalThis.ethers = {
    Wallet: {
        createRandom: vi.fn(() => mockWallet),
        fromEncryptedJson: vi.fn().mockResolvedValue(mockWallet)
    }
};

// Import after mocks
import { authManager } from '../../src/js/auth.js';
import { Logger } from '../../src/js/logger.js';

describe('AuthManager', () => {
    let originalLocalStorage;
    let originalEthers;

    beforeEach(() => {
        // Reset authManager state
        authManager.wallet = null;
        authManager.address = null;
        authManager.signer = null;
        authManager.currentWalletName = null;
        authManager.isGuest = false;
        
        // Clear mocks
        vi.clearAllMocks();
        
        // Mock localStorage
        originalLocalStorage = globalThis.localStorage;
        const storage = {};
        globalThis.localStorage = {
            getItem: vi.fn((key) => storage[key] || null),
            setItem: vi.fn((key, value) => { storage[key] = value; }),
            removeItem: vi.fn((key) => { delete storage[key]; }),
            clear: vi.fn(() => { Object.keys(storage).forEach(k => delete storage[k]); })
        };
        
        // Save original ethers and reset mock
        originalEthers = globalThis.ethers;
        
        // Reset mock wallet
        mockWallet.address = '0x1234567890AbCdEf1234567890aBcDeF12345678';
        mockWallet.signMessage = vi.fn().mockResolvedValue('0xsigned');
        mockWallet.encrypt = vi.fn().mockResolvedValue(JSON.stringify({
            version: 3,
            crypto: {
                cipher: 'aes-128-ctr',
                ciphertext: 'encrypted',
                cipherparams: { iv: 'iv' },
                kdf: 'scrypt',
                kdfparams: { n: 131072, r: 8, p: 1 },
                mac: 'mac123'
            }
        }));
        
        // Reset ethers mock to default
        globalThis.ethers = {
            Wallet: {
                createRandom: vi.fn(() => mockWallet),
                fromEncryptedJson: vi.fn().mockResolvedValue(mockWallet)
            }
        };
    });

    afterEach(() => {
        globalThis.localStorage = originalLocalStorage;
        globalThis.ethers = originalEthers;
    });

    // ==================== CONSTRUCTOR / INITIAL STATE ====================

    describe('Initial State', () => {
        it('should have null wallet', () => {
            expect(authManager.wallet).toBeNull();
        });

        it('should have null address', () => {
            expect(authManager.address).toBeNull();
        });

        it('should have null signer', () => {
            expect(authManager.signer).toBeNull();
        });

        it('should not be in guest mode', () => {
            expect(authManager.isGuest).toBe(false);
        });
    });

    // ==================== GENERATE LOCAL WALLET ====================

    describe('generateLocalWallet()', () => {
        it('should generate a random wallet', () => {
            const result = authManager.generateLocalWallet();
            
            expect(ethers.Wallet.createRandom).toHaveBeenCalled();
            expect(result.address).toBe(mockWallet.address);
        });

        it('should set wallet in authManager', () => {
            authManager.generateLocalWallet();
            
            expect(authManager.wallet).toBe(mockWallet);
            expect(authManager.address).toBe(mockWallet.address);
            expect(authManager.signer).toBe(mockWallet);
        });

        it('should return address, privateKey and signer', () => {
            const result = authManager.generateLocalWallet();
            
            expect(result).toHaveProperty('address');
            expect(result).toHaveProperty('privateKey');
            expect(result).toHaveProperty('signer');
        });

        it('should reset guest flag', () => {
            authManager.isGuest = true;
            
            authManager.generateLocalWallet();
            
            expect(authManager.isGuest).toBe(false);
        });

        it('should throw on ethers error', () => {
            ethers.Wallet.createRandom.mockImplementationOnce(() => {
                throw new Error('Crypto error');
            });
            
            expect(() => authManager.generateLocalWallet()).toThrow('Crypto error');
        });
    });

    // ==================== IMPORT PRIVATE KEY ====================

    describe('importPrivateKey()', () => {
        beforeEach(() => {
            // Mock Wallet constructor for import - must be a proper class/constructor
            const MockWallet = function(pk) {
                this.address = mockWallet.address;
                this.privateKey = pk;
                this.signer = mockWallet;
            };
            MockWallet.createRandom = vi.fn(() => mockWallet);
            MockWallet.fromEncryptedJson = vi.fn().mockResolvedValue(mockWallet);
            globalThis.ethers.Wallet = MockWallet;
        });

        it('should import wallet from private key', () => {
            const result = authManager.importPrivateKey('0xprivatekey');
            
            expect(result.address).toBe(mockWallet.address);
        });

        it('should set wallet in authManager', () => {
            authManager.importPrivateKey('0xprivatekey');
            
            expect(authManager.wallet).toBeDefined();
            expect(authManager.address).toBe(mockWallet.address);
        });

        it('should reset guest flag', () => {
            authManager.isGuest = true;
            
            authManager.importPrivateKey('0xprivatekey');
            
            expect(authManager.isGuest).toBe(false);
        });

        it('should throw on invalid key', () => {
            const MockWalletThrowing = function() {
                throw new Error('Invalid private key');
            };
            MockWalletThrowing.createRandom = vi.fn(() => mockWallet);
            MockWalletThrowing.fromEncryptedJson = vi.fn();
            globalThis.ethers.Wallet = MockWalletThrowing;
            
            expect(() => authManager.importPrivateKey('invalid')).toThrow('Invalid private key');
        });
    });

    // ==================== GUEST MODE ====================

    describe('connectAsGuest()', () => {
        beforeEach(() => {
            globalThis.ethers.Wallet.createRandom = vi.fn(() => mockWallet);
        });

        it('should create ephemeral wallet', () => {
            const result = authManager.connectAsGuest();
            
            expect(ethers.Wallet.createRandom).toHaveBeenCalled();
            expect(result.address).toBe(mockWallet.address);
        });

        it('should set isGuest to true', () => {
            authManager.connectAsGuest();
            
            expect(authManager.isGuest).toBe(true);
        });

        it('should set wallet name to Guest', () => {
            authManager.connectAsGuest();
            
            expect(authManager.currentWalletName).toBe('Guest');
        });

        it('should return address and signer', () => {
            const result = authManager.connectAsGuest();
            
            expect(result).toHaveProperty('address');
            expect(result).toHaveProperty('signer');
        });

        it('should throw on error', () => {
            ethers.Wallet.createRandom.mockImplementationOnce(() => {
                throw new Error('Random error');
            });
            
            expect(() => authManager.connectAsGuest()).toThrow('Random error');
        });
    });

    describe('isGuestMode()', () => {
        it('should return true when in guest mode', () => {
            authManager.isGuest = true;
            
            expect(authManager.isGuestMode()).toBe(true);
        });

        it('should return false when not in guest mode', () => {
            authManager.isGuest = false;
            
            expect(authManager.isGuestMode()).toBe(false);
        });
    });

    // ==================== DISCONNECT ====================

    describe('disconnect()', () => {
        beforeEach(() => {
            authManager.wallet = mockWallet;
            authManager.address = mockWallet.address;
            authManager.signer = mockWallet;
            authManager.currentWalletName = 'Test';
            authManager.isGuest = true;
        });

        it('should clear wallet', () => {
            authManager.disconnect();
            
            expect(authManager.wallet).toBeNull();
        });

        it('should clear address', () => {
            authManager.disconnect();
            
            expect(authManager.address).toBeNull();
        });

        it('should clear signer', () => {
            authManager.disconnect();
            
            expect(authManager.signer).toBeNull();
        });

        it('should reset guest flag', () => {
            authManager.disconnect();
            
            expect(authManager.isGuest).toBe(false);
        });

        it('should clear wallet name', () => {
            authManager.disconnect();
            
            expect(authManager.currentWalletName).toBeNull();
        });
    });

    // ==================== GETTERS ====================

    describe('getAddress()', () => {
        it('should return current address', () => {
            authManager.address = '0xMyAddress';
            
            expect(authManager.getAddress()).toBe('0xMyAddress');
        });

        it('should return null when not connected', () => {
            authManager.address = null;
            
            expect(authManager.getAddress()).toBeNull();
        });
    });

    describe('getWalletName()', () => {
        it('should return current wallet name', () => {
            authManager.currentWalletName = 'My Wallet';
            
            expect(authManager.getWalletName()).toBe('My Wallet');
        });
    });

    describe('getSigner()', () => {
        it('should return current signer', () => {
            authManager.signer = mockWallet;
            
            expect(authManager.getSigner()).toBe(mockWallet);
        });
    });

    describe('isConnected()', () => {
        it('should return true when address is set', () => {
            authManager.address = '0xAddress';
            
            expect(authManager.isConnected()).toBe(true);
        });

        it('should return false when address is null', () => {
            authManager.address = null;
            
            expect(authManager.isConnected()).toBe(false);
        });
    });

    // ==================== SIGN MESSAGE ====================

    describe('signMessage()', () => {
        it('should sign message with signer', async () => {
            authManager.signer = mockWallet;
            
            const signature = await authManager.signMessage('hello');
            
            expect(mockWallet.signMessage).toHaveBeenCalledWith('hello');
            expect(signature).toBe('0xsigned');
        });

        it('should throw if no signer', async () => {
            authManager.signer = null;
            
            await expect(authManager.signMessage('hello')).rejects.toThrow('No signer available');
        });

        it('should propagate signer errors', async () => {
            authManager.signer = { signMessage: vi.fn().mockRejectedValue(new Error('Sign failed')) };
            
            await expect(authManager.signMessage('hello')).rejects.toThrow('Sign failed');
        });
    });

    // ==================== KEYSTORE VALIDATION ====================

    describe('validateKeystore()', () => {
        it('should accept valid keystore', () => {
            const keystore = {
                version: 3,
                crypto: {
                    cipher: 'aes-128-ctr',
                    ciphertext: 'abc',
                    cipherparams: { iv: '123' },
                    kdf: 'scrypt',
                    kdfparams: {},
                    mac: 'mac123'
                }
            };
            
            expect(authManager.validateKeystore(keystore)).toBe(true);
        });

        it('should accept Crypto (uppercase) key', () => {
            const keystore = {
                version: 3,
                Crypto: {
                    cipher: 'aes-128-ctr',
                    ciphertext: 'abc',
                    cipherparams: { iv: '123' },
                    kdf: 'scrypt',
                    kdfparams: {},
                    mac: 'mac123'
                }
            };
            
            expect(authManager.validateKeystore(keystore)).toBe(true);
        });

        it('should reject empty keystore', () => {
            expect(() => authManager.validateKeystore(null)).toThrow('Invalid keystore: empty');
        });

        it('should reject wrong version', () => {
            expect(() => authManager.validateKeystore({ version: 2 })).toThrow('Invalid keystore version');
        });

        it('should reject missing crypto section', () => {
            expect(() => authManager.validateKeystore({ version: 3 })).toThrow('missing crypto section');
        });

        it('should reject missing cipher', () => {
            expect(() => authManager.validateKeystore({
                version: 3,
                crypto: { ciphertext: 'a', cipherparams: {}, kdf: 's', kdfparams: {}, mac: 'm' }
            })).toThrow('missing cipher data');
        });

        it('should reject missing kdf', () => {
            expect(() => authManager.validateKeystore({
                version: 3,
                crypto: { cipher: 'a', ciphertext: 'b', cipherparams: {}, mac: 'm' }
            })).toThrow('missing KDF data');
        });

        it('should reject missing mac', () => {
            expect(() => authManager.validateKeystore({
                version: 3,
                crypto: { cipher: 'a', ciphertext: 'b', cipherparams: {}, kdf: 's', kdfparams: {} }
            })).toThrow('missing MAC');
        });
    });

    // ==================== KEYSTORE STORAGE ====================

    describe('loadAllKeystores()', () => {
        it('should return empty object if nothing saved', () => {
            const result = authManager.loadAllKeystores();
            
            expect(result).toEqual({});
        });

        it('should return parsed keystores', () => {
            const wallets = { '0xabc': { name: 'Test', keystore: {} } };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            
            const result = authManager.loadAllKeystores();
            
            expect(result).toEqual(wallets);
        });

        it('should throw on invalid JSON', () => {
            localStorage.getItem.mockReturnValue('invalid json');
            
            expect(() => authManager.loadAllKeystores())
                .toThrow('Keystore data is corrupted');
        });
    });

    describe('listSavedWallets()', () => {
        it('should return array of wallet info', () => {
            const wallets = {
                '0xabc': { name: 'Wallet 1', createdAt: 1000, lastUsed: 2000, keystore: { version: 3 } },
                '0xdef': { name: 'Wallet 2', createdAt: 1500, lastUsed: 2500, keystore: { version: 3 } }
            };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            
            const result = authManager.listSavedWallets();
            
            expect(result).toHaveLength(2);
            expect(result[0]).toHaveProperty('address');
            expect(result[0]).toHaveProperty('name');
            expect(result[0]).toHaveProperty('version', 3);
        });

        it('should return empty array if no wallets', () => {
            const result = authManager.listSavedWallets();
            
            expect(result).toEqual([]);
        });
    });

    describe('hasSavedWallet()', () => {
        it('should return true when wallets exist', () => {
            localStorage.getItem.mockReturnValue(JSON.stringify({ '0xabc': {} }));
            
            expect(authManager.hasSavedWallet()).toBe(true);
        });

        it('should return false when no wallets', () => {
            expect(authManager.hasSavedWallet()).toBe(false);
        });
    });

    describe('updateWalletName()', () => {
        beforeEach(() => {
            const wallets = { '0xabc': { name: 'Old Name' } };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
        });

        it('should update wallet name', () => {
            const result = authManager.updateWalletName('New Name', '0xabc');
            
            expect(result).toBe(true);
            expect(localStorage.setItem).toHaveBeenCalled();
        });

        it('should update current wallet name if matching', () => {
            authManager.address = '0xABC';
            
            authManager.updateWalletName('New Name', '0xabc');
            
            expect(authManager.currentWalletName).toBe('New Name');
        });

        it('should throw if wallet not found', () => {
            expect(() => authManager.updateWalletName('New', '0xnotfound'))
                .toThrow('Wallet not found');
        });

        it('should throw if no address', () => {
            authManager.address = null;
            
            expect(() => authManager.updateWalletName('New'))
                .toThrow('No wallet address available');
        });
    });

    describe('exportKeystore()', () => {
        it('should return keystore JSON', () => {
            const wallets = {
                '0xabc': { keystore: { version: 3, crypto: {} } }
            };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            
            const result = authManager.exportKeystore('0xabc');
            
            expect(JSON.parse(result)).toHaveProperty('version', 3);
        });

        it('should throw if no address specified', () => {
            authManager.address = null;
            
            expect(() => authManager.exportKeystore()).toThrow('No wallet address');
        });

        it('should throw if wallet not found', () => {
            expect(() => authManager.exportKeystore('0xnotfound')).toThrow('Wallet not found');
        });

        it('should use current address as default', () => {
            authManager.address = '0xABC';
            const wallets = { '0xabc': { keystore: { version: 3 } } };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            
            const result = authManager.exportKeystore();
            
            expect(JSON.parse(result)).toHaveProperty('version', 3);
        });
    });

    describe('deleteWallet()', () => {
        beforeEach(() => {
            const wallets = { '0xabc': { name: 'Test' } };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
        });

        it('should delete wallet from storage', () => {
            const result = authManager.deleteWallet('0xabc');
            
            expect(result).toBe(true);
            expect(localStorage.setItem).toHaveBeenCalled();
        });

        it('should throw if wallet not found', () => {
            expect(() => authManager.deleteWallet('0xnotfound')).toThrow('Wallet not found');
        });

        it('should disconnect if deleting current wallet', () => {
            authManager.address = '0xABC';
            authManager.wallet = mockWallet;
            
            authManager.deleteWallet('0xabc');
            
            expect(authManager.address).toBeNull();
        });
    });

    // ==================== SAVE/LOAD ENCRYPTED ====================

    describe('saveWalletEncrypted()', () => {
        beforeEach(() => {
            authManager.wallet = mockWallet;
            authManager.address = mockWallet.address;
        });

        it('should encrypt and save wallet', async () => {
            const result = await authManager.saveWalletEncrypted('password');
            
            expect(mockWallet.encrypt).toHaveBeenCalledWith('password');
            expect(localStorage.setItem).toHaveBeenCalled();
            expect(result.address).toBe(mockWallet.address);
        });

        it('should use provided name', async () => {
            const result = await authManager.saveWalletEncrypted('password', 'My Wallet');
            
            expect(result.name).toBe('My Wallet');
        });

        it('should use default name if not provided', async () => {
            const result = await authManager.saveWalletEncrypted('password');
            
            expect(result.name).toContain('Wallet');
        });

        it('should throw if no wallet', async () => {
            authManager.wallet = null;
            
            await expect(authManager.saveWalletEncrypted('password')).rejects.toThrow('No local wallet');
        });

        it('should pass progress callback to encrypt', async () => {
            const progressFn = vi.fn();
            
            await authManager.saveWalletEncrypted('password', null, progressFn);
            
            expect(mockWallet.encrypt).toHaveBeenCalledWith('password', progressFn);
        });
    });

    describe('loadWalletEncrypted()', () => {
        const validKeystore = {
            version: 3,
            crypto: {
                cipher: 'aes-128-ctr',
                ciphertext: 'encrypted',
                cipherparams: { iv: 'iv' },
                kdf: 'scrypt',
                kdfparams: {},
                mac: 'mac123'
            }
        };

        beforeEach(() => {
            const wallets = {
                '0x1234567890abcdef1234567890abcdef12345678': {
                    name: 'Test Wallet',
                    keystore: validKeystore,
                    lastUsed: 1000
                }
            };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
        });

        it('should decrypt and load wallet', async () => {
            const result = await authManager.loadWalletEncrypted('password');
            
            expect(ethers.Wallet.fromEncryptedJson).toHaveBeenCalled();
            expect(result.address).toBe(mockWallet.address);
        });

        it('should set authManager state', async () => {
            await authManager.loadWalletEncrypted('password');
            
            expect(authManager.wallet).toBe(mockWallet);
            expect(authManager.address).toBe(mockWallet.address);
            expect(authManager.isGuest).toBe(false);
        });

        it('should load specific address', async () => {
            await authManager.loadWalletEncrypted('password', '0x1234567890abcdef1234567890abcdef12345678');
            
            expect(authManager.address).toBe(mockWallet.address);
        });

        it('should throw if no saved wallets', async () => {
            localStorage.getItem.mockReturnValue(null);
            
            await expect(authManager.loadWalletEncrypted('password')).rejects.toThrow('No saved wallets');
        });

        it('should throw if specific wallet not found', async () => {
            await expect(authManager.loadWalletEncrypted('password', '0xnotfound')).rejects.toThrow('Wallet not found');
        });

        it('should update lastUsed timestamp', async () => {
            await authManager.loadWalletEncrypted('password');
            
            expect(localStorage.setItem).toHaveBeenCalled();
        });

        it('should pass progress callback', async () => {
            const progressFn = vi.fn();
            
            await authManager.loadWalletEncrypted('password', null, progressFn);
            
            expect(ethers.Wallet.fromEncryptedJson).toHaveBeenCalledWith(
                expect.any(String),
                'password',
                progressFn
            );
        });
    });

    describe('importKeystore()', () => {
        const validKeystoreJson = JSON.stringify({
            version: 3,
            crypto: {
                cipher: 'aes-128-ctr',
                ciphertext: 'encrypted',
                cipherparams: { iv: 'iv' },
                kdf: 'scrypt',
                kdfparams: {},
                mac: 'mac123'
            }
        });

        it('should import and set wallet', async () => {
            const result = await authManager.importKeystore(validKeystoreJson, 'password', 'My Imported');
            
            expect(result.name).toBe('My Imported');
            expect(authManager.wallet).toBe(mockWallet);
        });

        it('should save to storage', async () => {
            await authManager.importKeystore(validKeystoreJson, 'password');
            
            expect(localStorage.setItem).toHaveBeenCalled();
        });

        it('should throw on invalid JSON', async () => {
            await expect(authManager.importKeystore('invalid', 'password')).rejects.toThrow();
        });

        it('should throw on invalid keystore structure', async () => {
            await expect(authManager.importKeystore('{}', 'password')).rejects.toThrow();
        });
    });

    // ==================== CHANGE PASSWORD / GET PRIVATE KEY ====================

    describe('changePassword()', () => {
        const validKeystore = {
            version: 3,
            crypto: {
                cipher: 'aes-128-ctr',
                ciphertext: 'encrypted',
                cipherparams: { iv: 'iv' },
                kdf: 'scrypt',
                kdfparams: {},
                mac: 'mac123'
            }
        };

        beforeEach(() => {
            const wallets = {
                '0x1234567890abcdef1234567890abcdef12345678': {
                    name: 'Test',
                    keystore: validKeystore,
                    lastUsed: 1000
                }
            };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            authManager.address = '0x1234567890abcdef1234567890abcdef12345678';
            authManager.wallet = mockWallet;
        });

        it('should re-encrypt with new password', async () => {
            const result = await authManager.changePassword('oldpass', 'newpass');
            
            expect(result).toBe(true);
            expect(mockWallet.encrypt).toHaveBeenCalledWith('newpass');
        });

        it('should throw without address', async () => {
            authManager.address = null;
            
            await expect(authManager.changePassword('old', 'new')).rejects.toThrow('No wallet address');
        });
    });

    describe('getPrivateKey()', () => {
        const validKeystore = {
            version: 3,
            crypto: {
                cipher: 'aes-128-ctr',
                ciphertext: 'encrypted',
                cipherparams: { iv: 'iv' },
                kdf: 'scrypt',
                kdfparams: {},
                mac: 'mac123'
            }
        };

        beforeEach(() => {
            const wallets = {
                '0x1234567890abcdef1234567890abcdef12345678': {
                    name: 'Test',
                    keystore: validKeystore
                }
            };
            localStorage.getItem.mockReturnValue(JSON.stringify(wallets));
            authManager.address = '0x1234567890abcdef1234567890abcdef12345678';
        });

        it('should return private key after verification', async () => {
            const privateKey = await authManager.getPrivateKey('password');
            
            expect(privateKey).toBe(mockWallet.privateKey);
        });

        it('should throw without address', async () => {
            authManager.address = null;
            
            await expect(authManager.getPrivateKey('password')).rejects.toThrow('No wallet address');
        });

        it('should throw if wallet not found', async () => {
            localStorage.getItem.mockReturnValue(JSON.stringify({}));
            
            await expect(authManager.getPrivateKey('password')).rejects.toThrow('Wallet not found');
        });

        it('should throw on wrong password', async () => {
            ethers.Wallet.fromEncryptedJson.mockRejectedValueOnce(new Error('invalid password'));
            
            await expect(authManager.getPrivateKey('wrongpass')).rejects.toThrow('Incorrect password');
        });
    });
});
