import { RegistryError } from "@docker-viewer/contract";
import { parse } from "auth-header";
import { env } from "cloudflare:workers";
import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { initLoggerLayer, set, useLogger, withLogger } from "evlog/effect";

/** Registry HTTP client with safe redirects, anonymous authentication, and shared KV tokens. */
export class RegistryHttpClient extends Context.Service<
  RegistryHttpClient,
  HttpClient.HttpClient.With<RegistryError>
>()("docker-viewer/Registry/HttpClient") {
  static readonly layer = Layer.effect(
    RegistryHttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const transport = client.pipe(
        HttpClient.followRedirects(MAX_REDIRECTS),
        HttpClient.transformResponse((response) =>
          response.pipe(
            // Effect must follow redirects, rather than Workers forwarding sensitive headers.
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.mapError(
              (cause) =>
                new RegistryError({
                  message: `request to ${cause.request.url} failed: ${cause.message}`,
                }),
            ),
          ),
        ),
      );
      const services = (yield* Effect.context<HttpClient.HttpClient>()).pipe(
        Context.pick(HttpClient.HttpClient),
        Context.add(RegistryTransport, transport),
        Context.add(RegistryTokens, env.REGISTRY_TOKENS),
      );
      return transport.pipe(
        HttpClient.transform((response, request) =>
          authorize(response, request).pipe(
            Effect.tap((response) => set<RegistryRequestEvent>({ status: response.status })),
            withLogger("registry.request", {
              fields: {
                registry: URL.parse(request.url)?.hostname ?? "invalid",
                method: request.method,
                auth: { required: false },
              } satisfies RegistryRequestEvent,
            }),
            Effect.provide(services),
          ),
        ),
      );
    }),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      initLoggerLayer({
        env: { service: "docker-viewer-api" },
        pretty: false,
        stringify: false,
      }),
    ),
  );
}

/** Token requests and retries use the transport directly, avoiding recursive authentication. */
const authorize = Effect.fn("RegistryHttpClient.authorize")(function* (
  initialResponse: Effect.Effect<HttpClientResponse.HttpClientResponse, RegistryError>,
  request: HttpClientRequest.HttpClientRequest,
) {
  const log = yield* useLogger<RegistryRequestEvent>();
  const response = yield* initialResponse;
  if (response.status !== 401) return response;
  log.set({ auth: { required: true } });
  const challenge = parseBearerChallenge(response.headers["www-authenticate"]);
  if (challenge === undefined) {
    log.set({ auth: { challenge: "unsupported" } });
    return yield* new RegistryError({ message: "registry requires credentials" });
  }
  log.set({ auth: { challenge: "bearer" } });
  yield* discardResponse(response);
  const client = yield* RegistryTransport;
  const { token, fromCache } = yield* fetchToken(challenge);
  const authenticated = yield* client.execute(HttpClientRequest.bearerToken(request, token));
  if (authenticated.status !== 401) return authenticated;
  if (!fromCache) {
    log.set({ auth: { freshTokenRejected: true } });
    return authenticated;
  }
  log.set({ auth: { cachedTokenRejected: true, refreshAttempted: true } });
  yield* discardResponse(authenticated);
  const fresh = yield* fetchToken(challenge, true);
  const retried = yield* client.execute(HttpClientRequest.bearerToken(request, fresh.token));
  log.set({ auth: { freshTokenRejected: retried.status === 401 } });
  return retried;
});

