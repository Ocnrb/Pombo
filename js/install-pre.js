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
        // True when we've observed the PWA being installed (either via our
        // appinstalled event on a previous visit, persisted in localStorage,
        // or confirmed via navigator.getInstalledRelatedApps()).
        installed: (function () {
            try { return localStorage.getItem('pombo:installed') === '1'; } catch (_) { return false; }
        })(),
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
        try { localStorage.setItem('pombo:installed', '1'); } catch (_) { /* noop */ }
        emit('pombo:installed');
    });

    // Async best-effort detection: Chromium exposes
    // navigator.getInstalledRelatedApps() which — combined with the
    // `related_applications` entry in the manifest — tells us whether the PWA
    // is already installed on this device, even when running in a browser tab.
    if (navigator.getInstalledRelatedApps) {
        navigator.getInstalledRelatedApps().then(function (apps) {
            if (apps && apps.length > 0) {
                window.__pomboInstall.installed = true;
                try { localStorage.setItem('pombo:installed', '1'); } catch (_) { /* noop */ }
                emit('pombo:installed');
            }
        }).catch(function () { /* noop */ });
    }
})();
