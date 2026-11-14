import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ inspectorPort: false })],
  server: { port: 5173 },
  worker: { format: "es" },
  run: {
    tasks: {
      types: "cf workers types",
      dev: { command: "vp dev", cache: false },
      build: "vp build",
      deploy: { command: "cf deploy", cache: false },
    },
  },
});
