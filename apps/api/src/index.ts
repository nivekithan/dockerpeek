import { Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

const HealthRoute = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

const app = HttpRouter.toWebHandler(HealthRoute.pipe(Layer.provide(HttpServer.layerServices)));

export default {
  fetch: (request) => app.handler(request),
} satisfies ExportedHandler;
