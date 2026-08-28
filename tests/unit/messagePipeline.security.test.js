/**
 * Security regression tests for the message rendering pipeline.
 *
 * The pipeline is: remote text -> escapeHtml -> linkify -> embedYouTubeLinks
 * -> wrapInlineEmojis -> sanitizeMessageHtml -> innerHTML. DOMPurify is the
 * last barrier before a DOM sink, so these tests assert on what survives the
 * whole chain, not on DOMPurify in isolation.
 *
 * jsdom is not Blink: a vector that mutates only under a browser-specific
 * parser quirk cannot be observed here. These tests pin the invariants the
 * renderer relies on, and pin them again after re-serialization, which is
 * where mutation XSS surfaces.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeMessageHtml } from '../../src/js/ui/sanitizer.js';
import { messageRenderer } from '../../src/js/ui/MessageRenderer.js';

const ALLOWED_TAGS = new Set(['A', 'BR', 'SPAN', 'DIV', 'IFRAME']);
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'style', 'formaction', 'xlink:href', 'data', 'action']);
const YOUTUBE_EMBED_PREFIX = 'https://www.youtube-nocookie.com/embed/';
const NUL = String.fromCharCode(0);
const CONTROL_CHARS = new RegExp('[' + NUL + '-' + String.fromCharCode(32) + ']', 'g');

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

/**
 * Assert that a parsed subtree carries nothing that can execute or navigate
 * to a scripting context, and return its serialization for a further round.
 */
function assertInert(html, label) {
    const host = parse(html);
    for (const el of host.querySelectorAll('*')) {
        expect(ALLOWED_TAGS.has(el.tagName), `${label}: tag <${el.tagName.toLowerCase()}> survived`).toBe(true);

        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            expect(name.startsWith('on'), `${label}: attribute ${name} survived`).toBe(false);
            expect(FORBIDDEN_ATTRS.has(name), `${label}: attribute ${name} survived`).toBe(false);
        }

        for (const urlAttr of ['href', 'src']) {
            const raw = el.getAttribute(urlAttr) || '';
            // Browsers drop control characters before resolving the protocol.
            const value = raw.replace(CONTROL_CHARS, '').toLowerCase();
            if (!value) continue;
            expect(value.startsWith('javascript:'), `${label}: ${urlAttr}=${raw}`).toBe(false);
            expect(value.startsWith('vbscript:'), `${label}: ${urlAttr}=${raw}`).toBe(false);
            expect(value.startsWith('data:text/html'), `${label}: ${urlAttr}=${raw}`).toBe(false);
        }

        if (el.tagName === 'IFRAME') {
            const src = el.getAttribute('src') || '';
            expect(src === '' || src.startsWith(YOUTUBE_EMBED_PREFIX), `${label}: iframe src=${src}`).toBe(true);
        }
    }
    return host.innerHTML;
}

/**
 * Sanitize, insert, re-serialize and insert again. Mutation XSS lives in the
 * gap between the string DOMPurify approved and the markup the parser hands
 * back on the next insertion, so both rounds are checked and the shape has to
 * stop changing.
 */
function expectInertThroughReinsertion(dirty, label) {
    const clean = sanitizeMessageHtml(dirty);
    const firstRound = assertInert(clean, `${label} (sanitized)`);
    const secondRound = assertInert(firstRound, `${label} (reinserted)`);
    const thirdRound = assertInert(secondRound, `${label} (reinserted twice)`);
    expect(thirdRound, `${label}: markup never stabilizes across insertions`).toBe(secondRound);
    // A second sanitizer pass must find nothing left to strip.
    expect(assertInert(sanitizeMessageHtml(firstRound), `${label} (resanitized)`)).toBe(firstRound);
    return clean;
}

