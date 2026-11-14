import {
  Digest,
  ImageNotFound,
  InvalidImageReference,
  PlatformNotFound,
  RegistryError,
  UnsupportedImage,
} from "@docker-viewer/contract";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import type { HttpClientResponse } from "effect/http";
import { RegistryHttpClient } from "./registry-client.ts";

export const Platform = Schema.Struct({
  os: Schema.String,
  architecture: Schema.String,
  variant: Schema.optional(Schema.String),
});
export type Platform = typeof Platform.Type;

export const LayerDescriptor = Schema.Struct({
  digest: Digest,
  mediaType: Schema.String,
});
export type LayerDescriptor = typeof LayerDescriptor.Type;

export interface ImageReference {
  readonly registry: string;
  readonly repository: string;
  /** A tag such as `latest`, or a digest such as `sha256:...`. */
  readonly selector: string;
}

export type Repository = Pick<ImageReference, "registry" | "repository">;

export class Registry extends Context.Service<
  Registry,
  {
    resolve(
      imageReference: ImageReference,
      platform: Platform,
    ): Effect.Effect<string, ImageNotFound | PlatformNotFound | UnsupportedImage | RegistryError>;
    layers(
      repository: Repository,
      manifestDigest: string,
    ): Effect.Effect<
      ReadonlyArray<LayerDescriptor>,
      ImageNotFound | UnsupportedImage | RegistryError
    >;
    blob(
      repository: Repository,
      digest: string,
    ): Effect.Effect<Stream.Stream<Uint8Array, RegistryError>, RegistryError>;
  }
>()("docker-viewer/Registry") {
  static readonly layer = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const services = (yield* Effect.context<RegistryHttpClient>()).pipe(
        Context.pick(RegistryHttpClient),
      );
      return Registry.of({
        resolve: (imageReference, platform) =>
          resolve(imageReference, platform).pipe(Effect.provide(services)),
        layers: (repository, digest) => layers(repository, digest).pipe(Effect.provide(services)),
        blob: (repository, digest) => blob(repository, digest).pipe(Effect.provide(services)),
      });
    }),
  ).pipe(Layer.provide(RegistryHttpClient.layer));
}

const resolve = Effect.fn("Registry.resolve")(function* (
  imageReference: ImageReference,
  wanted: Platform,
) {
  const top = yield* fetchManifest(imageReference);
  if ("manifests" in top.document) {
    const candidates = top.document.manifests.flatMap((entry) =>
      entry.platform === undefined || entry.platform.os === "unknown"
        ? []
        : [{ digest: entry.digest, platform: entry.platform }],
    );
    const match = candidates.find((candidate) => platformMatches(candidate.platform, wanted));
    if (match === undefined) {
      return yield* new PlatformNotFound({
        platform: formatPlatform(wanted),
        available: candidates.map((candidate) => formatPlatform(candidate.platform)),
      });
    }
    const child = yield* fetchManifest({ ...imageReference, selector: match.digest });
    if ("manifests" in child.document)
      return yield* new UnsupportedImage({
        message: "nested image indexes are not supported",
      });
    return child.digest;
  }
  const platform = yield* fetchConfigPlatform(imageReference, top.document.config.digest);
  if (!platformMatches(platform, wanted)) {
    return yield* new PlatformNotFound({
      platform: formatPlatform(wanted),
      available: [formatPlatform(platform)],
    });
  }
  return top.digest;
});

const layers = Effect.fn("Registry.layers")(function* (
  repository: Repository,
  manifestDigest: string,
) {
  const manifest = yield* fetchManifest({ ...repository, selector: manifestDigest });
  if ("manifests" in manifest.document)
    return yield* new UnsupportedImage({ message: `${manifestDigest} is an image index` });
  return manifest.document.layers;
});

