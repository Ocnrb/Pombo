/**
 * Pill dropdown positioning.
 *
 * The dropdowns are absolutely positioned inside their pill-nav wrapper; a
 * static CSS offset lets narrow viewports push the card past the screen
 * edge. Mirrors the Android PillMenuAnchor maths: centre the card on the
 * owning icon, clamp it to a screen margin, and keep the scale origin on
 * the caret so the menu still grows out of its icon when the card is
 * clamped. The caret itself is anchored to the wrapper, so it keeps
 * pointing at the icon regardless of where the card ends up.
 */
export function positionPillDropdown(dropdown) {
    const wrapper = dropdown.parentElement;
    if (!wrapper) return;
    const margin = 8;
    const wrapperRect = wrapper.getBoundingClientRect();
    const anchorX = wrapperRect.left + wrapperRect.width / 2;
    // The hidden state keeps display:block (for the close transition), so
    // the card is measurable before it opens.
    const width = dropdown.offsetWidth;
    const viewportW = document.documentElement.clientWidth;
    const left = Math.max(margin, Math.min(anchorX - width / 2, viewportW - width - margin));
    dropdown.style.left = `${left - wrapperRect.left}px`;
    dropdown.style.right = 'auto';
    dropdown.style.transformOrigin = `${anchorX - left}px bottom`;
}
