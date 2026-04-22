// Install modal logic (triggered by #install hash from landing page).
// Renders reactively based on the install state exposed by install-pre.js,
// so a late `beforeinstallprompt` transparently upgrades the UI from the
// manual "desktop instructions" fallback to the native Install button.
(function () {
    // Max time to wait for `beforeinstallprompt` on Chromium-like browsers
    // before giving up and showing manual desktop instructions.
    var WAIT_FOR_PROMPT_MS = 2500;

    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    function getState() {
        return window.__pomboInstall || { deferredPrompt: null, installed: false, supportsPrompt: false };
    }

    var modalOpen = false;
    var waitTimer = null;

    function sections() {
        return {
            modal: document.getElementById('install-app-modal'),
            nativeBtn: document.getElementById('install-native-btn'),
            waiting: document.getElementById('install-waiting'),
            ios: document.getElementById('install-ios'),
            desktop: document.getElementById('install-desktop'),
            done: document.getElementById('install-done'),
        };
    }

    function render() {
        var s = sections();
        if (!s.modal) return;

        // Reset all
        s.nativeBtn && s.nativeBtn.classList.add('hidden');
        s.waiting && s.waiting.classList.add('hidden');
        s.ios && s.ios.classList.add('hidden');
        s.desktop && s.desktop.classList.add('hidden');
        s.done && s.done.classList.add('hidden');

        var st = getState();

        if (isStandalone() || st.installed) {
            s.done && s.done.classList.remove('hidden');
            clearWait();
            return;
        }

        if (st.deferredPrompt) {
            s.nativeBtn && s.nativeBtn.classList.remove('hidden');
            clearWait();
            return;
        }

        if (isIOS()) {
            s.ios && s.ios.classList.remove('hidden');
            clearWait();
            return;
        }

        // Chromium-family browser that supports installation but hasn't
        // fired `beforeinstallprompt` yet (SW still activating, etc.).
        // Show a brief "preparing" state and wait for the event.
        if (st.supportsPrompt && waitTimer !== null) {
            s.waiting && s.waiting.classList.remove('hidden');
            return;
        }

        // Non-Chromium or timed out → manual desktop instructions.
        s.desktop && s.desktop.classList.remove('hidden');
    }

    function clearWait() {
        if (waitTimer !== null) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }
    }

    function startWaitIfNeeded() {
        var st = getState();
        // Only wait if Chromium-like, no prompt yet, not standalone, not iOS.
        if (st.supportsPrompt && !st.deferredPrompt && !st.installed && !isStandalone() && !isIOS()) {
            clearWait();
            waitTimer = setTimeout(function () {
                waitTimer = null;
                if (modalOpen) render();
            }, WAIT_FOR_PROMPT_MS);
        }
    }

    function showInstallModal() {
        var s = sections();
        if (!s.modal) return;
        modalOpen = true;
        startWaitIfNeeded();
        render();
        s.modal.classList.remove('hidden');
    }

    function hideInstallModal() {
        var s = sections();
        if (s.modal) s.modal.classList.add('hidden');
        modalOpen = false;
        clearWait();
    }

    // React to install-state changes while modal is open
    window.addEventListener('pombo:installable', function () {
        if (modalOpen) render();
    });
    window.addEventListener('pombo:installed', function () {
        if (modalOpen) render();
    });

    // Close button
    document.getElementById('install-modal-close')?.addEventListener('click', hideInstallModal);

    // Backdrop click
    document.getElementById('install-app-modal')?.addEventListener('click', function (e) {
        if (e.target === this) hideInstallModal();
    });

    // Native install button
    document.getElementById('install-native-btn')?.addEventListener('click', async function () {
        var prompt = getState().deferredPrompt;
        if (!prompt) return;
        prompt.prompt();
        var result = await prompt.userChoice;
        window.__pomboInstall.deferredPrompt = null;
        if (result.outcome === 'accepted') {
            hideInstallModal();
        } else {
            render();
        }
    });

    // Also support arriving at #install via hashchange (e.g. user navigates directly)
    window.addEventListener('hashchange', function () {
        if (window.location.hash === '#install') {
            history.replaceState(null, '', window.location.pathname);
            showInstallModal();
        }
    });

    // If we captured #install on initial load, show modal after app is ready
    if (window.__pomboShowInstall) {
        var pollCount = 0;
        var pollInterval = setInterval(function () {
            pollCount++;
            var overlay = document.getElementById('loading-overlay');
            var overlayGone = !overlay || !overlay.classList.contains('active');
            // Show modal once loading is done, or after 6 seconds max
            if (overlayGone || pollCount > 30) {
                clearInterval(pollInterval);
                showInstallModal();
            }
        }, 200);
    }

    // Expose a safe refresh hook for external callers / debugging
    window.__pomboRefreshInstallModal = function () {
        if (modalOpen) render();
    };
})();