const MXSS_VECTORS = [
    ['form/math re-contextualization', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>'],
    ['svg style breakout', '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">'],
    ['math table mglyph comment', '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">'],
    ['svg foreignObject srcdoc', '<svg><foreignobject><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></foreignobject></svg>'],
    ['template script', '<template><script>alert(1)</script></template>'],
    ['nested svg style title', '<svg><p><style><g title="</style><img src=x onerror=alert(1)>">'],
    ['annotation-xml encoding switch', '<math><annotation-xml encoding="text/html"><style><img src=x onerror=alert(1)></style></annotation-xml></math>'],
    ['select noembed confusion', '<select><noembed></select><img src=x onerror=alert(1)>'],
];

const RAWTEXT_VECTORS = [
    ['noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
    ['xmp', '<xmp><p title="</xmp><img src=x onerror=alert(1)>">'],
    ['noembed', '<noembed><p title="</noembed><img src=x onerror=alert(1)>">'],
    ['noframes', '<noframes><p title="</noframes><img src=x onerror=alert(1)>">'],
    ['style', '<style><p title="</style><img src=x onerror=alert(1)>">'],
    ['title', '<title><p title="</title><img src=x onerror=alert(1)>">'],
    ['textarea', '<textarea><p title="</textarea><img src=x onerror=alert(1)>">'],
    ['iframe', '<iframe><p title="</iframe><img src=x onerror=alert(1)>">'],
    ['plaintext', '<plaintext><img src=x onerror=alert(1)>'],
    ['comment breakout', '<!--<img src=x onerror=alert(1)>-->'],
];

const MALFORMED_ATTR_VECTORS = [
    ['slash separated handler', '<div/onmouseover=alert(1)>hover</div>'],
    ['unquoted handler after href', '<a href="x" onclick=alert(1)//>text</a>'],
    ['no space before handler', '<span class="a"onmouseover="alert(1)">x</span>'],
    ['quote confusion', '<a"onmouseover=alert(1)">x</a>'],
    ['entity encoded protocol', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['tab inside protocol', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
    ['newline inside protocol', '<a href="java\nscript:alert(1)">x</a>'],
    ['null byte inside protocol', `<a href="java${NUL}script:alert(1)">x</a>`],
    ['uppercase protocol', '<a HREF="JaVaScRiPt:alert(1)">x</a>'],
    ['dangling angle bracket', '<a href="x" <img src=y onerror=alert(1)>>x</a>'],
    ['backtick attribute', '<div class=`a`onmouseover=alert(1)>x</div>'],
];

const IFRAME_VECTORS = [
    ['foreign origin', '<iframe src="https://evil.example/embed/abc"></iframe>'],
    ['prefix lookalike host', '<iframe src="https://www.youtube-nocookie.com.evil.example/embed/abc"></iframe>'],
    ['javascript protocol', '<iframe src="javascript:alert(1)"></iframe>'],
    ['data html', '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'],
    ['srcdoc payload', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
    ['protocol relative', '<iframe src="//evil.example/embed/abc"></iframe>'],
];

// GHSA-h8r8-wccr-v5f2: up to 3.3.1 an allowed attribute could carry a raw
// `</xmp>` style closing sequence, which breaks out again once the sanitized
// string is re-parsed inside a raw-text element.
const RAWTEXT_WRAPPERS = ['script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'];

describe('message pipeline security', () => {
    describe('attribute values cannot carry markup out of the sanitizer', () => {
        for (const wrapper of RAWTEXT_WRAPPERS) {
            it(`strips a </${wrapper}> breakout from an allowed attribute`, () => {
                const payload = `</${wrapper}><img src=x onerror=alert(1)>`;
                for (const dirty of [
                    `<span class="${payload}">x</span>`,
                    `<a href="https://example.com/${payload}">x</a>`,
                ]) {
                    const clean = sanitizeMessageHtml(dirty);
                    expect(clean, `${wrapper}: raw closing tag survived in ${clean}`).not.toContain(`</${wrapper}>`);
                    expect(clean).not.toMatch(/<img/i);

                    // The same string re-parsed inside the raw-text element it
                    // tried to close must still yield nothing executable.
                    const host = parse(`<${wrapper}>${clean}</${wrapper}>`);
                    expect(host.querySelector('img'), `${wrapper}: breakout produced an img`).toBeNull();
                    for (const el of host.querySelectorAll('*')) {
                        for (const attr of Array.from(el.attributes)) {
                            expect(attr.name.toLowerCase().startsWith('on'), `${wrapper}: ${attr.name} survived`).toBe(false);
                        }
                    }
                }
            });
        }
    });

    describe('mutation XSS via re-contextualization', () => {
        for (const [name, vector] of MXSS_VECTORS) {
            it(`stays inert: ${name}`, () => {
                const clean = expectInertThroughReinsertion(vector, name);
                expect(clean).not.toMatch(/onerror|onload|onmouseover/i);
            });
        }
    });

    describe('rawtext and escapable-rawtext breakout', () => {
        for (const [name, vector] of RAWTEXT_VECTORS) {
            it(`stays inert: ${name}`, () => {
                const clean = expectInertThroughReinsertion(vector, name);
                expect(clean).not.toMatch(/<img/i);
            });
        }
    });

    describe('malformed attributes', () => {
        for (const [name, vector] of MALFORMED_ATTR_VECTORS) {
            it(`stays inert: ${name}`, () => {
                expectInertThroughReinsertion(vector, name);
            });
        }
    });

    describe('iframe policy', () => {
        for (const [name, vector] of IFRAME_VECTORS) {
            it(`strips src: ${name}`, () => {
                const clean = expectInertThroughReinsertion(vector, name);
                expect(clean).not.toContain('evil.example');
            });
        }

        it('keeps a youtube-nocookie embed', () => {
            const clean = sanitizeMessageHtml(
                `<iframe src="${YOUTUBE_EMBED_PREFIX}dQw4w9WgXcQ" allowfullscreen loading="lazy"></iframe>`
            );
            const iframe = parse(clean).querySelector('iframe');
            expect(iframe).not.toBeNull();
            expect(iframe.getAttribute('src')).toBe(`${YOUTUBE_EMBED_PREFIX}dQw4w9WgXcQ`);
        });
    });

    describe('full renderer pipeline', () => {
        const render = (text) => messageRenderer.renderMessageContent({ type: 'text', text });
        const ALL_VECTORS = [...MXSS_VECTORS, ...RAWTEXT_VECTORS, ...MALFORMED_ATTR_VECTORS, ...IFRAME_VECTORS];

        for (const [name, vector] of ALL_VECTORS) {
            it(`renders inert message text: ${name}`, () => {
                const html = render(vector);
                const firstRound = assertInert(html, `render ${name}`);
                assertInert(firstRound, `render ${name} (reinserted)`);
                expect(html).not.toMatch(/<(script|img|svg|math|form|style)\b/i);
            });
        }

        it('renders a link without granting it new attributes', () => {
            const html = render('look at https://example.com/path?a=1&b=2');
            const anchor = parse(html).querySelector('a');
            expect(anchor.getAttribute('href')).toBe('https://example.com/path?a=1&b=2');
            expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
            expect(anchor.getAttribute('target')).toBe('_blank');
            assertInert(html, 'plain link');
        });

        it('embeds only the youtube-nocookie player for a youtube link', () => {
            const html = render('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
            const iframe = parse(html).querySelector('iframe');
            expect(iframe.getAttribute('src')).toBe(`${YOUTUBE_EMBED_PREFIX}dQw4w9WgXcQ`);
            assertInert(html, 'youtube embed');
        });

        it('does not let a crafted link text forge markup', () => {
            const html = render('https://example.com/"><img src=x onerror=alert(1)>');
            assertInert(html, 'forged link text');
            expect(html).not.toMatch(/<img/i);
        });
    });
});
