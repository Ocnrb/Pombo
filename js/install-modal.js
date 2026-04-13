// Install modal logic (triggered by #install hash from landing page)
(function() {
    window.addEventListener('appinstalled', function() {
        window.__pomboDeferredPrompt = null;
    });

    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches ||
               window.navigator.standalone === true;
    }

    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    function showInstallModal() {
        var modal = document.getElementById('install-app-modal');
        var nativeBtn = document.getElementById('install-native-btn');
        var iosSection = document.getElementById('install-ios');
        var desktopSection = document.getElementById('install-desktop');
        var doneSection = document.getElementById('install-done');

        if (!modal) return;

        // Reset all
        nativeBtn.classList.add('hidden');
        iosSection.classList.add('hidden');
        desktopSection.classList.add('hidden');
        doneSection.classList.add('hidden');

        if (isStandalone()) {
            doneSection.classList.remove('hidden');
        } else if (window.__pomboDeferredPrompt) {
            nativeBtn.classList.remove('hidden');
        } else if (isIOS()) {
            iosSection.classList.remove('hidden');
        } else {
            desktopSection.classList.remove('hidden');
        }

        modal.classList.remove('hidden');
    }

    function hideInstallModal() {
        var modal = document.getElementById('install-app-modal');
        if (modal) modal.classList.add('hidden');
    }

    // Close button
    document.getElementById('install-modal-close')?.addEventListener('click', hideInstallModal);

    // Backdrop click
    document.getElementById('install-app-modal')?.addEventListener('click', function(e) {
        if (e.target === this) hideInstallModal();
    });

    // Native install button
    document.getElementById('install-native-btn')?.addEventListener('click', async function() {
        if (!window.__pomboDeferredPrompt) return;
        window.__pomboDeferredPrompt.prompt();
        var result = await window.__pomboDeferredPrompt.userChoice;
        window.__pomboDeferredPrompt = null;
        if (result.outcome === 'accepted') {
            hideInstallModal();
        }
    });

    // Also support arriving at #install via hashchange (e.g. user navigates directly)
    window.addEventListener('hashchange', function() {
        if (window.location.hash === '#install') {
            history.replaceState(null, '', window.location.pathname);
            showInstallModal();
        }
    });

    // If we captured #install on initial load, show modal after app is ready
    if (window.__pomboShowInstall) {
        var pollCount = 0;
        var pollInterval = setInterval(function() {
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
})();
