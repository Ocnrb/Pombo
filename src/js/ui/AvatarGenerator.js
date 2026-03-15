/**
 * Avatar Generator v2
 * Generates deterministic SVG avatars based on Ethereum addresses
 * Procedural polygon generation with face layer (pareidolia)
 * 8 eyes × 9 mouths × 4 expressions = 288 unique face personalities
 */

// ==========================================
// Constants 
// ==========================================

// Polygon A configuration
const POLYGON_A = {
    verticesBase: 3, verticesRange: 5,       // 3-7 vertices
    irregularityBase: 0.15, irregularityRange: 0.30,  // 15-45%
    spikinessBase: 0.20, spikinessRange: 0.30,        // 20-50%
    scaleBase: 0.75, scaleRange: 0.50                 // 75-125%
};

// Polygon B configuration
const POLYGON_B = {
    verticesBase: 3, verticesRange: 5,       // 3-7 vertices
    irregularityBase: 0.15, irregularityRange: 0.30,  // 15-45%
    spikinessBase: 0.20, spikinessRange: 0.30,        // 20-50%
    scaleBase: 0.63, scaleRange: 0.50,                // 63-113%
    overlapBase: 0.30, overlapRange: 0.50             // 30-80%
};

// Holes configuration
const HOLES = {
    min: 2, max: 4,                          // 2-4 holes
    verticesBase: 3, verticesRange: 4,       // 3-6 vertices
    irregularityBase: 0.10, irregularityRange: 0.20,  // 10-30%
    spikinessBase: 0.10, spikinessRange: 0.20,        // 10-30%
    scale1Base: 0.80, scale2Base: 0.65, scaleRange: 0.15,  // Single vs multiple hole sizes
    offsetBase: 0, offsetRange: 0.50                  // 0-50% offset from center
};

// Smoothness (Catmull-Rom curve tension)
const SMOOTHNESS = 0.30;  // 30% smooth corners

// HSL Background spectrum
const BG_COLOR = {
    hueMin: 0, hueMax: 360,      // Full spectrum
    satMin: 35, satMax: 55,      // 35-55% saturation
    lightMin: 16, lightMax: 22   // 16-22% lightness (dark backgrounds)
};

// HSL Shape spectrum
const SHAPE_COLOR = {
    satMin: 55, satMax: 75,      // 55-75% saturation (vibrant)
    lightMin: 45, lightMax: 65   // 45-65% lightness
};

// Color harmony
const COLOR_HARMONY = {
    mode: 'analogous',           // analogous colors (±40°)
    variation: 80                // ±80° variation
};

// Face layer configuration
const FACE = {
    eyeSize: 0.10,               // 10% of avatar
    eyeDistance: 0.26,           // 26% from center
    eyeHeight: 0.38,             // 38% from top
    mouthHeight: 0.58,           // 58% from top
    opacity: 1.0                 // 100% opacity
};

// Frame (internal border with background color)
const FRAME_WIDTH = 0.06;        // 6% of avatar size

// Face feature types
const EYE_TYPES = ['dot', 'round', 'oval', 'sleepy', 'blink', 'wink', 'happy', 'cute'];
const MOUTH_TYPES = ['smile', 'grin', 'grinOpen', 'grinDark', 'smirk', 'neutral', 'line', 'cat', 'tongue'];
const EXPRESSIONS = ['normal', 'tilt', 'happy', 'curious'];

// ==========================================
// Core Utility Functions
// ==========================================

/**
 * Hash a string to a number
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
 */
