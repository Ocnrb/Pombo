/**
 * Storage panel: one retention figure, plus the badges that say when a
 * channel's stored streams (-1, -3, and -4 on gated) drifted apart.
 *
 * Without them the panel reports the message stream and stays silent about
 * the others, which is how a keys stream ends up purging on a schedule
 * nobody chose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/ui/ModalManager.js', () => ({ modalManager: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/graph.js', () => ({ graphAPI: {} }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { getCachedENS: vi.fn(() => null) } }));
vi.mock('../../src/js/media.js', () => ({ mediaController: {} }));
vi.mock('../../src/js/channelImageManager.js', () => ({ channelImageManager: {} }));

const { channelSettingsUI } = await import('../../src/js/ui/ChannelSettingsUI.js');

const POMBO_NODE = '0xae340e799e8151f6a4999d245e466197aa217667';

describe('storage panel rendering', () => {
    let readonly;
    let mixed;
    let list;

    beforeEach(() => {
        document.body.innerHTML = `
            <label>Retention Period<span id="channel-storage-retention-mixed" class="hidden"></span></label>
            <div id="channel-storage-retention-readonly">-</div>
            <input id="channel-storage-retention-input" />
            <div id="channel-storage-nodes-list"></div>
            <div id="channel-storage-no-storage" class="hidden"></div>
        `;
        readonly = document.getElementById('channel-storage-retention-readonly');
        mixed = document.getElementById('channel-storage-retention-mixed');
        list = document.getElementById('channel-storage-nodes-list');
        channelSettingsUI.elements = {
            channelStorageRetentionReadonly: readonly,
            channelStorageRetentionMixed: mixed,
            channelStorageRetentionInput: document.getElementById('channel-storage-retention-input'),
            channelStorageNodesList: list,
            channelStorageNoStorage: document.getElementById('channel-storage-no-storage')
        };
        channelSettingsUI.deps = { showNotification: vi.fn() };
    });

    const node = (extra = {}) => ({
        address: POMBO_NODE, onMessage: true, onAdmin: true, onKeys: true, ...extra
    });
    const info = (extra = {}) => ({
        enabled: true,
        nodes: [node()],
        storageDays: 180,
        retention: { message: 180, admin: 180, keys: 180 },
        retentionInSync: true,
        hasKeysStream: true,
        ...extra
    });

    describe('retention', () => {
        it('shows one figure, the message stream one', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: 3 }
            }), false);
            expect(readonly.textContent).toContain('180 days');
        });

        it('stays unbadged when the streams agree', () => {
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(readonly.textContent).toBe('180 days');
            expect(mixed.classList.contains('hidden')).toBe(true);
        });

        it('badges the label when the streams hold different retentions', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 180, keys: 3 },
                retentionInSync: false
            }), false);

            expect(mixed.classList.contains('hidden')).toBe(false);
            expect(mixed.textContent).toBe('mixed');
            expect(readonly.textContent).toBe('180 days');
        });

        // The figure is swapped for an editor for whoever can manage the
        // channel, so a badge living inside it is hidden from the only
        // person who can act on it.
        it('keeps the badge outside the figure that gets swapped for the editor', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), true);
            expect(readonly.contains(mixed)).toBe(false);
        });

        it('names what each stream holds in the badge title', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: 3 },
                retentionInSync: false
            }), false);

            expect(mixed.title).toContain('messages 180');
            expect(mixed.title).toContain('admin 30');
            expect(mixed.title).toContain('keys 3');
        });

        it('leaves the keys stream out of the badge title when there is none', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: null },
                retentionInSync: false,
                hasKeysStream: false
            }), false);

            expect(mixed.title).toContain('admin 30');
            expect(mixed.title).not.toContain('keys');
        });

        it('clears the badge again once the streams agree', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), false);
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(mixed.classList.contains('hidden')).toBe(true);
        });
    });

    describe('node list', () => {
        it('does not badge a node present on every stored stream', () => {
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(list.innerHTML).not.toContain('partial');
        });

        it('badges a node missing from the keys stream', () => {
            channelSettingsUI._renderStorageList({}, info({
                nodes: [node({ onKeys: false })]
            }), false);
            expect(list.innerHTML).toContain('partial');
        });

        it('does not badge a missing keys flag on a channel with no keys stream', () => {
            channelSettingsUI._renderStorageList({}, info({
                nodes: [node({ onKeys: false })],
                retention: { message: 180, admin: 180, keys: null },
                hasKeysStream: false
            }), false);
            expect(list.innerHTML).not.toContain('partial');
        });
    });
});

describe('_reportStorageResult()', () => {
    let notify;

    beforeEach(() => {
        notify = vi.fn();
        channelSettingsUI.deps = { showNotification: notify };
    });

    const ok = { success: true };
    const bad = { success: false, error: 'rpc down' };

    it('reports success only when every stream took the change', () => {
        channelSettingsUI._reportStorageResult({ message: ok, admin: ok, keys: ok }, 'add');
        expect(notify).toHaveBeenCalledWith('Storage node added', 'success');
    });

    it('reports partial when the keys stream alone failed', () => {
        channelSettingsUI._reportStorageResult({ message: ok, admin: ok, keys: bad }, 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('partially'), 'error');
    });

    it('treats a channel with no keys stream as complete', () => {
        channelSettingsUI._reportStorageResult({ message: ok, admin: ok, keys: null }, 'remove');
        expect(notify).toHaveBeenCalledWith('Storage node removed', 'success');
    });

    it('reports outright failure when nothing took the change', () => {
        channelSettingsUI._reportStorageResult({ message: bad, admin: bad, keys: bad }, 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed to add'), 'error');
    });
});
