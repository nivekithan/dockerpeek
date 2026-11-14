import { CacheableResponse } from "@docker-viewer/contract";
import { Context, Effect, Layer } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

/** Required per invocation; missing request wiring must not silently change cache behavior. */
export const WaitUntil = Context.Reference<(promise: Promise<unknown>) => void>(
  "docker-viewer/HttpCache/WaitUntil",
  {
    defaultValue: () => {
      throw new Error("WaitUntil must be supplied for each request");
    },
  },
);

export const HttpResponseCache = Layer.succeed(CacheableResponse, (handler) =>
  cacheResponse(handler),
);

const cacheResponse = Effect.fn("HttpResponseCache")(function* <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.fn.Return<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.originalUrl);
  if (request.method !== "GET") return yield* handler;

  url.pathname = `/v2${url.pathname}`;
  const cacheKey = url.href;
  const cached = yield* Effect.tryPromise(() => caches.default.match(cacheKey)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (cached !== undefined) return HttpServerResponse.fromWeb(cached);

  const response = yield* handler;
  if (response.status !== 200) return response;
  const immutable = HttpServerResponse.setHeader(response, "cache-control", IMMUTABLE);
  const web = HttpServerResponse.toWeb(immutable);
  const length = web.headers.get("content-length");
  const size = length === null ? undefined : Number(length);
  if (size !== undefined && Number.isSafeInteger(size) && size >= 0 && size <= MAX_CACHED_BYTES) {
    const waitUntil = yield* WaitUntil;
    // Both synchronous cache errors and rejected writes must leave the response usable.
    yield* Effect.try(() =>
      waitUntil(caches.default.put(cacheKey, web.clone()).catch(() => {})),
    ).pipe(Effect.ignore);
  }
  // clone() tees a raw stream; return the Web response's branch, not its now-locked source.
  return HttpServerResponse.fromWeb(web);
});

const IMMUTABLE = "public, max-age=31536000, immutable";
const MAX_CACHED_BYTES = 100 * 1024 * 1024;
