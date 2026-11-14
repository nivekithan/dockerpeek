import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "docker-viewer-web",
    compatibilityDate: "2026-11-13",
    domains: ["dockerpeek.nivekithan.com"],
    entrypoint,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      API: bindings.worker({ worker: "docker-viewer-api" }),
    },
  },
});
