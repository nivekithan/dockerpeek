import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import DiffsWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isApiError } from "./api.ts";
import { router } from "./router.tsx";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isApiError(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: () => new Worker(DiffsWorkerUrl, { type: "module" }),
          poolSize: 2,
        }}
        highlighterOptions={{ theme: { dark: "pierre-dark", light: "pierre-light" } }}
      >
        <RouterProvider router={router} />
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </StrictMode>,
);
