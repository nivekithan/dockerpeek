import { Digest, EntryType } from "@docker-viewer/contract";
import { env } from "cloudflare:workers";
import { Context, Effect, Layer, Schema, Stream } from "effect";

export class Storage extends Context.Service<
  Storage,
  {
    getReadyMarker(manifestDigest: string): Effect.Effect<ReadyMarker | undefined, StorageError>;
    /** Changes while indexing runs, so it must never be served from a cache. */
    getProgress(manifestDigest: string): Effect.Effect<StoredProgress | undefined, StorageError>;
    putProgress(
      manifestDigest: string,
      progress: StoredProgress,
    ): Effect.Effect<void, StorageError>;
    head(key: string): Effect.Effect<R2Object | null, StorageError>;
    getJson<S extends Schema.Top & { readonly DecodingServices: never }>(
      key: string,
      schema: S,
    ): Effect.Effect<S["Type"] | undefined, StorageError>;
    putJson(key: string, value: unknown, options?: R2PutOptions): Effect.Effect<void, StorageError>;
    getRange(
      key: string,
      offset: number,
      length: number,
    ): Effect.Effect<ReadableStream<Uint8Array> | undefined, StorageError>;
    /** Streams bytes of unknown total length into one object, using a multipart upload when needed. */
    writeStream<E>(
      key: string,
      stream: Stream.Stream<Uint8Array, E>,
    ): Effect.Effect<void, E | StorageError>;
  }
>()("docker-viewer/Storage") {
  static readonly layer = Layer.effect(
    Storage,
    Effect.sync(() => {
      const services = Context.make(StorageBucket, env.STORAGE);
      return Storage.of({
        getReadyMarker: (digest) => getReadyMarker(digest).pipe(Effect.provide(services)),
        getProgress: (digest) =>
          getJson(progressKey(digest), StoredProgress).pipe(Effect.provide(services)),
        putProgress: (digest, progress) =>
          putJson(progressKey(digest), progress).pipe(Effect.provide(services)),
        head: (key) => head(key).pipe(Effect.provide(services)),
        getJson: (key, schema) => getJson(key, schema).pipe(Effect.provide(services)),
        putJson: (key, value, options) =>
          putJson(key, value, options).pipe(Effect.provide(services)),
        getRange: (key, offset, length) =>
          getRange(key, offset, length).pipe(Effect.provide(services)),
        writeStream: (key, stream) => writeStream(key, stream).pipe(Effect.provide(services)),
      });
    }),
  );
}

export const layerTarKey = (layerDigest: string) => `v2/layers/${layerDigest}/layer.tar`;
export const layerIndexKey = (layerDigest: string) => `v2/layers/${layerDigest}/index.json`;
export const readyKey = (manifestDigest: string) => `v2/images/${manifestDigest}/ready.json`;
const progressKey = (manifestDigest: string) => `v2/images/${manifestDigest}/progress.json`;

/** Directory paths are hashed so that deep paths never exceed key length limits. */
export const directoryKey = (manifestDigest: string, path: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(path))).pipe(
    Effect.map((hash) => {
      const hex = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      return `v2/images/${manifestDigest}/dirs/${hex}.json`;
    }),
  );

/** One tar entry of a layer, with the byte offset of its data in the decompressed layer tar. */
export const LayerEntry = Schema.Struct({
  path: Schema.String,
  type: EntryType,
  mode: Schema.Number,
  size: Schema.Number,
  linkTarget: Schema.optional(Schema.String),
  offset: Schema.Number,
});
export type LayerEntry = typeof LayerEntry.Type;

/** One entry of a published directory listing. `layer` and `offset` locate the file bytes. */
export const StoredDirEntry = Schema.Struct({
  name: Schema.String,
  type: EntryType,
  mode: Schema.Number,
  size: Schema.Number,
  linkTarget: Schema.optional(Schema.String),
  layer: Schema.optional(Schema.Number),
  offset: Schema.optional(Schema.Number),
});
export type StoredDirEntry = typeof StoredDirEntry.Type;

export const StoredDirListing = Schema.Struct({
  entries: Schema.Array(StoredDirEntry),
});

