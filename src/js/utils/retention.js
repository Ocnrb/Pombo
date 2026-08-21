/**
 * Message retention slider — the native <input type="range"> stays 1-365
 * days so its physical position stays proportional to a year (dragging to
 * the middle lands near 6 months). Above the 30-day mark, the effective
 * value is magnet-snapped to the nearest exact month so the label never
 * shows an ambiguous in-between day count.
 *
 * Mirrors Android's retentionLabel/snapRetentionDays in Screens.kt.
 */
export function snapRetentionDays(days) {
    days = parseInt(days, 10);
    if (days <= 30) return days;
    if (days >= 365) return 365;
    return Math.round(days / 30) * 30;
}

export function retentionLabel(days) {
    if (days === 1) return '1 day';
    if (days < 30) return `${days} days`;
    if (days < 365) {
        const months = Math.round(days / 30);
        return months === 1 ? '1 month' : `${months} months`;
    }
    return '1 year';
}
