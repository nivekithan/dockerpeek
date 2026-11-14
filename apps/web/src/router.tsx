import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { Schema } from "effect";
import { Explorer } from "./explorer.tsx";
import { Home } from "./home.tsx";

const ExplorerSearch = Schema.Struct({
  ref: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
});

const rootRoute = createRootRoute({ component: Outlet });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });

const explorerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/images/$digest",
  validateSearch: Schema.toStandardSchemaV1(ExplorerSearch),
  component: Explorer,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, explorerRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