const fetchToken = Effect.fn("RegistryHttpClient.fetchToken")(function* (
  challenge: BearerChallenge,
  forceRefresh = false,
) {
  const log = yield* useLogger<RegistryRequestEvent>();
  const record = (fields: Partial<TokenAttempt>) => {
    log.set({
      tokens: forceRefresh ? { refresh: fields } : { initial: fields },
    });
  };
  record({ stage: "validate_endpoint" });
  const url = URL.parse(challenge.realm);
  if (url === null || url.protocol !== "https:" || url.username || url.password) {
    return yield* new RegistryError({ message: "registry sent an invalid token endpoint" });
  }
  if (challenge.service !== undefined) url.searchParams.set("service", challenge.service);
  if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope);
  const cache = yield* RegistryTokens;
  const key = yield* tokenCacheKey(url);
  record({ host: url.hostname, cacheKey: key });
  yield* Effect.annotateCurrentSpan({ "server.address": url.hostname, "cache.key": key });
  if (!forceRefresh) {
    // KV is an optimization: misses, invalid values, and outages must not prevent a pull.
    const cached = yield* Effect.tryPromise(() => cache.get(key)).pipe(Effect.option);
    if (Option.isSome(cached) && cached.value !== null) {
      const decoded = yield* Schema.decodeUnknownEffect(CachedToken)(cached.value).pipe(
        Effect.option,
      );
      if (Option.isSome(decoded) && decoded.value.expiresAt > (yield* Clock.currentTimeMillis)) {
        record({ cache: "hit", stage: "complete" });
        return { token: decoded.value.token, fromCache: true };
      }
      record({ cache: Option.isSome(decoded) ? "expired" : "invalid" });
    } else {
      record({ cache: Option.isSome(cached) ? "miss" : "read_failed" });
    }
  } else {
    record({ cache: "bypassed" });
  }
  record({ stage: "fetch", fetchAttempted: true });
  const requestedAt = yield* Clock.currentTimeMillis;
  const client = yield* RegistryTransport;
  const response = yield* client.get(url);
  record({ status: response.status });
  if (response.status !== 200) {
    return yield* new RegistryError({
      message: `token endpoint responded with ${response.status}`,
    });
  }
  record({ stage: "decode_response" });
  const body = yield* response.text.pipe(
    Effect.mapError((cause) => new RegistryError({ message: cause.message })),
  );
  const decoded = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
    Effect.mapError(
      () => new RegistryError({ message: "token endpoint returned an unexpected body" }),
    ),
  );
  const token = decoded.token ?? decoded.access_token;
  if (token === undefined)
    return yield* new RegistryError({ message: "token endpoint returned no token" });
  const issuedAt =
    decoded.issued_at === undefined ? requestedAt : DateTime.toEpochMillis(decoded.issued_at);
  const expiresAt =
    issuedAt +
    (decoded.expires_in ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000 -
    TOKEN_EXPIRY_MARGIN_MS;
  // Do not extend short-lived tokens just to meet KV's minimum 60-second expiration.
  if (
    Math.floor(expiresAt / 1000) - Math.ceil((yield* Clock.currentTimeMillis) / 1000) >=
    MIN_KV_TTL_SECONDS
  ) {
    record({ stage: "cache_write" });
    yield* Effect.tryPromise(() =>
      cache.put(key, JSON.stringify({ token, expiresAt }), {
        expiration: Math.floor(expiresAt / 1000),
      }),
    ).pipe(
      Effect.tap(() => Effect.sync(() => record({ write: "stored" }))),
      Effect.tapError(() => Effect.sync(() => record({ write: "failed" }))),
      Effect.ignore,
    );
  } else {
    record({ write: "skipped_short_ttl" });
  }
  record({ stage: "complete" });
  return { token, fromCache: false };
});

interface RegistryRequestEvent {
  registry?: string;
  method?: string;
  status?: number;
  auth?: {
    required?: boolean;
    challenge?: "bearer" | "unsupported";
    cachedTokenRejected?: boolean;
    freshTokenRejected?: boolean;
    refreshAttempted?: boolean;
  };
  tokens?: { initial?: TokenAttempt; refresh?: TokenAttempt };
}

interface TokenAttempt {
  host?: string;
  cacheKey?: string;
  cache?: "hit" | "miss" | "expired" | "invalid" | "read_failed" | "bypassed";
  write?: "stored" | "failed" | "skipped_short_ttl";
  fetchAttempted?: boolean;
  status?: number;
  stage?: "validate_endpoint" | "fetch" | "decode_response" | "cache_write" | "complete";
}

const tokenCacheKey = (url: URL) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href))).pipe(
    Effect.map(
      (hash) =>
        `token:sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    ),
  );

const discardResponse = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.tryPromise({
    try: async () => {
      const web = HttpClientResponse.toWeb(response);
      if (Option.isSome(web)) await web.value.body?.cancel();
    },
    catch: (cause) => new RegistryError({ message: String(cause) }),
  });

/** auth-header supports a single challenge; reject token68 and repeated/ambiguous parameters. */
const parseBearerChallenge = (header: string | undefined): BearerChallenge | undefined => {
  if (header === undefined) return undefined;
  try {
    const challenge = parse(header);
    if (challenge.scheme.toLowerCase() !== "bearer" || challenge.token !== null) return undefined;
    const parameters: Record<string, string> = {};
    for (const [name, value] of Object.entries(challenge.params)) {
      const key = name.toLowerCase();
      if (typeof value !== "string" || Object.hasOwn(parameters, key)) return undefined;
      parameters[key] = value;
    }
    return Schema.decodeUnknownSync(BearerChallenge)(parameters);
  } catch {
    return undefined;
  }
};

class RegistryTransport extends Context.Service<
  RegistryTransport,
  HttpClient.HttpClient.With<RegistryError>
>()("docker-viewer/Registry/Transport") {}

class RegistryTokens extends Context.Service<RegistryTokens, KVNamespace>()(
  "docker-viewer/Registry/Tokens",
) {}

const BearerChallenge = Schema.Struct({
  realm: Schema.String,
  service: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});
type BearerChallenge = typeof BearerChallenge.Type;

const TokenResponse = Schema.fromJsonString(
  Schema.Struct({
    token: Schema.optional(Schema.String),
    access_token: Schema.optional(Schema.String),
    expires_in: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    issued_at: Schema.optional(Schema.DateTimeUtcFromString),
  }),
);

const CachedToken = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, expiresAt: Schema.Number }),
);
const MAX_REDIRECTS = 5;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;
const MIN_KV_TTL_SECONDS = 60;
