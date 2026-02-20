/**
 * Avatar Generator
 * Generates deterministic SVG avatars based on Ethereum addresses
 * Inspired by Avvvatars - uses geometric shapes with muted color palette
 */

// Muted, darker color palette - pairs of [background, shape]
const COLOR_PAIRS = [
    // --- AZUIS E ÍNDIGOS (Vivos e profundos) ---
    ['#12182B', '#3B6BE3'],  // Royal Blue
    ['#151C33', '#4A81D9'],  // Strong Cerulean
    ['#1D1F2E', '#5C7CFA'],  // Clear Cobalt
    ['#181536', '#5D5FE3'],  // Rich Indigo

    // --- ROXOS E MAGENTAS (Ricos e sofisticados) ---
    ['#1D122B', '#8E46E6'],  // Vibrant Amethyst
    ['#211529', '#8952D9'],  // Royal Purple
    ['#241024', '#B33DB3'],  // Deep Magenta
    ['#291425', '#C44994'],  // Rich Orchid

    // --- VERMELHOS E ROSAS (Quentes e marcantes, sem tocar no laranja) ---
    ['#2B1212', '#D93838'],  // Strong Crimson
    ['#2E151A', '#D94160'],  // Vibrant Ruby
    ['#2E1622', '#C93C75'],  // Deep Berry
    ['#261518', '#C44B5A'],  // Rich Rose

    // --- NEUTROS COM TOQUE DE COR (Para elementos secundários) ---
    ['#1A1C23', '#7382A6'],  // Steel Blue (Mais saturado que o slate anterior)
    ['#1E1A24', '#8E77A6'],  // Vibrant Taupe
    ['#241A1E', '#A66B7C']   // Rich Dusty Rose
];

