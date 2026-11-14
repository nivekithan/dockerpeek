import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/http-api";

export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));

export const ImageStatus = Schema.Literals(["indexing", "ready", "failed", "not_found"]);
export type ImageStatus = typeof ImageStatus.Type;

export const EntryType = Schema.Literals(["file", "directory", "symlink", "hardlink", "other"]);
export type EntryType = typeof EntryType.Type;

export class InvalidImageReference extends Schema.TaggedError<InvalidImageReference>()(
  "InvalidImageReference",
  { imageReference: Schema.String },
  { httpApiStatus: 400 },
) {}

export class ImageNotFound extends Schema.TaggedError<ImageNotFound>()(
  "ImageNotFound",
  { imageReference: Schema.String },
  { httpApiStatus: 404 },
) {}

export class PlatformNotFound extends Schema.TaggedError<PlatformNotFound>()(
  "PlatformNotFound",
  { platform: Schema.String, available: Schema.Array(Schema.String) },
  { httpApiStatus: 404 },
) {}

/** The image can never be indexed, for example because it uses zstd layers. */
export class UnsupportedImage extends Schema.TaggedError<UnsupportedImage>()(
  "UnsupportedImage",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}

export class RegistryError extends Schema.TaggedError<RegistryError>()(
  "RegistryError",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

export class ImageNotReady extends Schema.TaggedError<ImageNotReady>()(
  "ImageNotReady",
  { status: ImageStatus },
  { httpApiStatus: 409 },
) {}

export class PathNotFound extends Schema.TaggedError<PathNotFound>()(
  "PathNotFound",
  { path: Schema.String },
  { httpApiStatus: 404 },
) {}

export class InvalidPlatform extends Schema.TaggedError<InvalidPlatform>()(
  "InvalidPlatform",
  { platform: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotADirectory extends Schema.TaggedError<NotADirectory>()(
  "NotADirectory",
  { path: Schema.String },
  { httpApiStatus: 400 },
) {}

export class NotAFile extends Schema.TaggedError<NotAFile>()(
  "NotAFile",
  { path: Schema.String },
  { httpApiStatus: 400 },
) {}

export class PreviewTooLarge extends Schema.TaggedError<PreviewTooLarge>()(
  "PreviewTooLarge",
  { path: Schema.String, size: Schema.Number, maxBytes: Schema.Number },
  { httpApiStatus: 413 },
) {}

export const ImageSummary = Schema.Struct({
  manifestDigest: Digest,
  status: ImageStatus,
});

/** Compressed layer bytes downloaded so far, then the final file tree build. */
export const IndexingProgress = Schema.Struct({
  phase: Schema.Literals(["downloading", "publishing"]),
  completedBytes: Schema.Number,
  totalBytes: Schema.Number,
  /** 1-based index of the layer being downloaded. */
  layer: Schema.Number,
  layerCount: Schema.Number,
  /** Compressed size of the layer being indexed. */
  layerSize: Schema.optionalKey(Schema.Number),
  /** Fraction of the file tree build completed, from 0 to 1. */
  buildProgress: Schema.optionalKey(Schema.Number),
});

export const ImageStatusReport = Schema.Struct({
  status: ImageStatus,
  error: Schema.optionalKey(Schema.String),
  progress: Schema.optionalKey(IndexingProgress),
});

export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  type: EntryType,
  mode: Schema.Number,
  size: Schema.Number,
  linkTarget: Schema.optionalKey(Schema.String),
});

export const DirectoryListing = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(DirectoryEntry),
});

const imageParams = { digest: Digest };

/** Successful responses from these endpoints are immutable and may be cached. */
export class CacheableResponse extends HttpApiMiddleware.Service<CacheableResponse>()(
  "docker-viewer/CacheableResponse",
) {}

export class ImagesGroup extends HttpApiGroup.make("images").add(
  HttpApiEndpoint.post("open", "/images", {
    payload: Schema.Struct({
      imageReference: Schema.String,
      platform: Schema.optional(Schema.String),
    }),
    success: ImageSummary,
    error: [
      InvalidImageReference,
      InvalidPlatform,
      ImageNotFound,
      PlatformNotFound,
      UnsupportedImage,
      RegistryError,
    ],
  }),
  HttpApiEndpoint.get("status", "/images/:digest/status", {
    params: imageParams,
    success: ImageStatusReport,
  }),
  HttpApiEndpoint.get("tree", "/images/:digest/tree", {
    params: imageParams,
    query: { path: Schema.optional(Schema.String) },
    success: DirectoryListing,
    error: [ImageNotReady, PathNotFound, NotADirectory],
  }).middleware(CacheableResponse),
  HttpApiEndpoint.get("file", "/images/:digest/file", {
    params: imageParams,
    query: { path: Schema.String },
    success: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
    ),
    error: [ImageNotReady, PathNotFound, NotAFile],
  }).middleware(CacheableResponse),
  HttpApiEndpoint.get("preview", "/images/:digest/preview", {
    params: imageParams,
    query: { path: Schema.String },
    success: Schema.Uint8Array.pipe(
      HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
    ),
    error: [ImageNotReady, PathNotFound, NotAFile, PreviewTooLarge],
  }).middleware(CacheableResponse),
) {}

export class Api extends HttpApi.make("docker-viewer").add(ImagesGroup) {}
