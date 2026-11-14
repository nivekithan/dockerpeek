import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "docker-viewer-api",
    compatibilityDate: "2026-11-13",
    entrypoint,
  },
});
