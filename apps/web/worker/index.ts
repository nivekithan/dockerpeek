/** Forwards same-origin `/api/*` requests to the API Worker; assets serve everything else. */
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("Not Found", { status: 404 });

    url.pathname = url.pathname.slice("/api".length);
    return env.API.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
