import {defineConfig} from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with {type: 'json'};
import {renderShell} from './src/shell.ts';
import {freePort, pruneDist} from './vite.plugins.ts';

// The multiplayer server (wrangler dev) the client proxies /api + /room to. Overridable so
// serve-local.sh can run a second, isolated stack on other ports.
const NET_TARGET = `http://localhost:${process.env.NET_PORT ?? '8787'}`;

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [
    preact({prefreshEnabled: false}),
    {name: 'shell-copy', transformIndexHtml: renderShell},
    freePort(),
    pruneDist(),
  ],
  // Expose the package version + repository URL to the app (shown on the main menu).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __REPO_URL__: JSON.stringify(pkg.homepage),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: 2141,
    strictPort: true,
    hmr: false,
    host: true,
    proxy: {
      '/api': {target: NET_TARGET, changeOrigin: true},
      '/room': {target: NET_TARGET, changeOrigin: true, ws: true},
    },
  },
});
