// Capture #install hash BEFORE app router overwrites it
(function() {
    window.__pomboShowInstall = false;
    if (window.location.hash === '#install') {
        window.__pomboShowInstall = true;
        // Strip the hash so the app router doesn't see it and redirect to #/explore
        history.replaceState(null, '', window.location.pathname);
    }
    // Capture beforeinstallprompt early
    window.__pomboDeferredPrompt = null;
    window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        window.__pomboDeferredPrompt = e;
    });
})();