// Shape generators - complex polygons
const SHAPES = {
    // Arrow pointing right
    arrow: (cx, cy, size) => {
        const s = size * 0.35;
        return `M${cx - s},${cy - s * 0.6} L${cx + s * 0.4},${cy} L${cx - s},${cy + s * 0.6} L${cx - s * 0.5},${cy} Z`;
    },
    
    // Diamond/rhombus
    diamond: (cx, cy, size) => {
        const s = size * 0.38;
        return `M${cx},${cy - s} L${cx + s},${cy} L${cx},${cy + s} L${cx - s},${cy} Z`;
    },
    
    // Triangle pointing up
    triangleUp: (cx, cy, size) => {
        const s = size * 0.4;
        return `M${cx},${cy - s} L${cx + s * 0.9},${cy + s * 0.7} L${cx - s * 0.9},${cy + s * 0.7} Z`;
    },
    
    // Triangle pointing down
    triangleDown: (cx, cy, size) => {
        const s = size * 0.4;
        return `M${cx},${cy + s} L${cx + s * 0.9},${cy - s * 0.7} L${cx - s * 0.9},${cy - s * 0.7} Z`;
    },
    
    // Hexagon
    hexagon: (cx, cy, size) => {
        const s = size * 0.35;
        const points = [];
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 3) * i - Math.PI / 6;
            points.push(`${cx + s * Math.cos(angle)},${cy + s * Math.sin(angle)}`);
        }
        return `M${points.join(' L')} Z`;
    },
    
    // Pentagon
    pentagon: (cx, cy, size) => {
        const s = size * 0.35;
        const points = [];
        for (let i = 0; i < 5; i++) {
            const angle = (Math.PI * 2 / 5) * i - Math.PI / 2;
            points.push(`${cx + s * Math.cos(angle)},${cy + s * Math.sin(angle)}`);
        }
        return `M${points.join(' L')} Z`;
    },
    
    // Star (4 points)
    star4: (cx, cy, size) => {
        const outer = size * 0.38;
        const inner = size * 0.15;
        const points = [];
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI / 4) * i - Math.PI / 2;
            const r = i % 2 === 0 ? outer : inner;
            points.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
        }
        return `M${points.join(' L')} Z`;
    },
    
    // Chevron pointing right
    chevronRight: (cx, cy, size) => {
        const s = size * 0.3;
        const w = size * 0.15;
        return `M${cx - s},${cy - s} L${cx + s * 0.3},${cy} L${cx - s},${cy + s} L${cx - s + w},${cy + s} L${cx + s * 0.3 + w},${cy} L${cx - s + w},${cy - s} Z`;
    },
    
    // Chevron pointing left
    chevronLeft: (cx, cy, size) => {
        const s = size * 0.3;
        const w = size * 0.15;
        return `M${cx + s},${cy - s} L${cx - s * 0.3},${cy} L${cx + s},${cy + s} L${cx + s - w},${cy + s} L${cx - s * 0.3 - w},${cy} L${cx + s - w},${cy - s} Z`;
    },
    
    // Parallelogram
    parallelogram: (cx, cy, size) => {
        const s = size * 0.35;
        const skew = size * 0.12;
        return `M${cx - s + skew},${cy - s * 0.6} L${cx + s + skew},${cy - s * 0.6} L${cx + s - skew},${cy + s * 0.6} L${cx - s - skew},${cy + s * 0.6} Z`;
    },
    
    // Cross/Plus
    cross: (cx, cy, size) => {
        const s = size * 0.35;
        const w = size * 0.12;
        return `M${cx - w},${cy - s} L${cx + w},${cy - s} L${cx + w},${cy - w} L${cx + s},${cy - w} L${cx + s},${cy + w} L${cx + w},${cy + w} L${cx + w},${cy + s} L${cx - w},${cy + s} L${cx - w},${cy + w} L${cx - s},${cy + w} L${cx - s},${cy - w} L${cx - w},${cy - w} Z`;
    },
    
    // Octagon
    octagon: (cx, cy, size) => {
        const s = size * 0.35;
        const points = [];
        for (let i = 0; i < 8; i++) {
            const angle = (Math.PI / 4) * i;
            points.push(`${cx + s * Math.cos(angle)},${cy + s * Math.sin(angle)}`);
        }
        return `M${points.join(' L')} Z`;
    },
    
    // House shape
    house: (cx, cy, size) => {
        const s = size * 0.32;
        return `M${cx},${cy - s} L${cx + s},${cy - s * 0.2} L${cx + s},${cy + s} L${cx - s},${cy + s} L${cx - s},${cy - s * 0.2} Z`;
    },
    
    // Shield
    shield: (cx, cy, size) => {
        const s = size * 0.35;
        return `M${cx},${cy - s} L${cx + s},${cy - s * 0.5} L${cx + s * 0.8},${cy + s * 0.3} L${cx},${cy + s} L${cx - s * 0.8},${cy + s * 0.3} L${cx - s},${cy - s * 0.5} Z`;
    },
    
    // Trapezoid
    trapezoid: (cx, cy, size) => {
        const s = size * 0.38;
        return `M${cx - s * 0.6},${cy - s * 0.5} L${cx + s * 0.6},${cy - s * 0.5} L${cx + s},${cy + s * 0.5} L${cx - s},${cy + s * 0.5} Z`;
    },
    
    // Kite
    kite: (cx, cy, size) => {
        const s = size * 0.38;
        return `M${cx},${cy - s} L${cx + s * 0.5},${cy - s * 0.1} L${cx},${cy + s} L${cx - s * 0.5},${cy - s * 0.1} Z`;
    },
};

const SHAPE_NAMES = Object.keys(SHAPES);

/**
 * Hash a string to a number
 * @param {string} str - String to hash
 * @returns {number} - Hash value
 */
