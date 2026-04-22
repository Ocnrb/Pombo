// Capture #install hash BEFORE app router overwrites it, and expose
// install state as observable events so the modal can render reactively.
(function () {
    window.__pomboShowInstall = false;
    if (window.location.hash === '#install') {
        window.__pomboShowInstall = true;
        // Strip the hash so the app router doesn't see it and redirect to #/explore
        history.replaceState(null, '', window.location.pathname);
    }

    // Install state (single source of truth)
    window.__pomboInstall = {
        deferredPrompt: null,
        installed: false,
        // Chromium-based browsers expose this interface; used to decide whether
        // it's worth waiting for `beforeinstallprompt` before falling back to
        // manual desktop instructions.
        supportsPrompt: 'BeforeInstallPromptEvent' in window,
    };

    // Back-compat alias (other code paths read this directly)
    Object.defineProperty(window, '__pomboDeferredPrompt', {
        configurable: true,
        get: function () { return window.__pomboInstall.deferredPrompt; },
        set: function (v) { window.__pomboInstall.deferredPrompt = v; },
    });

    function emit(type) {
        try { window.dispatchEvent(new CustomEvent(type)); } catch (_) { /* noop */ }
    }

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        window.__pomboInstall.deferredPrompt = e;
        emit('pombo:installable');
    });

    window.addEventListener('appinstalled', function () {
        window.__pomboInstall.deferredPrompt = null;
        window.__pomboInstall.installed = true;
        emit('pombo:installed');
    });
})();
