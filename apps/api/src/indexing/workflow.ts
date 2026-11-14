import { Digest, type RegistryError, UnsupportedImage } from "@docker-viewer/contract";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { Decompress } from "fzstd";
import { type LayerDescriptor, Registry, type Repository } from "../registry.ts";
import {
  directoryKey,
  LayerEntry,
  layerIndexKey,
  layerTarKey,
  type ReadyMarker,
  readyKey,
  Storage,
  type StoredProgress,
} from "../storage.ts";
import { TarParser } from "./tar.ts";
import { applyLayer, directories, newDirectory } from "./tree.ts";
import { Observability } from "../observability.ts";

export const IndexImageParams = Schema.Struct({
  registry: Schema.String,
  repository: Schema.String,
  manifestDigest: Digest,
});
export type IndexImageParams = typeof IndexImageParams.Type;

/** Indexes one image: each layer in its own retryable step, then the merged file tree. */
export class ImageIndexer extends WorkflowEntrypoint<Env, IndexImageParams> {
  override async run(event: Readonly<WorkflowEvent<IndexImageParams>>, step: WorkflowStep) {
    const { manifestDigest, registry, repository } = event.payload;
    const image = { registry, repository };

    const layers = await step.do("list layers", STEP_CONFIG, () =>
      runStep(
        Effect.gen(function* () {
          const layers = yield* (yield* Registry).layers(image, manifestDigest);
          return layers.map(({ digest, mediaType, size }) => ({ digest, mediaType, size }));
        }),
      ),
    );

    const layerSizes = layers.map((layer) => layer.size);
    const report = (layer: number, layerBytes: number, phase: StoredProgress["phase"]) =>
      reportProgress(manifestDigest, { phase, layerSizes, layer, layerBytes });

    for (const [index, layer] of layers.entries()) {
      await step.do(`index layer ${index + 1}/${layers.length} ${layer.digest}`, STEP_CONFIG, () =>
        runStep(
          report(index, 0, "downloading").pipe(
            Effect.andThen(
              indexLayer(image, layer, (bytes) => report(index, bytes, "downloading")),
            ),
          ),
        ),
      );
    }

    await step.do("publish file tree", STEP_CONFIG, () =>
      runStep(
        report(layers.length, 0, "publishing").pipe(
          Effect.andThen(publishImage(manifestDigest, layers)),
        ),
      ),
    );
  }
}

/**
 * Stores the decompressed tar of a layer and an index of its entries.
 * Layers are shared between images, so a layer that is already indexed is skipped.
 */
const indexLayer = Effect.fn("indexLayer")(function* (
  repository: Repository,
  layer: LayerDescriptor,
  onDownloaded: (bytes: number) => Effect.Effect<void, never, Storage>,
) {
  const storage = yield* Storage;
  const registry = yield* Registry;
  if ((yield* storage.head(layerIndexKey(layer.digest))) !== null) {
    return yield* onDownloaded(layer.size);
  }

  const decompressor = yield* layerDecompressor(layer.mediaType);
  let downloaded = 0;
  let reportedAt = Date.now();
  const blob = (yield* registry.blob(repository, layer.digest)).pipe(
    Stream.tap((chunk) => {
      downloaded += chunk.byteLength;
      if (Date.now() - reportedAt < PROGRESS_INTERVAL_MS) return Effect.void;
      reportedAt = Date.now();
      return onDownloaded(downloaded).pipe(Effect.provideService(Storage, storage));
    }),
  );
  const tar: Stream.Stream<Uint8Array, RegistryError | TarError> =
    decompressor === undefined
      ? blob
      : Stream.fromReadableStream({
          evaluate: () => Stream.toReadableStream(blob).pipeThrough(decompressor()),
          onError: (cause) =>
            new TarError({ message: `decompressing ${layer.digest} failed: ${String(cause)}` }),
        });

  const entries: LayerEntry[] = [];
  const parser = yield* Effect.acquireRelease(
    Effect.sync(() => new TarParser((entry) => entries.push(entry))),
    (parser) => Effect.sync(() => parser.destroy()),
  );
  const parseChunk = Effect.fn("indexLayer.parseChunk")(function* (chunk: Uint8Array) {
    yield* Effect.tryPromise({
      try: () => parser.push(chunk),
      catch: (cause) =>
        new TarError({ message: `reading ${layer.digest} failed: ${String(cause)}` }),
    });
  });
  const finishParsing = Effect.tryPromise({
    try: () => parser.end(),
    catch: (cause) => new TarError({ message: `reading ${layer.digest} failed: ${String(cause)}` }),
  });
  yield* storage.writeStream(
    layerTarKey(layer.digest),
    tar.pipe(Stream.tap(parseChunk), Stream.onEnd(finishParsing)),
  );
  yield* storage.putJson(layerIndexKey(layer.digest), entries, {
    customMetadata: { [ENTRY_COUNT_METADATA]: String(entries.length) },
  });
}, Effect.scoped);