function hashString(str) {
    let hash = 0;
    if (!str) return hash;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Generate a deterministic avatar SVG based on an Ethereum address
 * @param {string} address - Ethereum address (0x...)
 * @param {number} size - Avatar size in pixels
 * @param {number} borderRadius - Border radius (0-1, percentage of size)
 * @returns {string} - SVG string
 */
export function generateAvatar(address, size = 32, borderRadius = 0.2) {
    if (!address || typeof address !== 'string') {
        address = '0x0000000000000000000000000000000000000000';
    }
    
    const normalizedAddress = address.toLowerCase();
    const hash1 = hashString(normalizedAddress);
    const hash2 = hashString(normalizedAddress.split('').reverse().join(''));
    
    // Select colors based on hash
    const colorIndex = hash1 % COLOR_PAIRS.length;
    const [bgColor, shapeColor] = COLOR_PAIRS[colorIndex];
    
    // Select shape based on different part of hash
    const shapeIndex = hash2 % SHAPE_NAMES.length;
    const shapeName = SHAPE_NAMES[shapeIndex];
    const shapeGenerator = SHAPES[shapeName];
    
    // Calculate shape position with slight variation
    const offsetX = ((hash1 % 10) - 5) * (size * 0.01);
    const offsetY = ((hash2 % 10) - 5) * (size * 0.01);
    const cx = size / 2 + offsetX;
    const cy = size / 2 + offsetY;
    
    // Calculate rotation based on hash
    const rotation = (hash1 % 8) * 45;
    
    // Generate shape path
    const shapePath = shapeGenerator(cx, cy, size);
    
    // Calculate border radius in pixels
    const rx = size * borderRadius;
    
    // Build SVG
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <rect width="${size}" height="${size}" rx="${rx}" fill="${bgColor}"/>
        <g transform="rotate(${rotation} ${cx} ${cy})">
            <path d="${shapePath}" fill="${shapeColor}"/>
        </g>
    </svg>`;
    
    return svg;
}

/**
 * Generate avatar as a data URI for use in img src
 * @param {string} address - Ethereum address
 * @param {number} size - Avatar size
 * @param {number} borderRadius - Border radius (0-1)
 * @returns {string} - Data URI
 */
export function generateAvatarDataUri(address, size = 32, borderRadius = 0.2) {
    const svg = generateAvatar(address, size, borderRadius);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Avatar cache for performance
 */
const avatarCache = new Map();
const MAX_CACHE_SIZE = 200;

/**
 * Get cached avatar or generate new one
 * @param {string} address - Ethereum address
 * @param {number} size - Avatar size
 * @param {number} borderRadius - Border radius
 * @returns {string} - SVG string
 */
export function getAvatar(address, size = 32, borderRadius = 0.2) {
    const key = `${address?.toLowerCase()}-${size}-${borderRadius}`;
    
    if (avatarCache.has(key)) {
        return avatarCache.get(key);
    }
    
    const svg = generateAvatar(address, size, borderRadius);
    
    // Manage cache size
    if (avatarCache.size >= MAX_CACHE_SIZE) {
        const firstKey = avatarCache.keys().next().value;
        avatarCache.delete(firstKey);
    }
    
    avatarCache.set(key, svg);
    return svg;
}

/**
 * Clear avatar cache
 */
export function clearAvatarCache() {
    avatarCache.clear();
}

/**
 * Get the color associated with an address (matches avatar shape color)
 * Use this for username colors to maintain consistency with avatars
 * @param {string} address - Ethereum address (0x...)
 * @returns {string} - Hex color code
 */
export function getAddressColor(address) {
    if (!address || typeof address !== 'string') {
        return COLOR_PAIRS[0][1]; // Default shape color
    }
    const normalizedAddress = address.toLowerCase();
    const hash = hashString(normalizedAddress);
    const colorIndex = hash % COLOR_PAIRS.length;
    return COLOR_PAIRS[colorIndex][1]; // Return shape color
}

// Export singleton-style access
export const avatarGenerator = {
    generate: generateAvatar,
    generateDataUri: generateAvatarDataUri,
    get: getAvatar,
    clearCache: clearAvatarCache,
    getColor: getAddressColor,
};
