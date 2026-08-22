/**
 * Clickjacking guard. Must stay an external file loaded first in <head>:
 * inline scripts are barred by the CSP, and app.pombo.cc (GitHub Pages)
 * cannot send frame-ancestors/X-Frame-Options response headers, so on that
 * host this script is the only framing defense. It blanks the page instead
 * of navigating top — top navigation is blocked in sandboxed iframes, a
 * blanked document is not.
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
    document.documentElement.innerHTML =
        '<head></head><body style="margin:0;display:flex;align-items:center;' +
        'justify-content:center;min-height:100vh;background:#111;color:#eee;' +
        'font-family:sans-serif;text-align:center;padding:16px">' +
        '<p>Pombo cannot be displayed inside another page.<br>' +
        'Open <a href="https://app.pombo.cc" target="_blank" rel="noopener" ' +
        'style="color:#F6851B">app.pombo.cc</a> directly.</p></body>';
})();