/** Written last by the indexer: its presence means every directory listing is published. */
export const ReadyMarker = Schema.Struct({
  layers: Schema.Array(Digest),
});
export type ReadyMarker = typeof ReadyMarker.Type;

/** Written by the indexer while it runs. Layers are indexed in order, one at a time. */
export const StoredProgress = Schema.Struct({
  phase: Schema.Literals(["downloading", "publishing"]),
  layerSizes: Schema.Array(Schema.Number),
  /** 0-based index of the layer being downloaded. */
  layer: Schema.Number,
  /** Compressed bytes of that layer downloaded so far. */
  layerBytes: Schema.Number,
});
export type StoredProgress = typeof StoredProgress.Type;

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  message: Schema.String,
}) {}

const getReadyMarker = Effect.fn("Storage.getReadyMarker")(function* (manifestDigest: string) {
  return yield* getJson(readyKey(manifestDigest), ReadyMarker);
});

const head = Effect.fn("Storage.head")(function* (key: string) {
  const bucket = yield* StorageBucket;
  return yield* r2("head", () => bucket.head(key));
});

const getJson = Effect.fn("Storage.getJson")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(key: string, schema: S): Effect.fn.Return<S["Type"] | undefined, StorageError, StorageBucket> {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  const bucket = yield* StorageBucket;
  const object = yield* r2("get", () => bucket.get(key));
  if (object === null) return undefined;
  const text = yield* r2("read", () => object.text());
  return yield* decode(text).pipe(
    Effect.mapError(
      (cause) =>
        new StorageError({
          message: `invalid JSON in ${key}: ${cause.message}`,
        }),
    ),
  );
});

const putJson = Effect.fn("Storage.putJson")(function* (
  key: string,
  value: unknown,
  options?: R2PutOptions,
) {
  const bucket = yield* StorageBucket;
  yield* r2("put", () => bucket.put(key, JSON.stringify(value), options));
});

const getRange = Effect.fn("Storage.getRange")(function* (
  key: string,
  offset: number,
  length: number,
) {
  const bucket = yield* StorageBucket;
  const object = yield* r2("get", () => bucket.get(key, { range: { offset, length } }));
  return object?.body;
});

const writeStream = Effect.fn("Storage.writeStream")(function* <E>(
  key: string,
  stream: Stream.Stream<Uint8Array, E>,
) {
  const bucket = yield* StorageBucket;
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  let buffer = new Uint8Array(PART_SIZE);
  let filled = 0;

  const uploadPart = Effect.gen(function* () {
    const current =
      upload ?? (yield* r2("create multipart upload", () => bucket.createMultipartUpload(key)));
    upload = current;
    const part = buffer.subarray(0, filled);
    buffer = new Uint8Array(PART_SIZE);
    filled = 0;
    parts.push(yield* r2("upload part", () => current.uploadPart(parts.length + 1, part)));
  });

  const write = Effect.fn("Storage.writeStream.write")(function* (chunk: Uint8Array) {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(PART_SIZE - filled, chunk.length - offset);
      buffer.set(chunk.subarray(offset, offset + count), filled);
      filled += count;
      offset += count;
      if (filled === PART_SIZE) yield* uploadPart;
    }
  });

  yield* Effect.gen(function* () {
    yield* Stream.runForEach(stream, write);
    if (upload === undefined) {
      const body = buffer.subarray(0, filled);
      yield* r2("put", () => bucket.put(key, body));
      return;
    }
    if (filled > 0) yield* uploadPart;
    const completed = upload;
    yield* r2("complete multipart upload", () => completed.complete(parts));
  }).pipe(
    Effect.onError(() => {
      const pendingUpload = upload;
      return pendingUpload === undefined
        ? Effect.void
        : Effect.ignore(r2("abort multipart upload", () => pendingUpload.abort()));
    }),
  );
});

const r2 = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new StorageError({ message: `R2 ${operation} failed: ${String(cause)}` }),
  });

class StorageBucket extends Context.Service<StorageBucket, R2Bucket>()(
  "docker-viewer/Storage/Bucket",
) {}

/** R2 requires every multipart part except the last to have the same size, of at least 5 MiB. */
const PART_SIZE = 8 * 1024 * 1024;
