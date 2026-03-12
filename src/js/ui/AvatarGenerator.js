/**
 * Avatar Generator
 * Generates deterministic SVG avatars based on Ethereum addresses
 * Procedural polygon generation 
 */

// Dark background colors (expanded palette)
const BACKGROUND_COLORS = [
    // Azuis Profundos & Slate Blues
    '#12182B', '#151C33', '#1D1F2E', '#181536', '#141A2F', '#101726', '#171C2B',
    '#1A2847', '#1E3055', '#1B2A4A', '#182845', '#1F3358',
    // Indigo & Violets
    '#19142A', '#1C1633', '#1A1230', '#201238', '#23113A',
    '#231845', '#28204F', '#261C4A', '#2A2255', '#2D2560',
    // Purples & Magentas
    '#1D122B', '#211529', '#241024', '#291425', '#2A1028',
    '#2E1850', '#321C58', '#2F1A52', '#351F5E', '#382262',
    '#3A1845', '#3E1C4A', '#3C1A48', '#421F50', '#452252',
    // Reds & Wines
    '#2B1212', '#2E151A', '#2E1622', '#261518', '#2A1416', '#241012',
    '#3D1830', '#421C35', '#401A32', '#461F38', '#4A223C',
    '#3A1820', '#3E1C24', '#3C1A22', '#421F28', '#45222C',
    // Deep Dark Greens/Teals
    '#0F1F1A', '#0E1B17', '#0C1A16', '#0F201C', '#101C18',
    '#152D35', '#183540', '#1A3842', '#173038', '#1C3A45',
    // Cool Neutrals
    '#1A1C23', '#181B22', '#161A20'
];

// Vibrant shape colors (expanded palette, no orange/amber)
const SHAPE_COLORS = [
    // Azuis Profundos & Slate Blues
    '#3B6BE3', '#4A81D9', '#5C7CFA', '#5D5FE3', '#4C6EDB', '#4462C9', '#6A7FDB',
    '#3A5CAA', '#5B8DD9', '#4F7AC4',
    // Indigo & Violets
    '#6C5DD3', '#7A6CE0', '#5F55B5', '#7B4FE0', '#8A4BD6', '#5A4DB8', '#9066E8',
    // Purples & Magentas
    '#8E46E6', '#8952D9', '#B33DB3', '#C44994', '#A93FA0', '#9B3DC4', '#D44EC0', '#A855D9',
    // Pinks & Roses
    '#E85A8F', '#D4557A', '#E86B9A', '#CC4F88', '#B84D70', '#F07AA8',
    // Reds & Wines
    '#D93838', '#D94160', '#C93C75', '#C44B5A', '#B5424D', '#A63A44', '#E04545', '#9A3535',
    // Deep Greens/Teals
    '#1F8A70', '#1C7C68', '#207561', '#2C8C6A', '#3A7F66',
    '#38A5B8', '#2E99A8', '#4AB4C4', '#3D8FA0', '#5CC4D4', '#2A8899', '#47A8B8',
    // Cool Neutrals
    '#7382A6', '#6F7C99', '#5F6B85', '#8894B0', '#5A6270', '#9AA4BA', '#7A8495'
];

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
 * Simple seeded PRNG (mulberry32)
 * Creates deterministic pseudo-random numbers from a seed
 */
