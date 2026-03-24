import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Environment para simular browser
    environment: 'jsdom',
    
    // Padrões de ficheiros de teste
    include: ['src/**/*.{test,spec}.js', 'tests/**/*.{test,spec}.js'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/js/**/*.js'],
      exclude: [
        'src/js/workers/**',
        'src/js/app.js', // Entry point
        '**/*.bundle.js'
      ],
      thresholds: {
        // Threshold mínimo para prevenir regressões
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50
      }
    },
    
    // Global setup
    globals: true,
    
    // Setup file
    setupFiles: ['./tests/setup.js'],
    
    // Timeout para testes async
    testTimeout: 10000,
    
    // Isolamento entre testes
    isolate: true,
    
    // Pool de workers
    pool: 'forks',
    
    // Reporter
    reporters: ['verbose']
  }
});