function createRng(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// ==========================================
// Color Functions
// ==========================================

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Generate a color from HSL spectrum
 */
function generateColorFromSpectrum(rng, hueMin, hueMax, satMin, satMax, lightMin, lightMax) {
    let hue;
    if (hueMin <= hueMax) {
        hue = hueMin + rng() * (hueMax - hueMin);
    } else {
        // Wrap around (e.g., 350-30 goes through red)
        const range = (360 - hueMin) + hueMax;
        const h = rng() * range;
        hue = h < (360 - hueMin) ? hueMin + h : h - (360 - hueMin);
    }
    const sat = satMin + rng() * (satMax - satMin);
    const light = lightMin + rng() * (lightMax - lightMin);
    return { hex: hslToHex(hue, sat, light), hue, sat, light };
}

/**
 * Generate harmonic color based on base hue
 */
function generateHarmonicColor(rng, baseHue, satMin, satMax, lightMin, lightMax) {
    const v = (rng() - 0.5) * 2 * COLOR_HARMONY.variation;
    
    let hueOffset;
    switch (COLOR_HARMONY.mode) {
        case 'complementary':
            hueOffset = 180 + v;
            break;
        case 'analogous':
            hueOffset = (rng() > 0.5 ? 40 : -40) + v;
            break;
        case 'triadic':
            hueOffset = (rng() > 0.5 ? 120 : 240) + v;
            break;
        case 'split':
            hueOffset = (rng() > 0.5 ? 150 : -150) + v;
            break;
        default:
            hueOffset = v;
    }
    
    const hue = (baseHue + hueOffset + 360) % 360;
    const sat = satMin + rng() * (satMax - satMin);
    const light = lightMin + rng() * (lightMax - lightMin);
    return hslToHex(hue, sat, light);
}

// ==========================================
// Shape Generation
// ==========================================

/**
 * Generate a procedural polygon path with optional smoothing
 */
function generatePolygonPath(rng, cx, cy, radius, numVertices, irregularity, spikiness) {
    const points = [];
    const angleStep = (Math.PI * 2) / numVertices;
    
    for (let i = 0; i < numVertices; i++) {
        const baseAngle = angleStep * i - Math.PI / 2;
        const angleOffset = (rng() - 0.5) * 2 * irregularity * angleStep;
        const angle = baseAngle + angleOffset;
        
        const radiusOffset = 1 + (rng() - 0.5) * 2 * spikiness;
        const r = radius * radiusOffset;
        
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        points.push({ x, y });
    }
    
    if (SMOOTHNESS <= 0) {
        const pathParts = points.map((p, i) => 
            (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)
        );
        pathParts.push('Z');
        return pathParts.join(' ');
    }
    
    // Smooth corners using Catmull-Rom to Bezier conversion
    const n = points.length;
    let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
    
    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];
        
        const tension = 1 - SMOOTHNESS * 0.5;
        const t = tension / 6;
        
        const cp1x = p1.x + (p2.x - p0.x) * t;
        const cp1y = p1.y + (p2.y - p0.y) * t;
        const cp2x = p2.x - (p3.x - p1.x) * t;
        const cp2y = p2.y - (p3.y - p1.y) * t;
        
        path += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }
    
    return path;
}

/**
 * Generate the complete procedural shape (2 polygons + holes)
 */
