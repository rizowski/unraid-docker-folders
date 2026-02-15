import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Mock API: MOCK_API=1 npm run dev
// Proxy to Unraid: UNRAID_HOST=192.168.1.100 npm run dev
const useMock = !!process.env.MOCK_API;
const unraidHost = process.env.UNRAID_HOST;
const isProd = process.env.NODE_ENV === 'production';

// https://vitejs.dev/config/
export default defineConfig(async () => {
  const plugins: any[] = [vue(), tailwindcss()];

  if (useMock) {
    const { mockApiPlugin } = await import('./dev/mock-api');
    plugins.push(mockApiPlugin());
  }

  return {
    plugins,
    // Only use the Unraid base path in production builds.
    // In dev mode, serve from root so the API paths work naturally.
    base: isProd ? '/plugins/unraid-docker-folders-modern/assets/' : '/',
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
      proxy: !useMock && unraidHost
        ? {
            '/plugins/unraid-docker-folders-modern/api': {
              target: `http://${unraidHost}`,
              changeOrigin: true,
            },
          }
        : undefined,
    },
  };
});
