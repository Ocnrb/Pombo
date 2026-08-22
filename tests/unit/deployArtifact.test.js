import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = fs.readFileSync(
    path.join(ROOT, '.github/workflows/deploy-pages.yml'), 'utf8');

// The Pages artifact is assembled from an explicit copy list, so a root file
// that is not named there is committed but never served.
const ROOT_FILES_SERVED = ['index.html', 'sw.js', 'CNAME', 'robots.txt', 'sitemap.xml'];

const copiedNames = WORKFLOW.split('\n')
    .filter(line => line.trim().startsWith('cp '))
    .flatMap(line => line.trim().split(/\s+/));

describe('Pages artifact', () => {
    it.each(ROOT_FILES_SERVED)('ships %s', (file) => {
        expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
        expect(copiedNames).toContain(file);
    });

    it('points robots.txt at the sitemap on the canonical host', () => {
        const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
        const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
        const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

        expect(robots).toContain('Sitemap: https://app.pombo.cc/sitemap.xml');
        expect(sitemap).toContain('<loc>https://app.pombo.cc/</loc>');
        expect(index).toContain('<link rel="canonical" href="https://app.pombo.cc/">');
    });
});
