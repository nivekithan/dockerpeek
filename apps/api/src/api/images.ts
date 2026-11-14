import {
  Api,
  ImageNotReady,
  InvalidPlatform,
  NotADirectory,
  NotAFile,
  PathNotFound,
  PreviewTooLarge,
} from "@docker-viewer/contract";
import { env } from "cloudflare:workers";
import { Context, Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { resolve } from "pathe";
import type { IndexImageParams } from "../indexing/workflow.ts";
import { parseImageReference, type Platform, Registry } from "../registry.ts";
import {
  directoryShard,
  directoryShardKey,
  layerTarKey,
  Storage,
  StorageError,
  StoredDirShard,
  type StoredProgress,
} from "../storage.ts";

export const ImagesHandlers = HttpApiBuilder.group(
  Api,
  "images",
  Effect.fn("Images.handlers")(function* (handlers) {
    // Retain only dependencies, not the setup-time Scope or parent span.
    const services = (yield* Effect.context<Registry | Storage>()).pipe(
      Context.pick(Registry, Storage),
    );
    return handlers.handleAll({
      open: Effect.fn("Images.open")(
        function* ({ payload }) {
          const registry = yield* Registry;
          const storage = yield* Storage;
          const imageReference = yield* parseImageReference(payload.imageReference);
          const wanted =
            payload.platform === undefined
              ? DEFAULT_PLATFORM
              : yield* parsePlatform(payload.platform);
          const manifestDigest = yield* registry.resolve(imageReference, wanted);
          if ((yield* storage.getReadyMarker(manifestDigest)) === undefined) {
            yield* startIndexing({
              registry: imageReference.registry,
              repository: imageReference.repository,
              manifestDigest,
            });
          }
          return {
            manifestDigest,
            status: (yield* imageStatus(manifestDigest)).status,
          };
        },
        Effect.catchTag("StorageError", Effect.die),
        Effect.provide(services),
      ),

      status: ({ params }) =>
        imageStatus(params.digest).pipe(Effect.orDie, Effect.provide(services)),

      tree: Effect.fn("Images.tree")(
        function* ({ params, query }) {
          yield* readyMarker(params.digest);
          const path = query.path ?? "/";
          const target = yield* resolvePath(params.digest, path);
          if (target.entry !== undefined && target.entry.type !== "directory") {
            return yield* new NotADirectory({ path });
          }
          const entries = yield* listing(params.digest, target.segments);
          return {
            path: `/${target.segments.join("/")}`,
            entries: entries.map(({ name, type, mode, size, linkTarget }) =>
              linkTarget === undefined
                ? { name, type, mode, size }
                : { name, type, mode, size, linkTarget },
            ),
          };
        },
        Effect.catchTag("StorageError", Effect.die),
        Effect.provide(services),
      ),

      file: Effect.fn("Images.file")(
        function* ({ params, query }) {
          const file = yield* resolveFile(params.digest, query.path);
          const body = yield* readFile(file);
          return HttpServerResponse.raw(body, {
            contentType: "application/octet-stream",
            contentLength: file.size,
            headers: {
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
              "x-content-type-options": "nosniff",
            },
          });
        },
        Effect.catchTag("StorageError", Effect.die),
        Effect.provide(services),
      ),
      preview: Effect.fn("Images.preview")(
        function* ({ params, query }) {
          const file = yield* resolveFile(params.digest, query.path);
          if (file.size > MAX_PREVIEW_BYTES) {
            return yield* new PreviewTooLarge({
              path: query.path,
              size: file.size,
              maxBytes: MAX_PREVIEW_BYTES,
            });
          }
          const body = yield* readFile(file);
          return HttpServerResponse.raw(body, {
            contentType: "application/octet-stream",
            contentLength: file.size,
            headers: { "x-content-type-options": "nosniff" },
          });
        },
        Effect.catchTag("StorageError", Effect.die),
        Effect.provide(services),
      ),
    });
  }),
);

/** Resolves file metadata before reading bytes, so preview limits can be checked first. */
const resolveFile = Effect.fn("Images.resolveFile")(function* (
  manifestDigest: string,
  path: string,
) {
  const marker = yield* readyMarker(manifestDigest);
  const { segments, entry } = yield* resolvePath(manifestDigest, path);
  const layer = entry?.layer === undefined ? undefined : marker.layers[entry.layer];
  if (entry?.type !== "file" || layer === undefined || entry.offset === undefined) {
    return yield* new NotAFile({ path });
  }
  return { layer, offset: entry.offset, size: entry.size, name: segments.at(-1) ?? "file" };
});

const readFile = Effect.fn("Images.readFile")(function* (file: {
  readonly layer: string;
  readonly offset: number;
  readonly size: number;
}) {
  const storage = yield* Storage;
  const body =
    file.size === 0
      ? null
      : yield* storage.getRange(layerTarKey(file.layer), file.offset, file.size);
  if (body === undefined) {
    return yield* new StorageError({ message: `layer ${file.layer} is missing from storage` });
  }
  return body;
});

const imageStatus = Effect.fn("Images.imageStatus")(function* (manifestDigest: string) {
  const storage = yield* Storage;
  if ((yield* storage.getReadyMarker(manifestDigest)) !== undefined)
    return { status: "ready" } as const;
  const instance = yield* workflowStatus(manifestDigest);
  if (Option.isNone(instance)) return { status: "not_found" } as const;
  const { status, error } = instance.value;
  if (status === "errored" || status === "terminated") {
    return error === undefined
      ? ({ status: "failed" } as const)
      : ({ status: "failed", error: error.message } as const);
  }
  const progress = yield* storage.getProgress(manifestDigest);
  return progress === undefined
    ? ({ status: "indexing" } as const)
    : ({ status: "indexing", progress: indexingProgress(progress) } as const);
});

/** Byte totals are aggregated by the indexer across both active layers. */
const indexingProgress = (progress: StoredProgress) => {
  const { phase, layerSizes, layer, completedBytes, buildProgress } = progress;
  const totalBytes = layerSizes.reduce((total, size) => total + size, 0);
  return {
    phase,
    completedBytes: Math.min(completedBytes, totalBytes),
    totalBytes,
    layer: Math.min(layer + 1, layerSizes.length),
    layerCount: layerSizes.length,
    ...(layerSizes[layer] === undefined ? {} : { layerSize: layerSizes[layer] }),
    ...(buildProgress === undefined ? {} : { buildProgress: Math.min(buildProgress, 1) }),
  };
};

/** Creates the indexing workflow, or restarts it after a failure. Restarts are cheap: indexed layers are skipped. */
const startIndexing = Effect.fn("Images.startIndexing")(function* (params: IndexImageParams) {
  const id = instanceId(params.manifestDigest);
  // Duplicate IDs are expected; all other creation failures must reach the caller.
  const result = yield* Effect.tryPromise(() =>
    env.IMAGE_INDEXER.createBatch({ instances: [{ id, params }] }),
  ).pipe(Effect.orDie);
  for (const error of result.errors) {
    if (error.code !== 10405) {
      return yield* Effect.die(
        new Error(`creating indexing workflow ${id} failed (${error.code}): ${error.message}`),
      );
    }
  }
  if (result.errors.length === 0) return;
  const instance = yield* Effect.tryPromise(() => env.IMAGE_INDEXER.get(id)).pipe(Effect.orDie);
  const status = yield* Effect.tryPromise(() => instance.status()).pipe(Effect.orDie);
  if (status.status === "errored") {
    yield* Effect.tryPromise(() => instance.restart()).pipe(Effect.orDie);
  }
});

const readyMarker = Effect.fn("Images.readyMarker")(function* (manifestDigest: string) {
  const storage = yield* Storage;
  const marker = yield* storage.getReadyMarker(manifestDigest);
  if (marker === undefined) {
    return yield* new ImageNotReady({
      status: (yield* imageStatus(manifestDigest)).status,
    });
  }
  return marker;
});

/**
 * Walks `path` one segment at a time, following symlinks relative to the image root.
 * Returns the resolved path and its entry, which is undefined for `/`.
 */
const resolvePath = Effect.fn("Images.resolvePath")(function* (
  manifestDigest: string,
  path: string,
) {
  let pending = splitPath(resolve("/", path));
  const resolved: string[] = [];
  let hops = 0;
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    const entry = (yield* listing(manifestDigest, resolved)).find(
      (candidate) => candidate.name === name,
    );
    if (entry === undefined) return yield* new PathNotFound({ path });
    if (entry.type === "symlink" && entry.linkTarget !== undefined) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return yield* new PathNotFound({ path });
      pending = [...splitPath(resolve(`/${resolved.join("/")}`, entry.linkTarget)), ...pending];
      resolved.length = 0;
      continue;
    }
    resolved.push(name);
    if (pending.length === 0) return { segments: resolved, entry };
  }
  return { segments: resolved, entry: undefined };
});

