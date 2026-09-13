import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Mock API: MOCK_API=1 yarn dev
// Proxy to Unraid: UNRAID_HOST=192.168.1.100 yarn dev
const useMock = !!process.env.MOCK_API;
const unraidHost = process.env.UNRAID_HOST;
const isProd = process.env.NODE_ENV === 'production';

// app.js/app.css are emitted under fixed filenames (see entryFileNames /
// assetFileNames below) rather than Vite's usual content hash, because the
// Unraid plugin references them from static PHP/page files. That means
// browsers can keep serving a stale cached copy across plugin updates
// unless something in the URL changes. build.sh passes the package version
// it's about to stamp on the .txz as APP_VERSION; a plain `yarn build` run
// outside that script (e.g. local testing) falls back to a timestamp so
// there's always *some* cache-busting value.
const appVersion = process.env.APP_VERSION || String(Date.now());

function cacheBustAssetsPlugin(version: string): Plugin {
  return {
    name: 'cache-bust-assets',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/(src="[^"]*\/app\.js)(")/, `$1?v=${version}$2`)
        .replace(/(href="[^"]*\/app\.css)(")/, `$1?v=${version}$2`);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async () => {
  const plugins: any[] = [vue(), tailwindcss()];

  if (isProd) {
    plugins.push(cacheBustAssetsPlugin(appVersion));
  }

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
