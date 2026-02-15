import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  base: '/plugins/unraid-docker-folders-modern/assets/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../backend/usr/local/emhttp/plugins/unraid-docker-folders-modern/assets',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Predictable filenames so the .page file can reference them directly
        entryFileNames: 'js/app.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'css/app.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
  server: {
    proxy: {
      '/plugins/unraid-docker-folders-modern/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