function createRng(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Generate a procedural polygon path
 * @param {function} rng - Seeded random number generator
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @param {number} radius - Base radius
 * @param {number} numVertices - Number of vertices (3-8)
 * @param {number} irregularity - Angular variation (0-0.3)
 * @param {number} spikiness - Radius variation (0-0.5)
 * @returns {string} - SVG path string
 */
function generatePolygonPath(rng, cx, cy, radius, numVertices, irregularity, spikiness) {
    const points = [];
    const angleStep = (Math.PI * 2) / numVertices;
    
    for (let i = 0; i < numVertices; i++) {
        // Base angle with irregularity
        const baseAngle = angleStep * i - Math.PI / 2; // Start from top
        const angleOffset = (rng() - 0.5) * 2 * irregularity * angleStep;
        const angle = baseAngle + angleOffset;
        
        // Radius with spikiness variation
        const radiusOffset = 1 + (rng() - 0.5) * 2 * spikiness;
        const r = radius * radiusOffset;
        
        // Calculate point
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        points.push({ x, y });
    }
    
    // Build path
    const pathParts = points.map((p, i) => 
        (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)
    );
    pathParts.push('Z');
    
    return pathParts.join(' ');
}

/**
 * Generate a procedural polygon with optional inner hole
 * @param {function} rng - Seeded random number generator
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @param {number} size - Canvas size
 * @returns {object} - { path, hasHoles }
 */
function generateProceduralShape(rng, cx, cy, size) {
    // Margin from edge (5% on each side = 90% usable area)
    const margin = size * 0.05;
    const usableRadius = (size / 2) - margin;
    const baseRadius = usableRadius * 0.9; // Base radius with small safety margin
    
    // === POLYGON A (central, large) ===
    const numVerticesA = 3 + Math.floor(rng() * 4); // 3-6 vertices
    const irregularityA = 0.1 + rng() * 0.25; // 10-35% irregularity
    const spikinessA = 0.1 + rng() * 0.25; // 10-35% spikiness
    const scaleA = 0.75 + rng() * 0.20; // 75-95%
    const radiusA = baseRadius * scaleA;
    
    // Minimal offset from center to keep centered
    const offsetAx = (rng() - 0.5) * size * 0.02;
    const offsetAy = (rng() - 0.5) * size * 0.02;
    const cxA = cx + offsetAx;
    const cyA = cy + offsetAy;
    
    const pathA = generatePolygonPath(rng, cxA, cyA, radiusA, numVerticesA, irregularityA, spikinessA);
    
    // === POLYGON B (overlapping, different size) ===
    const numVerticesB = 3 + Math.floor(rng() * 4); // 3-6 vertices
    const irregularityB = 0.1 + rng() * 0.25;
    const spikinessB = 0.1 + rng() * 0.25;
    const scaleB = 0.50 + rng() * 0.35; // 50-85% (bigger range)
    const radiusB = baseRadius * scaleB;
    
    // Position B with visible offset - shapes should be distinguishable
    const overlapFactor = 0.38 + rng() * 0.32; // 38-70% distance
    const maxDistance = usableRadius - radiusB; // Ensure B stays within bounds
    const distanceAB = Math.min((radiusA + radiusB) * overlapFactor, maxDistance * 0.7);
    const angleAB = rng() * Math.PI * 2; // Random direction
    
    const cxB = cxA + Math.cos(angleAB) * distanceAB;
    const cyB = cyA + Math.sin(angleAB) * distanceAB;
    
    const pathB = generatePolygonPath(rng, cxB, cyB, radiusB, numVerticesB, irregularityB, spikinessB);
    
    // === HOLES (1-2, as separate shapes with background color) ===
    const numHoles = rng() < 0.5 ? 1 : 2; // 50% one hole, 50% two holes
    
    // Calculate composition center (weighted average of both polygon centers)
    const compositeCx = (cxA + cxB) / 2;
    const compositeCy = (cyA + cyB) / 2;
    const compositeRadius = Math.max(radiusA, radiusB) * 0.6;
    
    // Hole properties - same for all holes
    const holeVertices = 3 + Math.floor(rng() * 3); // 3-5 vertices
    const holeIrregularity = 0.1 + rng() * 0.2;
    const holeSpikiness = 0.1 + rng() * 0.2;
    const holeSizeBase = numHoles === 1 ? 0.90 : 0.60;
    const holeScale = holeSizeBase + rng() * 0.10;
    const holeRadius = compositeRadius * holeScale;
    
    let holesPath = '';
    
    // Pre-calculate hole positions to avoid overlap
    const holePositions = [];
    if (numHoles === 1) {
        // Single hole: can be anywhere in composition
        holePositions.push({
            x: compositeCx + (rng() - 0.5) * compositeRadius * 0.8,
            y: compositeCy + (rng() - 0.5) * compositeRadius * 0.8
        });
    } else {
        // Two holes: place on opposite sides to avoid overlap
        const baseAngle = rng() * Math.PI * 2;
        const minSeparation = holeRadius * 2.2; // Minimum distance between hole centers
        const holeDistance = Math.max(minSeparation, compositeRadius * 0.5);
        
        // First hole
        holePositions.push({
            x: compositeCx + Math.cos(baseAngle) * holeDistance * 0.5,
            y: compositeCy + Math.sin(baseAngle) * holeDistance * 0.5
        });
        // Second hole - opposite side
        holePositions.push({
            x: compositeCx + Math.cos(baseAngle + Math.PI) * holeDistance * 0.5,
            y: compositeCy + Math.sin(baseAngle + Math.PI) * holeDistance * 0.5
        });
    }
    
    for (let h = 0; h < numHoles; h++) {
        const holePath = generatePolygonPath(
            rng,
            holePositions[h].x,
            holePositions[h].y,
            holeRadius,
            holeVertices,
            holeIrregularity,
            holeSpikiness
        );
        
        holesPath += ' ' + holePath;
    }
    
    // Return polygons and holes separately
    return { 
        path: pathA + ' ' + pathB,
        holesPath: holesPath.trim(),
        hasHoles: numHoles > 0
    };
}

/**
 * Generate a deterministic avatar SVG based on an Ethereum address
 * Uses procedural polygon generation - infinite unique shapes
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
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    
    // Select colors (only 2: background + shape)
    const bgColor = BACKGROUND_COLORS[Math.floor(rng() * BACKGROUND_COLORS.length)];
    const shapeColor = SHAPE_COLORS[Math.floor(rng() * SHAPE_COLORS.length)];
    
    // Center position (fixed, no offset to keep composition centered)
    const cx = size / 2;
    const cy = size / 2;
    
    // Generate the procedural shape (2 polygons + optional holes)
    const { path, holesPath, hasHoles } = generateProceduralShape(rng, cx, cy, size);
    
    // Rotation
    const rotation = Math.floor(rng() * 360);
    
    // Calculate border radius in pixels
    const rx = size * borderRadius;
    
    // Build SVG - holes drawn with background color to "subtract"
    const holesElement = hasHoles ? `<path d="${holesPath}" fill="${bgColor}"/>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <rect width="${size}" height="${size}" rx="${rx}" fill="${bgColor}"/>
        <g transform="rotate(${rotation} ${cx} ${cy})">
            <path d="${path}" fill="${shapeColor}"/>
            ${holesElement}
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
        return SHAPE_COLORS[0]; // Default shape color
    }
    const normalizedAddress = address.toLowerCase();
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    // Skip background selection, get shape color
    rng(); // background
    const colorIndex = Math.floor(rng() * SHAPE_COLORS.length);
    return SHAPE_COLORS[colorIndex];
}

// Export singleton-style access
export const avatarGenerator = {
    generate: generateAvatar,
    generateDataUri: generateAvatarDataUri,
    get: getAvatar,
    clearCache: clearAvatarCache,
    getColor: getAddressColor,
};
