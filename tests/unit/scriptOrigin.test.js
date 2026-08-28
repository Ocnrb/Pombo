/**
 * Every script the app runs is bundled and served from this origin. The bet
 * only holds while three things stay true together: the page carries no
 * inline script and no foreign src, the policy that enforces it allows
 * neither, and the two copies of that policy (the meta tag GitHub Pages
 * needs, and the header Vercel sends) agree.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const index = read('index.html');
const vercel = read('vercel.json');
const webpackEntries = Object.keys(
    // eslint-disable-next-line no-undef
    require(resolve(root, 'webpack.config.js')).entry
);

const cspOf = (text) => {
    const match = text.match(/default-src 'self';[^"]*/);
    return Object.fromEntries(
        match[0].split(';').map((d) => d.trim()).filter(Boolean)
            .map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')])
    );
};

const scriptTags = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .map(([, attrs, body]) => ({
        attrs,
        body,
        src: (attrs.match(/\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || null,
    }));

describe('no third-party code runs', () => {
    it('ships script tags, and every one of them has a src', () => {
        expect(scriptTags.length).toBeGreaterThan(0);
        const inline = scriptTags.filter((tag) => !tag.src);
        expect(inline.map((tag) => tag.body.trim().slice(0, 80))).toEqual([]);
    });

    it('carries no code between script tags', () => {
        const withBody = scriptTags.filter((tag) => tag.body.trim() !== '');
        expect(withBody.map((tag) => tag.src)).toEqual([]);
    });

    it('loads every script from this origin by relative path', () => {
        for (const { src } of scriptTags) {
            expect(src, `${src} is not a relative path`).toMatch(/^\.?\//);
            expect(src.startsWith('//'), `${src} is protocol relative`).toBe(false);
            expect(/^[a-z][a-z0-9+.-]*:/i.test(src), `${src} carries a scheme`).toBe(false);
        }
    });

    it('points every script at a file this repo builds or ships', () => {
        for (const { src } of scriptTags) {
            const path = src.replace(/^\.?\//, '').split('?')[0];
            const bundled = webpackEntries.some((name) => path === `js/${name}.bundle.js`);
            expect(bundled || existsSync(resolve(root, path)), `${path} is neither built nor committed`).toBe(true);
        }
    });

    describe('the policy that enforces it', () => {
        const meta = cspOf(index);
        const header = cspOf(vercel);

        it('falls back to this origin for anything undeclared', () => {
            expect(meta['default-src']).toBe("'self'");
            expect(header['default-src']).toBe("'self'");
        });

        it('allows scripts from this origin only', () => {
            for (const [where, policy] of [['meta', meta], ['header', header]]) {
                const sources = policy['script-src'].split(/\s+/);
                expect(sources, `${where} drops 'self'`).toContain("'self'");
                for (const source of sources) {
                    const allowed = source === "'self'" || /^'sha256-[A-Za-z0-9+/=]+'$/.test(source);
                    expect(allowed, `${where} allows script source ${source}`).toBe(true);
                }
            }
        });

        it('allows at most the one inline hash the dev server needs', () => {
            for (const [where, policy] of [['meta', meta], ['header', header]]) {
                const hashes = policy['script-src'].split(/\s+/).filter((s) => s.startsWith("'sha256-"));
                expect(hashes.length, `${where} carries ${hashes.length} inline hashes`).toBeLessThanOrEqual(1);
            }
        });

        it('keeps both copies agreeing on where scripts come from', () => {
            expect(meta['script-src']).toBe(header['script-src']);
            expect(meta['worker-src']).toBe(header['worker-src']);
            expect(meta['base-uri']).toBe(header['base-uri']);
        });

        it('keeps workers on this origin', () => {
            for (const [where, policy] of [['meta', meta], ['header', header]]) {
                for (const source of policy['worker-src'].split(/\s+/)) {
                    expect(["'self'", 'blob:'].includes(source), `${where} allows worker source ${source}`).toBe(true);
                }
            }
        });

        it('pins the document base so relative script paths cannot be redirected', () => {
            expect(meta['base-uri']).toBe("'self'");
        });
    });
});
