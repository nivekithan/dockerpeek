import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "docker-viewer-api",
    compatibilityDate: "2026-11-13",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: true },
      traces: { enabled: true, headSamplingRate: 1 },
    },
    limits: {
      cpuMs: 300_000,
      subrequests: 1_000_000,
    },
    env: {
      REGISTRY_TOKENS: bindings.kv(),
      STORAGE: bindings.r2({ name: "docker-viewer" }),
      IMAGE_INDEXER: bindings.workflow({
        name: "image-indexer",
        worker: "docker-viewer-api",
        exportName: "ImageIndexer",
      }),
    },
    exports: {
      ImageIndexer: exports.workflow({ name: "image-indexer" }),
    },
  },
});
