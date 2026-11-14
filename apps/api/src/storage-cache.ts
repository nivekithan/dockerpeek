import { Context, Effect, Layer, Schema } from "effect";
import { ReadyMarker, readyKey, Storage, type StorageError } from "./storage.ts";

/** API-only read-through cache for immutable JSON metadata; all other operations pass through. */
export const CachedStorage = Layer.effect(
  Storage,
  Effect.gen(function* () {
    const storage = yield* Storage;
    const services = (yield* Effect.context<Storage>()).pipe(Context.pick(Storage));
    return Storage.of({
      ...storage,
      getJson: (key, schema) => getJson(key, schema).pipe(Effect.provide(services)),
      getReadyMarker: (digest) =>
        getJson(readyKey(digest), ReadyMarker).pipe(Effect.provide(services)),
    });
  }),
).pipe(Layer.provide(Storage.layer));

const getJson = Effect.fn("CachedStorage.getJson")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(key: string, schema: S): Effect.fn.Return<S["Type"] | undefined, StorageError, Storage> {
  const cacheUrl = `https://docker-viewer-api.internal/${key}`;
  const cached = yield* Effect.tryPromise(async () => {
    const response = await caches.default.match(cacheUrl);
    return response?.text();
  }).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toType(schema)))(text),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (cached !== undefined) return cached;

  const storage = yield* Storage;
  const value = yield* storage.getJson(key, schema);
  // Never cache absence: indexing may publish this object immediately after the read.
  if (value === undefined) return undefined;
  yield* Effect.tryPromise(() =>
    caches.default.put(
      cacheUrl,
      Response.json(value, {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      }),
    ),
  ).pipe(Effect.ignore);
  return value;
});
