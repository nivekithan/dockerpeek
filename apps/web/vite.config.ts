import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), cloudflare({ inspectorPort: false })],
  server: { port: 5173 },
  run: {
    tasks: {
      dev: { command: "vp dev", cache: false },
      build: "vp build",
      deploy: { command: "cf deploy", cache: false },
    },
  },
});
