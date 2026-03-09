/**
 * Modal Builder Utilities
 * Template-based modal system for building modal UIs
 */

// ============================================
// TEMPLATE HELPERS
// ============================================

/**
 * Load and clone a template from the DOM
 * @param {string} templateId - ID of the template element (without #)
 * @returns {DocumentFragment} - Cloned template content
 * @throws {Error} - If template not found
 */
function loadTemplate(templateId) {
    const template = document.getElementById(templateId);
    if (!template) {
        throw new Error(`Template not found: ${templateId}`);
    }
    return template.content.cloneNode(true);
}

/**
 * Bind data to elements with data-bind attributes
 * Supports: textContent, value, innerHTML (with data-bind-html)
 * 
 * @param {Element|DocumentFragment} container - Container with data-bind elements
 * @param {Object} data - Key-value pairs to bind
 * @returns {Element|DocumentFragment} - Same container for chaining
 * 
 * @example
 * // HTML: <span data-bind="username"></span>
 * // JS: bindData(modal, { username: 'John' })
 */
export function bindData(container, data) {
    for (const [key, value] of Object.entries(data)) {
        // Find elements with data-bind="key"
        const elements = container.querySelectorAll(`[data-bind="${key}"]`);
        elements.forEach(el => {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = value ?? '';
            } else {
                el.textContent = value ?? '';
            }
        });
        
        // Find elements with data-bind-html="key" (use with caution - XSS risk)
        const htmlElements = container.querySelectorAll(`[data-bind-html="${key}"]`);
        htmlElements.forEach(el => {
            el.innerHTML = value ?? '';
        });
        
        // Find elements with data-bind-attr for attribute binding
        // Format: data-bind-attr="attrName:dataKey"
        const attrElements = container.querySelectorAll(`[data-bind-attr*="${key}"]`);
        attrElements.forEach(el => {
            const bindings = el.getAttribute('data-bind-attr').split(',');
            bindings.forEach(binding => {
                const [attr, dataKey] = binding.trim().split(':');
                if (dataKey === key) {
                    el.setAttribute(attr, value ?? '');
                }
            });
        });
    }
    return container;
}

/**
 * Create a modal from template, bind data, and append to body
 * @param {string} templateId - Template ID
 * @param {Object} data - Data to bind
 * @returns {HTMLElement} - The modal container element
 */
export function createModalFromTemplate(templateId, data = {}) {
    const fragment = loadTemplate(templateId);
    bindData(fragment, data);
    
    // Get the root element (first element child of fragment)
    const modal = fragment.firstElementChild;
    document.body.appendChild(fragment);
    
    return modal;
}

/**
 * Close and remove modal from DOM
 * @param {HTMLElement} modal - Modal element to close
 * @param {Function} callback - Optional callback after removal
 */
export function closeModal(modal, callback = null) {
    if (!modal) return;
    
    // Optional fade out animation
    modal.classList.add('opacity-0');
    modal.style.transition = 'opacity 150ms ease-out';
    
    setTimeout(() => {
        if (modal.parentNode) {
            modal.parentNode.removeChild(modal);
        }
        if (callback) callback();
    }, 150);
}

/**
 * Setup standard modal close handlers (close button, backdrop click, Escape key)
 * @param {HTMLElement} modal - Modal element
 * @param {Function} onClose - Callback when modal is closed
 * @param {Object} options - Options { closeOnBackdrop: true, closeOnEscape: true }
 */
export function setupModalCloseHandlers(modal, onClose, options = {}) {
    const { closeOnBackdrop = true, closeOnEscape = true } = options;
    
    // Close button
    const closeBtn = modal.querySelector('[data-close-modal]');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeModal(modal, onClose);
        });
    }
    
    // Backdrop click
    if (closeOnBackdrop) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal, onClose);
            }
        });
    }
    
    // Escape key
    if (closeOnEscape) {
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', escHandler);
                closeModal(modal, onClose);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
}

/**
 * Setup password toggle button
 * @param {HTMLButtonElement} button - Toggle button
 * @param {HTMLInputElement} input - Password input
 */
export function setupPasswordToggle(button, input) {
    button.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
    });
}

/**
 * Helper to query element within modal
 * @param {HTMLElement} modal - Modal element
 * @param {string} selector - CSS selector
 * @returns {HTMLElement|null}
 */
export function $(modal, selector) {
    return modal.querySelector(selector);
}

/**
 * Validate password against standard rules
 * @param {string} password - Password to validate
 * @returns {Object} - { length, upper, lower, number, isValid }
 */
export function validatePasswordRules(password) {
    const result = {
        length: password.length >= 12,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        number: /[0-9]/.test(password)
    };
    result.isValid = result.length && result.upper && result.lower && result.number;
    return result;
}

/**
 * SVG icons for password validation UI
 */
export const PASSWORD_ICONS = {
    check: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    empty: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="1.5"/></svg>`
};

/**
 * Update a password requirement indicator element
 * @param {HTMLElement} element - The indicator element
 * @param {boolean} isValid - Whether the requirement is met
 * @param {string} text - The requirement text
 */
export function updatePasswordIndicator(element, isValid, text) {
    const icon = isValid ? PASSWORD_ICONS.check : PASSWORD_ICONS.empty;
    element.className = `flex items-center gap-2 ${isValid ? 'text-emerald-400' : 'text-white/30'}`;
    element.innerHTML = `${icon} ${text}`;
}
