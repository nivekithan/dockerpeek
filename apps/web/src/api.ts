import type {
  DirectoryEntry,
  ImageNotFound,
  ImageNotReady,
  InvalidImageReference,
  InvalidPlatform,
  NotADirectory,
  NotAFile,
  PathNotFound,
  PlatformNotFound,
  PreviewTooLarge,
  RegistryError,
  UnsupportedImage,
} from "@docker-viewer/contract";
import { Api } from "@docker-viewer/contract";
import { queryOptions } from "@tanstack/react-query";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

export type Entry = typeof DirectoryEntry.Type;

export type ApiError =
  | InvalidImageReference
  | ImageNotFound
  | InvalidPlatform
  | PlatformNotFound
  | UnsupportedImage
  | RegistryError
  | ImageNotReady
  | PathNotFound
  | NotADirectory
  | NotAFile
  | PreviewTooLarge;

/** Matches the API's preview cap; larger files can only be downloaded. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export const openImage = Effect.fn("openImage")(function* (imageReference: string) {
  const api = yield* ApiClient;
  return yield* api.images.open({ payload: { imageReference } });
});

export const run = <A, E>(effect: Effect.Effect<A, E, ApiClient>, signal?: AbortSignal) =>
  runtime.runPromise(effect, { signal });

export const statusQuery = (digest: string, reference?: string) =>
  queryOptions({
    queryKey: ["status", digest],
    queryFn: ({ signal }) => run(imageStatus(digest, reference), signal),
    refetchInterval: (query) => (query.state.data?.status === "indexing" ? 1500 : false),
  });

export const treeQuery = (digest: string, path: string) =>
  queryOptions({
    queryKey: ["tree", digest, path],
    queryFn: ({ signal }) => run(listDirectory(digest, path), signal),
    staleTime: Infinity,
  });

export const previewQuery = (digest: string, path: string) =>
  queryOptions({
    queryKey: ["preview", digest, path],
    queryFn: ({ signal }) => run(previewFile(digest, path), signal),
    staleTime: Infinity,
  });

export function downloadUrl(digest: string, path: string) {
  return `/api/images/${digest}/file?${new URLSearchParams({ path })}`;
}

/** Tagged contract errors are deterministic, so retrying them cannot help. */
export function isApiError(error: unknown): error is ApiError {
  return typeof error === "object" && error !== null && "_tag" in error;
}

export function describeError(error: unknown): string {
  if (!isApiError(error)) return error instanceof Error ? error.message : String(error);
  switch (error._tag) {
    case "InvalidImageReference":
      return `"${error.imageReference}" is not a valid image reference.`;
    case "ImageNotFound":
      return `Image "${error.imageReference}" was not found.`;
    case "InvalidPlatform":
      return `"${error.platform}" is not a valid platform, e.g. linux/amd64.`;
    case "PlatformNotFound":
      return `Platform ${error.platform} is not available. Available: ${error.available.join(", ")}.`;
    case "PathNotFound":
      return `${error.path} does not exist.`;
    case "NotADirectory":
      return `${error.path} is not a directory.`;
    case "NotAFile":
      return `${error.path} is not a regular file.`;
    case "ImageNotReady":
      return `The image is not ready (${error.status}).`;
    case "PreviewTooLarge":
      return `${error.path} is too large to preview.`;
    case "UnsupportedImage":
    case "RegistryError":
      return error.message;
  }
}

class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()(
  "docker-viewer/web/ApiClient",
) {}

const runtime = ManagedRuntime.make(
  Layer.effect(ApiClient, HttpApiClient.make(Api, { baseUrl: `${location.origin}/api` })).pipe(
    Layer.provide(FetchHttpClient.layer),
  ),
);

const imageStatus = Effect.fn("imageStatus")(function* (digest: string, reference?: string) {
  const api = yield* ApiClient;
  const report = yield* api.images.status({ params: { digest } });
  // A shared link names the image, so an unindexed image can start indexing.
  if (report.status !== "not_found" || reference === undefined) return report;

  const opened = yield* openImage(reference);
  return opened.manifestDigest === digest
    ? { status: opened.status }
    : ({ status: "moved", manifestDigest: opened.manifestDigest } as const);
});

const listDirectory = Effect.fn("listDirectory")(function* (digest: string, path: string) {
  const api = yield* ApiClient;
  return yield* api.images.tree({ params: { digest }, query: { path } });
});

/** Text is shown in the editor; anything that is not valid UTF-8 is treated as binary. */
const previewFile = Effect.fn("previewFile")(function* (digest: string, path: string) {
  const api = yield* ApiClient;
  const bytes = yield* api.images.preview({ params: { digest }, query: { path } });
  const text = decodeText(bytes);
  return text === undefined
    ? ({ kind: "binary", size: bytes.byteLength } as const)
    : ({ kind: "text", text } as const);
});

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
