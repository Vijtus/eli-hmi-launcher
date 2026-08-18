import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ["yaml", "isomorphic-git", "isomorphic-git/http/node"],
      },
    },
  },
  preload: {},
  renderer: {},
});
