import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any static host (e.g. GitHub Pages).
  base: './',
  build: {
    // three.js alone is ~600 kB; one chunk is fine for a game this size.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      input: { main: 'index.html', gallery: 'gallery.html' },
    },
  },
  test: {
    environment: 'node',
  },
});
