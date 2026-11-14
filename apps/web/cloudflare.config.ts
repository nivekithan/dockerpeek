import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "docker-viewer-web",
    compatibilityDate: "2026-11-13",
    assets: {
      notFoundHandling: "single-page-application",
    },
  },
});
