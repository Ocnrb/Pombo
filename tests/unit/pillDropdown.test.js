import { describe, it, expect } from 'vitest';
import { positionPillDropdown } from '../../src/js/ui/pillDropdown.js';

function fakeDropdown({ wrapperLeft, wrapperWidth, width }) {
    return {
        style: {},
        offsetWidth: width,
        parentElement: {
            getBoundingClientRect: () => ({ left: wrapperLeft, width: wrapperWidth }),
        },
    };
}

function setViewportWidth(value) {
    Object.defineProperty(document.documentElement, 'clientWidth', {
        value,
        configurable: true,
    });
}

describe('positionPillDropdown', () => {
    it('centres the card on the icon when it fits', () => {
        setViewportWidth(400);
        const dropdown = fakeDropdown({ wrapperLeft: 160, wrapperWidth: 40, width: 200 });
        positionPillDropdown(dropdown);
        // anchor 180, card left 80 → 80px left of the wrapper
        expect(dropdown.style.left).toBe('-80px');
        expect(dropdown.style.right).toBe('auto');
        // origin at the icon, i.e. the card's centre
        expect(dropdown.style.transformOrigin).toBe('100px bottom');
    });

    it('clamps to the left screen margin while the origin stays on the icon', () => {
        setViewportWidth(360);
        const dropdown = fakeDropdown({ wrapperLeft: 80, wrapperWidth: 40, width: 200 });
        positionPillDropdown(dropdown);
        // anchor 100: centred the card would start at 0 — clamped to 8
        expect(dropdown.style.left).toBe('-72px');
        expect(dropdown.style.transformOrigin).toBe('92px bottom');
    });

    it('clamps to the right screen margin while the origin stays on the icon', () => {
        setViewportWidth(360);
        const dropdown = fakeDropdown({ wrapperLeft: 300, wrapperWidth: 40, width: 200 });
        positionPillDropdown(dropdown);
        // anchor 320: centred the card would end at 420 — clamped to 352
        expect(dropdown.style.left).toBe('-148px');
        expect(dropdown.style.transformOrigin).toBe('168px bottom');
    });

    it('does nothing without a wrapper', () => {
        const dropdown = { style: {}, offsetWidth: 200, parentElement: null };
        positionPillDropdown(dropdown);
        expect(dropdown.style.left).toBeUndefined();
    });
});