const listing = Effect.fn("Images.listing")(function* (
  manifestDigest: string,
  segments: ReadonlyArray<string>,
) {
  const storage = yield* Storage;
  const path = `/${segments.join("/")}`;
  const shard = yield* storage.getJson(
    directoryShardKey(manifestDigest, yield* directoryShard(path)),
    StoredDirShard,
  );
  const stored = shard?.[path];
  if (stored === undefined) return yield* new PathNotFound({ path });
  return stored.entries;
});

const workflowStatus = (manifestDigest: string) =>
  Effect.tryPromise(async () =>
    (await env.IMAGE_INDEXER.get(instanceId(manifestDigest))).status(),
  ).pipe(Effect.option);

const parsePlatform = (input: string) => {
  const [os, architecture, variant, ...rest] = input.split("/");
  if (!os || !architecture || variant === "" || rest.length > 0) {
    return Effect.fail(new InvalidPlatform({ platform: input }));
  }
  return Effect.succeed<Platform>({ os, architecture, variant });
};

/** Workflow instance IDs only allow letters, digits, `-` and `_`. */
const instanceId = (manifestDigest: string) => `v3-${manifestDigest.replace(":", "-")}`;

const splitPath = (path: string) => path.split("/").filter((segment) => segment !== "");

const DEFAULT_PLATFORM: Platform = { os: "linux", architecture: "amd64" };
const MAX_SYMLINK_HOPS = 40;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
