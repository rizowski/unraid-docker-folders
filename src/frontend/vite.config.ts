import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
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
        manualChunks: {
          vendor: ['vue', 'pinia'],
          utils: ['sortablejs'],
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
