/**
 * Inter is served from this origin so that opening the app talks to nobody
 * but this origin. Three things have to hold together for that: the
 * @font-face rules point at files that exist, no CDN reference survives
 * anywhere, and the deploy copies fonts/ into the artifact. The assemble step
 * copies an explicit list of paths, so a directory it does not name is
 * committed and 404s in production.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const css = read('src/styles/components.css');
const index = read('index.html');
const vercel = read('vercel.json');
const workflow = read('.github/workflows/deploy-pages.yml');

const cssUrls = [...css.matchAll(/url\('\.\.\/(fonts\/[^']+)'\)/g)].map(m => m[1]);

const cspOf = (text) => {
    const match = text.match(/default-src 'self';[^"]*/);
    return Object.fromEntries(
        match[0].split(';').map(d => d.trim()).filter(Boolean)
            .map(d => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')])
    );
};

describe('Inter web fonts', () => {
    it('declares every subset the Google stylesheet used to cover', () => {
        expect(cssUrls).toEqual([
            'fonts/inter-cyrillic-ext.woff2',
            'fonts/inter-cyrillic.woff2',
            'fonts/inter-greek-ext.woff2',
            'fonts/inter-greek.woff2',
            'fonts/inter-vietnamese.woff2',
            'fonts/inter-latin-ext.woff2',
            'fonts/inter-latin.woff2'
        ]);
    });

    it.each(['fonts/inter-latin.woff2'])('preloads %s, which the CSS also declares', (file) => {
        expect(index).toContain(`href="./${file}" as="font" type="font/woff2" crossorigin`);
        expect(cssUrls).toContain(file);
    });

    it('ships each declared file as a real woff2', () => {
        for (const url of cssUrls) {
            const path = resolve(root, url);
            expect(existsSync(path), `${url} is missing`).toBe(true);
            expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('wOF2');
        }
    });

    it('carries the licence the fonts are distributed under', () => {
        expect(read('fonts/LICENSE.txt')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    });

    it('reaches no font CDN from anywhere that ships', () => {
        for (const source of [index, vercel, css, read('sw.js')]) {
            expect(source).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
        }
    });

    it('keeps the two copies of the CSP agreeing on where styles and fonts come from', () => {
        const page = cspOf(index);
        const headers = cspOf(vercel);
        expect(page['font-src']).toBe("'self'");
        expect(page['style-src']).toBe("'self' 'unsafe-inline'");
        expect(headers['font-src']).toBe(page['font-src']);
        expect(headers['style-src']).toBe(page['style-src']);
    });

    it('is copied into the Pages artifact by the deploy workflow', () => {
        expect(workflow).toMatch(/^\s*cp -r .*\bfonts\b.* _site\/$/m);
    });
});