function generateProceduralShape(rng, cx, cy, size) {
    const margin = size * 0.05;
    const usableRadius = (size / 2) - margin;
    const baseRadius = usableRadius * 0.9;
    
    // Polygon A (central, large)
    const numVerticesA = POLYGON_A.verticesBase + Math.floor(rng() * POLYGON_A.verticesRange);
    const irregularityA = POLYGON_A.irregularityBase + rng() * POLYGON_A.irregularityRange;
    const spikinessA = POLYGON_A.spikinessBase + rng() * POLYGON_A.spikinessRange;
    const scaleA = POLYGON_A.scaleBase + rng() * POLYGON_A.scaleRange;
    const radiusA = baseRadius * scaleA;
    
    const offsetAx = (rng() - 0.5) * size * 0.02;
    const offsetAy = (rng() - 0.5) * size * 0.02;
    const cxA = cx + offsetAx;
    const cyA = cy + offsetAy;
    
    const pathA = generatePolygonPath(rng, cxA, cyA, radiusA, numVerticesA, irregularityA, spikinessA);
    
    // Polygon B (overlapping)
    const numVerticesB = POLYGON_B.verticesBase + Math.floor(rng() * POLYGON_B.verticesRange);
    const irregularityB = POLYGON_B.irregularityBase + rng() * POLYGON_B.irregularityRange;
    const spikinessB = POLYGON_B.spikinessBase + rng() * POLYGON_B.spikinessRange;
    const scaleB = POLYGON_B.scaleBase + rng() * POLYGON_B.scaleRange;
    const radiusB = baseRadius * scaleB;
    
    const overlapFactor = POLYGON_B.overlapBase + rng() * POLYGON_B.overlapRange;
    const maxDistance = usableRadius - radiusB;
    const distanceAB = Math.min((radiusA + radiusB) * overlapFactor, maxDistance * 0.7);
    const angleAB = rng() * Math.PI * 2;
    
    const cxB = cxA + Math.cos(angleAB) * distanceAB;
    const cyB = cyA + Math.sin(angleAB) * distanceAB;
    
    const pathB = generatePolygonPath(rng, cxB, cyB, radiusB, numVerticesB, irregularityB, spikinessB);
    
    // Holes
    const numHoles = HOLES.min + Math.floor(rng() * (HOLES.max - HOLES.min + 1));
    
    if (numHoles === 0) {
        return { path: pathA + ' ' + pathB, holesPath: '', hasHoles: false };
    }
    
    const compositeCx = (cxA + cxB) / 2;
    const compositeCy = (cyA + cyB) / 2;
    const compositeRadius = Math.max(radiusA, radiusB) * 0.6;
    
    const holeVertices = HOLES.verticesBase + Math.floor(rng() * HOLES.verticesRange);
    const holeIrregularity = HOLES.irregularityBase + rng() * HOLES.irregularityRange;
    const holeSpikiness = HOLES.spikinessBase + rng() * HOLES.spikinessRange;
    
    const holeSizeBase = numHoles === 1 ? HOLES.scale1Base : HOLES.scale2Base;
    const holeScale = holeSizeBase + rng() * HOLES.scaleRange;
    const holeRadius = compositeRadius * holeScale;
    
    const holeOffset = HOLES.offsetBase + rng() * HOLES.offsetRange;
    
    let holesPath = '';
    const holePositions = [];
    
    if (numHoles === 1) {
        const angle = rng() * Math.PI * 2;
        const distance = compositeRadius * holeOffset;
        holePositions.push({
            x: compositeCx + Math.cos(angle) * distance,
            y: compositeCy + Math.sin(angle) * distance
        });
    } else {
        const baseAngle = rng() * Math.PI * 2;
        const minSeparation = holeRadius * 2.2;
        const holeDistance = Math.max(minSeparation, compositeRadius * holeOffset);
        
        for (let h = 0; h < numHoles; h++) {
            const angle = baseAngle + (Math.PI * 2 * h / numHoles);
            holePositions.push({
                x: compositeCx + Math.cos(angle) * holeDistance,
                y: compositeCy + Math.sin(angle) * holeDistance
            });
        }
    }
    
    for (let h = 0; h < numHoles; h++) {
        const holePath = generatePolygonPath(
            rng, holePositions[h].x, holePositions[h].y,
            holeRadius, holeVertices, holeIrregularity, holeSpikiness
        );
        holesPath += ' ' + holePath;
    }
    
    return { path: pathA + ' ' + pathB, holesPath: holesPath.trim(), hasHoles: true };
}

// ==========================================
// Face Generation (Pareidolia Layer)
// ==========================================

/**
 * Generate eye SVG element
 */