/** Streams verified blob bytes through the authenticated registry client. */
const blob = Effect.fn("Registry.blob")(function* (repository: Repository, digest: string) {
  const client = yield* RegistryHttpClient;
  const response = yield* client.get(`${baseUrl(repository)}/blobs/${digest}`);
  yield* ensureOk(response);
  return response.stream.pipe(
    Stream.mapError(
      (cause) => new RegistryError({ message: `downloading ${digest} failed: ${cause.message}` }),
    ),
    verifyBlob(digest),
  );
});

const fetchManifest = Effect.fn("Registry.fetchManifest")(function* (
  imageReference: ImageReference,
) {
  const { selector } = imageReference;
  const client = yield* RegistryHttpClient;
  const response = yield* client.get(`${baseUrl(imageReference)}/manifests/${selector}`, {
    headers: { accept: MANIFEST_MEDIA_TYPES },
  });
  // Registries answer 401 even with a pull token when a repository does not exist or is private.
  if (response.status === 404 || response.status === 401) {
    return yield* new ImageNotFound({
      imageReference: `${imageReference.registry}/${imageReference.repository}${selector.startsWith("sha256:") ? "@" : ":"}${selector}`,
    });
  }
  yield* ensureOk(response);
  const bytes = yield* response.arrayBuffer.pipe(
    Effect.mapError((cause) => new RegistryError({ message: cause.message })),
  );
  const digest = yield* sha256Digest(bytes);
  if (selector.startsWith("sha256:") && selector !== digest) {
    return yield* new RegistryError({
      message: `manifest digest mismatch: expected ${selector}, received ${digest}`,
    });
  }
  const document = yield* Schema.decodeUnknownEffect(ManifestDocument)(
    new TextDecoder().decode(bytes),
  ).pipe(
    Effect.mapError(
      () => new UnsupportedImage({ message: "the image manifest uses an unsupported format" }),
    ),
  );
  if ("config" in document && !IMAGE_CONFIG_MEDIA_TYPES.has(document.config.mediaType)) {
    return yield* new UnsupportedImage({
      message: `config media type ${document.config.mediaType} is not a container image`,
    });
  }
  return { digest, document };
});

const fetchConfigPlatform = Effect.fn("Registry.fetchConfigPlatform")(function* (
  repository: Repository,
  digest: string,
) {
  const body = yield* blob(repository, digest).pipe(
    Effect.flatMap((stream) => Stream.mkString(Stream.decodeText(stream))),
  );
  return yield* Schema.decodeUnknownEffect(ImageConfigDocument)(body).pipe(
    Effect.mapError(
      () => new UnsupportedImage({ message: "the image config does not declare a platform" }),
    ),
  );
});

/**
 * Parses references the way `docker pull` does: `alpine`, `bitnami/redis:7`,
 * `ghcr.io/owner/app@sha256:...`.
 */
export const parseImageReference = Effect.fn("Registry.parseImageReference")(function* (
  input: string,
) {
  const invalid = new InvalidImageReference({ imageReference: input });
  const [nameAndTag = "", digest, ...extra] = input.split("@");
  if (extra.length > 0 || /\s/.test(input) || /^[a-f0-9]{64}$/.test(input)) return yield* invalid;

  const lastSlash = nameAndTag.lastIndexOf("/");
  const tagSeparator = nameAndTag.indexOf(":", lastSlash + 1);
  const name = tagSeparator === -1 ? nameAndTag : nameAndTag.slice(0, tagSeparator);
  const tag = tagSeparator === -1 ? undefined : nameAndTag.slice(tagSeparator + 1);

  const [first = "", ...rest] = name.split("/");
  const hasRegistry =
    rest.length > 0 &&
    (first.includes(".") ||
      first.includes(":") ||
      first === "localhost" ||
      first !== first.toLowerCase());
  const registry = hasRegistry ? first : "docker.io";
  const path = hasRegistry ? rest.join("/") : name;
  const isDockerHub = DOCKER_HUB_ALIASES.has(registry);
  const repository = isDockerHub && !path.includes("/") ? `library/${path}` : path;
  const selector = digest ?? tag ?? "latest";

  if (
    !REGISTRY_PATTERN.test(registry) ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository.length > 255
  )
    return yield* invalid;
  if (tag !== undefined && !TAG_PATTERN.test(tag)) return yield* invalid;
  if (digest !== undefined && !DIGEST_PATTERN.test(digest)) return yield* invalid;

  return {
    registry: isDockerHub ? DOCKER_HUB_REGISTRY : registry,
    repository,
    selector,
  } satisfies ImageReference;
});

