import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    outDir: '../backend/usr/local/emhttp/plugins/unraid-docker-modern/assets',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor': ['vue', 'pinia'],
          'utils': ['sortablejs']
        }
      }
    }
  },
  server: {
    proxy: {
      '/plugins/unraid-docker-modern/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})
