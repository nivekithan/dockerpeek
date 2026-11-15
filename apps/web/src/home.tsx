import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, LoaderCircle, Search } from "lucide-react";
import { useState } from "react";
import { describeError, openImage, run } from "./api.ts";
import { posthog } from "./posthog.ts";
import { loadRecentImages, rememberImage } from "./recent.ts";
import { Logo } from "./ui.tsx";

const EXAMPLES = [
  "public.ecr.aws/docker/library/alpine:3.20",
  "public.ecr.aws/docker/library/nginx:alpine",
  "public.ecr.aws/docker/library/python:3.13-slim",
  "ghcr.io/astral-sh/uv:latest",
];
const MAX_CHIPS = 4;

export function Home() {
  const navigate = useNavigate();
  const [reference, setReference] = useState("");
  const [recent, setRecent] = useState(loadRecentImages);

  const open = useMutation({
    mutationFn: (reference: string) => run(openImage(reference)),
    onSuccess: (image, reference) => {
      setRecent(rememberImage(reference));
      posthog.capture("image_opened", { reference });
      return navigate({
        to: "/images/$digest",
        params: { digest: image.manifestDigest },
        search: { ref: reference },
      });
    },
  });

  const submit = (imageReference: string) => {
    const trimmed = imageReference.trim();
    if (trimmed === "") return;
    setReference(trimmed);
    open.mutate(trimmed);
  };

  return (
    <main className="relative isolate flex min-h-full flex-col overflow-hidden">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 -z-10" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 -z-10 h-120 w-240 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-24 -right-40 -z-10 h-96 w-96 rounded-full bg-amber-600/15 blur-[120px]"
      />

      <header className="px-6 py-5">
        <Logo />
      </header>

      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <div className="w-full max-w-2xl">
          <div className="mb-10 text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
              Peek inside any
              <br />
              <span className="text-gradient">container image</span>
            </h1>
            <p className="mx-auto mt-5 max-w-lg text-zinc-400">
              Browse the filesystem of any public image in your browser.
            </p>
          </div>

          <form
            className="group relative"
            onSubmit={(event) => {
              event.preventDefault();
              submit(reference);
            }}
          >
            <div
              aria-hidden
              className="absolute -inset-px rounded-2xl bg-linear-to-r from-emerald-500/40 via-amber-500/30 to-emerald-500/40 opacity-50 blur-sm transition group-focus-within:opacity-100"
            />
            <div className="relative flex items-center gap-2 rounded-2xl border border-white/10 bg-surface/90 p-2 backdrop-blur">
              <Search className="ml-3 size-4 shrink-0 text-zinc-500" />
              <input
                autoFocus
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="alpine:3.20, ghcr.io/owner/image:tag, …"
                spellCheck={false}
                aria-label="Image reference"
                className="min-w-0 flex-1 bg-transparent px-2 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={open.isPending}
                className="inline-flex items-center gap-2 rounded-xl bg-linear-to-r from-emerald-400 to-amber-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:opacity-60"
              >
                {open.isPending ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowRight className="size-4" />
                )}
                Open
              </button>
            </div>
          </form>

          {open.isError && (
            <p
              className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-red-300"
              role="alert"
            >
              {describeError(open.error)}
            </p>
          )}

          {/* Recently opened images come first, then examples not opened yet. */}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 px-2">
            {[...recent, ...EXAMPLES.filter((example) => !recent.includes(example))]
              .slice(0, MAX_CHIPS)
              .map((image) => (
                <Chip key={image} reference={image} disabled={open.isPending} onOpen={submit} />
              ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function Chip({
  reference,
  disabled,
  onOpen,
}: {
  reference: string;
  disabled: boolean;
  onOpen: (reference: string) => void;
}) {
  return (
    <button
      type="button"
      title={reference}
      disabled={disabled}
      onClick={() => onOpen(reference)}
      className="max-w-40 truncate rounded-full border border-line bg-white/[0.03] px-3 py-1 font-mono text-xs text-zinc-400 transition hover:border-emerald-400/40 hover:bg-emerald-400/10 hover:text-emerald-200 disabled:opacity-60"
    >
      {reference.replace("public.ecr.aws/docker/library/", "")}
    </button>
  );
}