export const formatPlatform = (platform: Platform) =>
  [platform.os, platform.architecture, platform.variant]
    .filter((part) => part !== undefined)
    .join("/");

const platformMatches = (candidate: Platform, wanted: Platform) =>
  candidate.os === wanted.os &&
  candidate.architecture === wanted.architecture &&
  normalizeVariant(candidate) === normalizeVariant(wanted);

const normalizeVariant = (platform: Platform) =>
  platform.variant ?? DEFAULT_VARIANTS[platform.architecture];

/**
 * The variant an architecture implies when none is given, as containerd and Docker normalize it:
 * `linux/arm64` is `linux/arm64/v8`, `linux/arm` is `linux/arm/v7` and `linux/amd64` is the
 * `v1` baseline. Other variants, such as amd64 `v3`, only match when requested explicitly.
 */
const DEFAULT_VARIANTS: Record<string, string | undefined> = {
  amd64: "v1",
  arm64: "v8",
  arm: "v7",
};

const baseUrl = (repository: Repository) =>
  `https://${repository.registry}/v2/${repository.repository}`;

const ensureOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(
        new RegistryError({
          message: `${response.request.url} responded with ${response.status}`,
        }),
      );

const sha256Digest = (bytes: BufferSource) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map(
      (hash) =>
        `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    ),
  );

/** Hash compressed registry bytes, and fail at EOF before an upload can be committed. */
const verifyBlob = (expected: string) => (source: Stream.Stream<Uint8Array, RegistryError>) =>
  Stream.unwrap(
    Effect.sync(() => {
      const digest = new crypto.DigestStream("SHA-256");
      // digest rejects on abort too; attach a handler even if the stream never reaches EOF.
      const result = digest.digest.then(
        (hash) => ({ hash }),
        () => ({ hash: undefined }),
      );
      const writer = digest.getWriter();
      let closed = false;
      const verify = Effect.tryPromise({
        try: async () => {
          await writer.close();
          closed = true;
          const { hash } = await result;
          if (hash === undefined) throw new Error("digest stream failed");
          const actual = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          if (actual !== expected)
            throw new Error(`blob digest mismatch: expected ${expected}, received ${actual}`);
        },
        catch: (cause) => new RegistryError({ message: String(cause) }),
      });
      return source.pipe(
        Stream.tap((chunk) =>
          Effect.tryPromise({
            try: () => writer.write(chunk),
            catch: (cause) => new RegistryError({ message: String(cause) }),
          }),
        ),
        Stream.concat(Stream.fromEffectDrain(verify)),
        Stream.ensuring(
          Effect.promise(async () => {
            if (!closed) await writer.abort().catch(() => {});
          }),
        ),
      );
    }),
  );

const MANIFEST_MEDIA_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const IMAGE_CONFIG_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

const ImageIndexDocument = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  manifests: Schema.Array(Schema.Struct({ digest: Digest, platform: Schema.optional(Platform) })),
});
const ImageManifestDocument = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  config: Schema.Struct({ digest: Digest, mediaType: Schema.String }),
  layers: Schema.Array(LayerDescriptor),
});
const ManifestDocument = Schema.fromJsonString(
  Schema.Union([ImageIndexDocument, ImageManifestDocument]),
);
const ImageConfigDocument = Schema.fromJsonString(Platform);
const DOCKER_HUB_REGISTRY = "registry-1.docker.io";
const DOCKER_HUB_ALIASES = new Set(["docker.io", "index.docker.io"]);
const REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

// distribution/reference's domainAndPort: DNS name or bracketed IPv6, optional numeric port.
const REGISTRY_PATTERN =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/;
