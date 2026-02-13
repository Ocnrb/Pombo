/**
 * Centralized Logger Module
 * Controls console output levels across the application
 * 
 * Usage:
 *   Logger.error('message')  - Always shown (critical errors)
 *   Logger.warn('message')   - Warnings (level >= 2)
 *   Logger.info('message')   - Info messages (level >= 3)
 *   Logger.debug('message')  - Debug details (level >= 4)
 * 
 * Set level:
 *   Logger.setLevel(Logger.LEVELS.ERROR)  - Production (only errors)
 *   Logger.setLevel(Logger.LEVELS.DEBUG)  - Development (all logs)
 */

const Logger = {
    // Log levels
    LEVELS: {
        NONE: 0,   // No logs
        ERROR: 1,  // Only errors
        WARN: 2,   // Errors + warnings
        INFO: 3,   // Errors + warnings + info
        DEBUG: 4   // All logs including debug
    },
    
    // Default: ERROR only (production mode)
    currentLevel: 1,
    
    /**
     * Log an error (always shown unless NONE)
     */
    error: function(message, ...args) {
        if (this.currentLevel >= this.LEVELS.ERROR) {
            console.error('❌', message, ...args);
        }
    },
    
    /**
     * Log a warning
     */
    warn: function(message, ...args) {
        if (this.currentLevel >= this.LEVELS.WARN) {
            console.warn('⚠️', message, ...args);
        }
    },
    
    /**
     * Log info message
     */
    info: function(message, ...args) {
        if (this.currentLevel >= this.LEVELS.INFO) {
            console.log('ℹ️', message, ...args);
        }
    },
    
    /**
     * Log debug message
     */
    debug: function(message, ...args) {
        if (this.currentLevel >= this.LEVELS.DEBUG) {
            console.log('🔍', message, ...args);
        }
    },
    
    /**
     * Set the logging level
     * @param {number} level - One of Logger.LEVELS values
     */
    setLevel: function(level) {
        this.currentLevel = level;
        if (level >= this.LEVELS.INFO) {
            console.log('📝 Logger level set to:', Object.keys(this.LEVELS).find(k => this.LEVELS[k] === level));
        }
    },
    
    /**
     * Enable debug mode (all logs)
     */
    enableDebug: function() {
        this.setLevel(this.LEVELS.DEBUG);
    },
    
    /**
     * Enable production mode (errors only)
     */
    enableProduction: function() {
        this.setLevel(this.LEVELS.ERROR);
    }
};

// Auto-detect environment
if (typeof window !== 'undefined') {
    // Browser environment - check for localhost
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        Logger.currentLevel = Logger.LEVELS.DEBUG;
    }
    
    // Expose globally for debugging
    window.Logger = Logger;
}

// ES Module export
export { Logger };
