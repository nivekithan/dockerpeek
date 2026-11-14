import { useQuery } from "@tanstack/react-query";
import { Link, getRouteApi } from "@tanstack/react-router";
import { Check, ChevronRight, Copy } from "lucide-react";
import { useState } from "react";
import { describeError, statusQuery } from "./api.ts";
import { ImageTree } from "./file-tree.tsx";
import { normalizePath, shortDigest } from "./format.ts";
import { PathView } from "./path-view.tsx";
import { ErrorMessage, IndexingAnimation, Logo, Spinner } from "./ui.tsx";

const route = getRouteApi("/images/$digest");

export function Explorer() {
  const { digest } = route.useParams();
  const { ref, path: rawPath } = route.useSearch();
  const path = normalizePath(rawPath ?? "/");
  const navigate = route.useNavigate();
  const status = useQuery(statusQuery(digest, ref));

  const goTo = (next: string) => navigate({ search: (previous) => ({ ...previous, path: next }) });

  let content;
  if (status.isPending) content = <Spinner label="Checking image…" />;
  else if (status.isError) content = <ErrorMessage>{describeError(status.error)}</ErrorMessage>;
  else if (status.data.status === "indexing")
    content = <IndexingAnimation progress={status.data.progress} />;
  else if (status.data.status === "failed")
    content = (
      <ErrorMessage>
        Indexing failed{status.data.error ? `: ${status.data.error}` : "."}
      </ErrorMessage>
    );
  else if (status.data.status === "not_found")
    content = (
      <ErrorMessage>
        This image has not been indexed.{" "}
        <Link to="/" className="text-emerald-400 hover:underline">
          Open it by name
        </Link>
      </ErrorMessage>
    );
  else if (status.data.status === "moved")
    content = (
      <ErrorMessage>
        {ref} now points to a different image.{" "}
        <Link
          to="/images/$digest"
          params={{ digest: status.data.manifestDigest }}
          search={{ ref }}
          className="text-emerald-400 hover:underline"
        >
          Open the current image
        </Link>
      </ErrorMessage>
    );
  else
    content = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(220px,300px)_1fr]">
        <aside className="min-h-0 border-r border-line bg-surface">
          <ImageTree key={digest} digest={digest} selectedPath={path} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col bg-panel">
          <Breadcrumbs path={path} onNavigate={goTo} />
          <div className="min-h-0 flex-1">
            <PathView digest={digest} path={path} onNavigate={goTo} />
          </div>
        </section>
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="relative flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
        <div
          aria-hidden
          className="absolute inset-x-0 -bottom-px h-px bg-linear-to-r from-transparent via-emerald-400/40 to-transparent"
        />
        <Link to="/">
          <Logo />
        </Link>
        <span className="text-zinc-700">/</span>
        <span className="truncate rounded-md border border-line bg-raised px-2.5 py-1 font-mono text-xs text-zinc-200">
          {ref ?? "image"}
        </span>
        <CopyDigest digest={digest} />
      </header>
      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const segments = path.split("/").filter(Boolean);
  return (
    <nav className="flex min-h-10 flex-wrap items-center gap-0.5 border-b border-line bg-surface/60 px-3 py-2 font-mono text-[13px]">
      <button
        type="button"
        onClick={() => onNavigate("/")}
        className="rounded px-1 text-zinc-400 hover:bg-white/5 hover:text-emerald-200"
      >
        /
      </button>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join("/")}`;
        const isLast = index === segments.length - 1;
        return (
          <span key={target} className="flex items-center gap-0.5">
            {index > 0 && <ChevronRight className="size-3.5 text-zinc-600" />}
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className={`rounded px-1 hover:bg-white/5 ${isLast ? "text-emerald-200" : "text-zinc-400 hover:text-emerald-200"}`}
            >
              {segment}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function CopyDigest({ digest }: { digest: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={digest}
      onClick={() => {
        void navigator.clipboard.writeText(digest).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
    >
      {shortDigest(digest)}
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}
