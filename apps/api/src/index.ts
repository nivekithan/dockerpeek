import { Context, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Api } from "@docker-viewer/contract";
import { ImagesHandlers } from "./api/images.ts";
import { Registry } from "./registry.ts";
import { CachedStorage } from "./storage-cache.ts";
import { Observability } from "./observability.ts";
import { HttpResponseCache, WaitUntil } from "./http-cache.ts";

export { ImageIndexer } from "./indexing/workflow.ts";

export default {
  fetch(request, _env, ctx) {
    return app.handler(request, Context.make(WaitUntil, ctx.waitUntil.bind(ctx)));
  },
} satisfies ExportedHandler<Env>;

const ApiRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(ImagesHandlers),
  Layer.provide(HttpResponseCache),
  Layer.provide(Layer.mergeAll(Registry.layer, CachedStorage)),
);

const app = HttpRouter.toWebHandler(
  ApiRoutes.pipe(Layer.provide(HttpServer.layerServices), Layer.provideMerge(Observability)),
);
