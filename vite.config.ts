import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // .kaira-data/ and logs/ are excluded even when watching is on: the server
      // writes to .kaira-data on every session/turn (usage, settings, memory,
      // reminders, etc.), and without this a write there triggers a full page
      // reload -- which kills the live WebSocket and closes the Gemini session
      // mid-conversation. See server_paths.ts for the full story.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: ['**/.kaira-data/**', '**/logs/**'],
      },
    },
  };
});
