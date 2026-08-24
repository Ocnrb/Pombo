/**
 * Android App Links depend on two things that nothing else in the suite
 * touches: a well-formed .well-known/assetlinks.json, and the deploy
 * assembling it into the artifact. The assemble step copies an explicit list
 * of paths, so a directory it does not name is silently absent from the
 * deployed site — the file would exist in the repo and 404 in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

describe('assetlinks.json', () => {
    const statements = JSON.parse(read('.well-known/assetlinks.json'));

    it('declares the Android app as a link handler', () => {
        expect(Array.isArray(statements)).toBe(true);
        expect(statements).toHaveLength(1);

        const [statement] = statements;
        expect(statement.relation).toContain('delegate_permission/common.handle_all_urls');
        expect(statement.target.namespace).toBe('android_app');
        expect(statement.target.package_name).toBe('com.pombo.android');
    });

    it('carries at least one SHA-256 fingerprint in the format Android parses', () => {
        const prints = statements[0].target.sha256_cert_fingerprints;
        expect(Array.isArray(prints)).toBe(true);
        expect(prints.length).toBeGreaterThan(0);
        for (const print of prints) {
            expect(print).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
        }
    });

    it('is copied into the Pages artifact by the deploy workflow', () => {
        expect(read('.github/workflows/deploy-pages.yml')).toMatch(/cp -r \.well-known _site\//);
    });

    it('survives the artifact packing, which strips dot entries by default', () => {
        expect(read('.github/workflows/deploy-pages.yml')).toMatch(/include-hidden-files: true/);
    });
});
