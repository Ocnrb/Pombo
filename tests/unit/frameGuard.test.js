import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GUARD_SRC = fs.readFileSync(path.join(ROOT, 'js/frame-guard.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const HEAD_METADATA = [
    '<link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg">',
    '<link rel="icon" type="image/png" sizes="96x96" href="/favicon/favicon-96x96.png">',
    '<link rel="shortcut icon" href="/favicon/favicon.ico">',
    '<title>Pombo - Own Your Communications</title>',
    '<link rel="canonical" href="https://app.pombo.cc/">'
];

function runGuard({ framed }) {
    document.documentElement.innerHTML =
        `<head>${HEAD_METADATA.join('')}</head><body><div id="app">app content</div></body>`;

    Object.defineProperty(window, 'top', {
        configurable: true,
        get: () => (framed ? {} : window)
    });
    window.stop = () => {};

    // eslint-disable-next-line no-new-func
    new Function(GUARD_SRC).call(window);
}

describe('frame-guard', () => {
    beforeEach(() => {
        document.documentElement.innerHTML = '';
    });

    it('leaves the document untouched when not framed', () => {
        runGuard({ framed: false });
        expect(document.getElementById('app')).not.toBeNull();
    });

    it('blanks the body when framed', () => {
        runGuard({ framed: true });
        expect(document.getElementById('app')).toBeNull();
        expect(document.body.textContent).toContain('cannot be displayed inside another page');
    });

    it('keeps head metadata in the DOM when framed', () => {
        runGuard({ framed: true });
        expect(document.title).toBe('Pombo - Own Your Communications');
        expect(document.querySelector('link[rel="canonical"]')).not.toBeNull();
        const icons = document.querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]');
        expect(icons.length).toBe(3);
    });

    it('blanks a second body appended by a parser that kept going', () => {
        runGuard({ framed: true });

        const late = document.createElement('body');
        late.innerHTML = '<div id="app">app content</div>';
        document.documentElement.appendChild(late);
        document.dispatchEvent(new Event('DOMContentLoaded'));

        expect(document.documentElement.getElementsByTagName('body').length).toBe(1);
        expect(document.getElementById('app')).toBeNull();
        expect(document.body.textContent).toContain('cannot be displayed inside another page');
    });

    it('declares crawler-facing metadata above the guard in index.html', () => {
        const guardAt = INDEX_HTML.indexOf('<script src="./js/frame-guard.js">');
        expect(guardAt).toBeGreaterThan(-1);

        for (const tag of ['<title>', '<link rel="canonical"', '<link rel="icon"',
                           '<link rel="shortcut icon"', '<meta name="description"',
                           '<meta property="og:image"']) {
            expect(INDEX_HTML.indexOf(tag), tag).toBeGreaterThan(-1);
            expect(INDEX_HTML.indexOf(tag), tag).toBeLessThan(guardAt);
        }
    });
});
