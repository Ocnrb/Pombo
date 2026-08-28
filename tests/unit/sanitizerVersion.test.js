/**
 * Version floor for the sanitizer.
 *
 * DOMPurify sits between hostile remote text and an innerHTML sink, so the
 * exact version is part of the security model. 3.4.13 is the first release
 * with no advisory outstanding against it; anything below is a downgrade and
 * has to fail here rather than in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import DOMPurify from 'dompurify';

const MINIMUM = [3, 4, 13];

function parseVersion(version) {
    const core = String(version).split('-')[0];
    const parts = core.split('.').map(Number);
    expect(parts, `unreadable version: ${version}`).toHaveLength(3);
    expect(parts.some(Number.isNaN), `unreadable version: ${version}`).toBe(false);
    return parts;
}

function isAtLeastMinimum(version) {
    const parts = parseVersion(version);
    for (let i = 0; i < MINIMUM.length; i++) {
        if (parts[i] > MINIMUM[i]) return true;
        if (parts[i] < MINIMUM[i]) return false;
    }
    return true;
}

const readJson = (relativePath) => JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
);

describe('sanitizer version floor', () => {
    const floor = MINIMUM.join('.');

    it(`runs DOMPurify >= ${floor}`, () => {
        expect(isAtLeastMinimum(DOMPurify.version), `running DOMPurify ${DOMPurify.version}`).toBe(true);
    });

    it(`pins DOMPurify >= ${floor} in the lockfile`, () => {
        const lock = readJson('../../package-lock.json');
        const entry = lock.packages?.['node_modules/dompurify'];
        expect(entry, 'dompurify missing from the lockfile').toBeDefined();
        expect(isAtLeastMinimum(entry.version), `lockfile pins DOMPurify ${entry.version}`).toBe(true);
    });

    it(`declares a range starting at >= ${floor}`, () => {
        const declared = readJson('../../package.json').dependencies?.dompurify;
        expect(declared, 'dompurify missing from package.json').toBeDefined();
        expect(isAtLeastMinimum(declared.replace(/^[^0-9]*/, '')), `package.json declares ${declared}`).toBe(true);
    });
});
