import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [cloudflare()],
  server: { port: 5174 },
  run: {
    tasks: {
      types: "cf workers types",
      dev: { command: "vp dev", cache: false },
      build: "vp build",
      deploy: { command: "cf deploy", cache: false },
    },
  },
});