/**
 * Merges the indexed layers into the image's final file tree and publishes one
 * listing per directory. The ready marker is written last, so readers that see
 * it can rely on every listing existing.
 */
const publishImage = Effect.fn("publishImage")(function* (
  manifestDigest: string,
  layers: ReadonlyArray<LayerDescriptor>,
) {
  const storage = yield* Storage;

  const counts = yield* Effect.forEach(layers, (layer) =>
    storage.head(layerIndexKey(layer.digest)),
  );
  const entryCount = counts.reduce(
    (total, object) => total + Number(object?.customMetadata?.[ENTRY_COUNT_METADATA] ?? 0),
    0,
  );
  if (entryCount > MAX_IMAGE_ENTRIES) {
    return yield* new UnsupportedImage({
      message: `the image has ${entryCount} files, more than the supported ${MAX_IMAGE_ENTRIES}`,
    });
  }

  const root = newDirectory();
  for (const [index, layer] of layers.entries()) {
    const entries = yield* storage.getJson(layerIndexKey(layer.digest), LayerIndex);
    if (entries === undefined)
      return yield* new TarError({ message: `layer ${layer.digest} has not been indexed` });
    applyLayer(root, entries, index);
  }

  yield* Effect.forEach(
    directories(root),
    (directory) =>
      directoryKey(manifestDigest, directory.path).pipe(
        Effect.flatMap((key) => storage.putJson(key, { entries: directory.entries })),
      ),
    { concurrency: PUBLISH_CONCURRENCY, discard: true },
  );
  const marker: ReadyMarker = { layers: layers.map((layer) => layer.digest) };
  yield* storage.putJson(readyKey(manifestDigest), marker);
});

/** Progress is informational, so failing to record it never fails indexing. */
const reportProgress = Effect.fn("reportProgress")(function* (
  manifestDigest: string,
  progress: StoredProgress,
) {
  const storage = yield* Storage;
  yield* storage.putProgress(manifestDigest, progress).pipe(Effect.ignore);
});

/** Runs a step's Effect, turning failures that a retry cannot fix into a NonRetryableError. */
const runStep = async <A, E>(effect: Effect.Effect<A, E, Registry | Storage>) => {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.squash(exit.cause);
  if (error instanceof UnsupportedImage) throw new NonRetryableError(error.message);
  throw error instanceof Error ? error : new Error(String(error));
};

/** Returns the decompressor for a layer, or undefined when the layer is a plain tar. */
const layerDecompressor = (mediaType: string) => {
  if (mediaType.endsWith("gzip")) return Effect.succeed(() => new DecompressionStream("gzip"));
  if (mediaType.endsWith("zstd")) return Effect.succeed(zstdDecompressionStream);
  if (mediaType.endsWith("tar")) return Effect.succeed(undefined);
  return Effect.fail(
    new UnsupportedImage({ message: `layer media type ${mediaType} is not supported` }),
  );
};

/** fzstd decompresses in plain JavaScript, because `DecompressionStream` does not support zstd. */
const zstdDecompressionStream = () => {
  let decompressor: Decompress | undefined;
  return new TransformStream<Uint8Array, Uint8Array>({
    start: (controller) => {
      decompressor = new Decompress((chunk) => controller.enqueue(chunk));
    },
    transform: (chunk) => decompressor?.push(chunk),
    flush: () => decompressor?.push(new Uint8Array(0), true),
  });
};

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Registry.layer, Storage.layer).pipe(Layer.provideMerge(Observability)),
);

const STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "30 minutes",
};

/** Above this, the merged file tree risks exceeding the Worker's 128 MB memory limit. */
const MAX_IMAGE_ENTRIES = 300_000;
const ENTRY_COUNT_METADATA = "entryCount";
const PUBLISH_CONCURRENCY = 6;
const PROGRESS_INTERVAL_MS = 2000;

const LayerIndex = Schema.Array(LayerEntry);

class TarError extends Schema.TaggedError<TarError>()("TarError", {
  message: Schema.String,
}) {}
