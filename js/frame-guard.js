/**
 * Clickjacking guard. Must stay an external file loaded in <head>: inline
 * scripts are barred by the CSP, and app.pombo.cc (GitHub Pages) cannot send
 * frame-ancestors/X-Frame-Options response headers, so on that host this
 * script is the only framing defense. It blanks the page instead of
 * navigating top — top navigation is blocked in sandboxed iframes, a blanked
 * document is not.
 *
 * It must blank the <body> only and leave <head> in place, so that document
 * metadata survives for anything that reads the rendered DOM. Metadata that
 * has to survive must also be declared above this script in index.html:
 * window.stop() aborts parsing here, so whatever follows is never parsed.
 */
(function () {
    'use strict';
    var framed;
    try {
        framed = window.top !== window.self;
    } catch (e) {
        framed = true;
    }
    if (!framed) return;

    try { window.stop(); } catch (e) { /* ignore */ }

    var BODY_STYLE = 'margin:0;display:flex;align-items:center;' +
        'justify-content:center;min-height:100vh;background:#111;color:#eee;' +
        'font-family:sans-serif;text-align:center;padding:16px';
    var NOTICE =
        '<p>Pombo cannot be displayed inside another page.<br>' +
        'Open <a href="https://app.pombo.cc" target="_blank" rel="noopener" ' +
        'style="color:#F6851B">app.pombo.cc</a> directly.</p>';

    function blank() {
        var root = document.documentElement;
        if (!document.body) {
            root.appendChild(document.createElement('body'));
        }
        var bodies = root.getElementsByTagName('body');
        while (bodies.length > 1) {
            bodies[bodies.length - 1].parentNode.removeChild(bodies[bodies.length - 1]);
        }
        document.body.setAttribute('style', BODY_STYLE);
        document.body.innerHTML = NOTICE;
    }

    blank();
    // Backstop for an engine that keeps parsing past window.stop().
    document.addEventListener('DOMContentLoaded', blank);
})();
