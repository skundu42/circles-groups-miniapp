import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer'],
      globals: { Buffer: true },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (id.includes('@aboutcircles/sdk')) return 'circles-sdk';
          if (id.includes('@aboutcircles/miniapp-sdk')) return 'circles-miniapp';
          if (id.includes('@aboutcircles/sdk-utils')) return 'circles-utils';
          if (id.includes('@safe-global/safe-deployments')) return 'safe-deployments';
          if (id.includes('viem')) return 'viem';
          if (id.includes('marked')) return 'markdown';

          return 'vendor';
        },
      },
    },
  },
});