function generateEye(type, x, y, radius, color, opacity) {
    const r = radius;
    
    switch (type) {
        case 'dot':
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
            
        case 'round':
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>
                    <circle cx="${x}" cy="${y}" r="${r * 0.35}" fill="${color === '#1a1a24' ? '#f0f0f5' : '#1a1a24'}" opacity="${opacity}"/>`;
            
        case 'oval':
            return `<ellipse cx="${x}" cy="${y}" rx="${r * 0.7}" ry="${r}" fill="${color}" opacity="${opacity}"/>`;
            
        case 'sleepy':
            return `<line x1="${x - r}" y1="${y}" x2="${x + r}" y2="${y}" stroke="${color}" stroke-width="${r * 0.8}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'blink':
            return `<path d="M${x - r} ${y} Q${x} ${y - r * 0.8} ${x + r} ${y}" fill="none" stroke="${color}" stroke-width="${r * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'wink':
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
            
        case 'happy':
            return `<path d="M${x - r} ${y + r * 0.3} Q${x} ${y - r * 0.8} ${x + r} ${y + r * 0.3}" fill="none" stroke="${color}" stroke-width="${r * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'cute':
            const hlX = x - r * 0.3;
            const hlY = y - r * 0.3;
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>
                    <circle cx="${hlX}" cy="${hlY}" r="${r * 0.25}" fill="${color === '#1a1a24' ? '#f0f0f5' : '#1a1a24'}" opacity="${opacity * 0.8}"/>`;
            
        default:
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
    }
}

/**
 * Generate mouth SVG element
 */
function generateMouth(type, x, y, width, height, color, opacity) {
    const w = width;
    const h = height;
    
    switch (type) {
        case 'smile':
            return `<path d="M${x - w} ${y} Q${x} ${y + h * 2.5} ${x + w} ${y}" fill="none" stroke="${color}" stroke-width="${h * 0.7}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'grin':
            return `<path d="M${x - w * 1.2} ${y - h * 0.3} Q${x} ${y + h * 3.5} ${x + w * 1.2} ${y - h * 0.3}" fill="none" stroke="${color}" stroke-width="${h * 0.7}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'grinOpen':
            const gw = w * 1.1;
            const gh = h * 2.2;
            return `<path d="M${x - gw} ${y - gh * 0.2} L${x - gw} ${y + gh * 0.6} Q${x} ${y + gh * 1.4} ${x + gw} ${y + gh * 0.6} L${x + gw} ${y - gh * 0.2} Z" fill="${color}" opacity="${opacity * 0.9}"/>
                    <rect x="${x - gw * 0.7}" y="${y - gh * 0.15}" width="${gw * 1.4}" height="${gh * 0.35}" fill="white" opacity="${opacity * 0.95}" rx="${gh * 0.1}"/>`;
            
        case 'grinDark':
            const gdw = w * 1.1;
            const gdh = h * 2.2;
            return `<path d="M${x - gdw} ${y - gdh * 0.2} L${x - gdw} ${y + gdh * 0.6} Q${x} ${y + gdh * 1.4} ${x + gdw} ${y + gdh * 0.6} L${x + gdw} ${y - gdh * 0.2} Z" fill="${color}" opacity="${opacity * 0.9}"/>`;
            
        case 'smirk':
            return `<path d="M${x - w * 0.8} ${y + h * 0.3} Q${x} ${y + h * 1.5} ${x + w * 0.8} ${y - h * 0.5}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'neutral':
            return `<line x1="${x - w * 0.8}" y1="${y}" x2="${x + w * 0.8}" y2="${y}" stroke="${color}" stroke-width="${h * 0.7}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'line':
            return `<path d="M${x - w * 0.6} ${y - h * 0.2} Q${x} ${y + h * 1.2} ${x + w * 0.6} ${y - h * 0.2}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'cat':
            return `<path d="M${x - w * 0.6} ${y} Q${x - w * 0.3} ${y + h * 1.2} ${x} ${y} Q${x + w * 0.3} ${y + h * 1.2} ${x + w * 0.6} ${y}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'tongue':
            return `<path d="M${x - w * 0.7} ${y} Q${x} ${y + h * 2} ${x + w * 0.7} ${y}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>
                    <ellipse cx="${x}" cy="${y + h * 1.8}" rx="${w * 0.25}" ry="${h * 0.8}" fill="${color}" opacity="${opacity * 0.8}"/>`;
            
        default:
            return '';
    }
}

/**
 * Generate face SVG elements
 */
function generateFace(rng, size, bgColor) {
    // Procedural face features from seed
    const eyeType = EYE_TYPES[Math.floor(rng() * EYE_TYPES.length)];
    const mouthType = MOUTH_TYPES[Math.floor(rng() * MOUTH_TYPES.length)];
    const expression = EXPRESSIONS[Math.floor(rng() * EXPRESSIONS.length)];
    
    // Face color is background color
    const faceColorHex = bgColor;
    
    const opacity = FACE.opacity;
    const cx = size / 2;
    const cy = size / 2;
    
    // Eye positions
    const eyeRadius = size * FACE.eyeSize / 2;
    const eyeSpacing = size * FACE.eyeDistance / 2;
    const eyeY = size * FACE.eyeHeight;
    
    // Expression modifiers
    let tiltAngle = 0;
    let eyeOffsetY = 0;
    let mouthWidthMod = 1;
    
    switch (expression) {
        case 'tilt':
            tiltAngle = (rng() > 0.5 ? 1 : -1) * (5 + rng() * 10);
            break;
        case 'happy':
            eyeOffsetY = -size * 0.02;
            mouthWidthMod = 1.2;
            break;
        case 'curious':
            eyeOffsetY = (rng() > 0.5 ? 1 : -1) * size * 0.015;
            break;
    }
    
    let faceElements = '';
    
    // Generate eyes
    const leftEyeX = cx - eyeSpacing;
    const rightEyeX = cx + eyeSpacing;
    const leftEyeY = eyeY + (expression === 'curious' ? eyeOffsetY : 0);
    const rightEyeY = eyeY + (expression === 'curious' ? -eyeOffsetY : 0);
    
    faceElements += generateEye(eyeType, leftEyeX, leftEyeY, eyeRadius, faceColorHex, opacity);
    faceElements += generateEye(eyeType === 'wink' ? 'blink' : eyeType, rightEyeX, rightEyeY, eyeRadius, faceColorHex, opacity);
    
    // Generate mouth
    const mouthY = size * FACE.mouthHeight;
    const mouthWidth = size * 0.15 * mouthWidthMod;
    faceElements += generateMouth(mouthType, cx, mouthY, mouthWidth, eyeRadius * 1.0, faceColorHex, opacity);
    
    // Wrap with rotation if tilted
    if (tiltAngle !== 0) {
        return `<g transform="rotate(${tiltAngle.toFixed(1)} ${cx} ${cy})" opacity="${opacity}">${faceElements}</g>`;
    }
    
    return faceElements;
}

// ==========================================
// Main Avatar Generation
// ==========================================

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
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    
    // Generate background color from HSL spectrum
    const bgResult = generateColorFromSpectrum(
        rng,
        BG_COLOR.hueMin, BG_COLOR.hueMax,
        BG_COLOR.satMin, BG_COLOR.satMax,
        BG_COLOR.lightMin, BG_COLOR.lightMax
    );
    const bgColor = bgResult.hex;
    
    // Generate shape color with color harmony
    const shapeColor = generateHarmonicColor(
        rng,
        bgResult.hue,
        SHAPE_COLOR.satMin, SHAPE_COLOR.satMax,
        SHAPE_COLOR.lightMin, SHAPE_COLOR.lightMax
    );
    
    const cx = size / 2;
    const cy = size / 2;
    
    // Generate procedural shape
    const { path, holesPath, hasHoles } = generateProceduralShape(rng, cx, cy, size);
    
    // Random rotation
    const rotation = Math.floor(rng() * 360);
    const rx = size * borderRadius;
    
    // Holes element (drawn with background color to "subtract")
    const holesElement = hasHoles ? `<path d="${holesPath}" fill="${bgColor}"/>` : '';
    
    // Face layer with separate RNG for deterministic face independent of shape
    const faceRng = createRng(seed + 0xFACE);
    const faceElement = generateFace(faceRng, size, bgColor);
    
    // Deterministic ID for clip path (based on address seed)
    const clipId = `avatar-clip-${seed.toString(36)}`;
    
    // Frame element (internal border with background color)
    const fw = size * FRAME_WIDTH;
    const innerSize = size - fw * 2;
    const frameElement = `<path d="M0,0 h${size} v${size} h-${size} Z M${fw},${fw} v${innerSize} h${innerSize} v-${innerSize} Z" fill="${bgColor}" fill-rule="evenodd"/>`;
    
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <defs>
            <clipPath id="${clipId}">
                <rect width="${size}" height="${size}" rx="${rx}"/>
            </clipPath>
        </defs>
        <g clip-path="url(#${clipId})">
            <rect width="${size}" height="${size}" fill="${bgColor}"/>
            <g transform="rotate(${rotation} ${cx} ${cy})">
                <path d="${path}" fill="${shapeColor}"/>
                ${holesElement}
            </g>
            ${faceElement}
            ${frameElement}
        </g>
    </svg>`;
}

/**
 * Generate avatar as a data URI for use in img src
 */
export function generateAvatarDataUri(address, size = 32, borderRadius = 0.2) {
    const svg = generateAvatar(address, size, borderRadius);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ==========================================
// Cache System
// ==========================================

const avatarCache = new Map();
const MAX_CACHE_SIZE = 200;

/**
 * Get cached avatar or generate new one
 */
export function getAvatar(address, size = 32, borderRadius = 0.2) {
    const key = `${address?.toLowerCase()}-${size}-${borderRadius}`;
    
    if (avatarCache.has(key)) {
        return avatarCache.get(key);
    }
    
    const svg = generateAvatar(address, size, borderRadius);
    
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
 */
export function getAddressColor(address) {
    if (!address || typeof address !== 'string') {
        return '#6C5DD3'; // Default purple
    }
    
    const normalizedAddress = address.toLowerCase();
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    
    // Generate bg hue first (same sequence as in generateAvatar)
    const bgResult = generateColorFromSpectrum(
        rng,
        BG_COLOR.hueMin, BG_COLOR.hueMax,
        BG_COLOR.satMin, BG_COLOR.satMax,
        BG_COLOR.lightMin, BG_COLOR.lightMax
    );
    
    // Return shape color with harmony
    return generateHarmonicColor(
        rng,
        bgResult.hue,
        SHAPE_COLOR.satMin, SHAPE_COLOR.satMax,
        SHAPE_COLOR.lightMin, SHAPE_COLOR.lightMax
    );
}

// ==========================================
// Exports
// ==========================================

export const avatarGenerator = {
    generate: generateAvatar,
    generateDataUri: generateAvatarDataUri,
    get: getAvatar,
    clearCache: clearAvatarCache,
    getColor: getAddressColor,
};
