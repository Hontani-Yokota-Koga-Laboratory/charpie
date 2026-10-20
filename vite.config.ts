import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createApi } from './server/api';
import { Workspace } from './server/workspace';

/** In dev, serve the same API as `charpie serve` (dir: $CHARPIE_DIR or ./diagrams). */
function charpieApi(): Plugin {
  return {
    name: 'charpie-api',
    configureServer(server) {
      if (process.env.VITEST) return;
      const ws = new Workspace(process.env.CHARPIE_DIR ?? 'diagrams');
      ws.watch();
      server.middlewares.use(createApi(ws));
      server.httpServer?.on('close', () => ws.close());
    },
  };
}

export default defineConfig({
  plugins: [react(), charpieApi()],
  server: { host: true, watch: { ignored: ['**/diagrams/**', '**/*.charpie'] } },
  build: { chunkSizeWarningLimit: 1200 },
});
