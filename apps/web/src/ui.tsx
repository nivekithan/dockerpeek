import { Box, CircleAlert, LoaderCircle } from "lucide-react";
import type { IndexingProgress as IndexingProgressSchema } from "@docker-viewer/contract";
import type { CSSProperties, ReactNode } from "react";
import { formatSize } from "./format.ts";

type IndexingProgress = typeof IndexingProgressSchema.Type;

export function Spinner({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-zinc-400">
      <LoaderCircle className="size-6 animate-spin text-emerald-400" />
      <p>{label}</p>
      {children}
    </div>
  );
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="rounded-full bg-red-500/10 p-3 ring-1 ring-red-500/20">
        <CircleAlert className="size-6 text-red-400" />
      </div>
      <p className="max-w-lg text-sm text-zinc-300">{children}</p>
    </div>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-lg bg-linear-to-br from-emerald-400 to-amber-500 shadow-lg shadow-emerald-500/20">
        <Box className="size-4 text-zinc-950" strokeWidth={2.5} />
      </span>
      <span className="font-mono text-sm font-semibold tracking-tight text-zinc-100">
        docker<span className="text-gradient">peek</span>
      </span>
    </span>
  );
}

const LAYERS = [
  { lift: "0px", tint: "from-emerald-500/25 to-emerald-500/5", border: "border-emerald-400/30" },
  { lift: "26px", tint: "from-teal-500/25 to-teal-500/5", border: "border-teal-400/30" },
  { lift: "52px", tint: "from-amber-500/30 to-amber-500/5", border: "border-amber-400/40" },
];

/** Image layers separating and merging back into one filesystem, with real progress when known. */
export function IndexingAnimation({ progress }: { progress: IndexingProgress | undefined }) {
  return (
    <div className="relative isolate flex h-full flex-col items-center justify-center gap-10 overflow-hidden">
      <div aria-hidden className="bg-grid pointer-events-none absolute inset-0 -z-10" />
      <div className="relative size-56 perspective-[900px]">
        <div
          aria-hidden
          className="absolute inset-10 rounded-full bg-emerald-500/30 blur-3xl"
          style={{ animation: "glow-pulse 2.6s ease-in-out infinite" }}
        />
        <div className="absolute inset-0 transform-3d transform-[rotateX(58deg)_rotateZ(-45deg)]">
          {LAYERS.map((layer, index) => (
            <div
              key={layer.lift}
              className={`absolute inset-10 overflow-hidden rounded-2xl border bg-linear-to-br shadow-[0_0_30px_-8px] shadow-emerald-400/40 backdrop-blur-sm ${layer.tint} ${layer.border}`}
              style={
                {
                  "--lift": layer.lift,
                  animation: `layer-lift 2.6s cubic-bezier(0.65, 0, 0.35, 1) ${index * 0.08}s infinite`,
                } as CSSProperties
              }
            >
              {index === LAYERS.length - 1 && (
                <div
                  className="absolute inset-0 bg-linear-to-r from-transparent via-white/25 to-transparent"
                  style={{ animation: "layer-shine 2.6s ease-in-out infinite" }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <ProgressBar progress={progress} />
    </div>
  );
}

function ProgressBar({ progress }: { progress: IndexingProgress | undefined }) {
  const label =
    progress === undefined
      ? "Indexing image layers"
      : progress.phase === "publishing"
        ? "Building file tree"
        : `Indexing layer ${progress.layer} of ${progress.layerCount}`;
  const building = progress?.phase === "publishing";
  const fraction =
    progress === undefined
      ? undefined
      : building
        ? progress.buildProgress
        : progress.totalBytes === 0
          ? undefined
          : progress.completedBytes / progress.totalBytes;
  const percent = fraction === undefined ? undefined : Math.round(fraction * 100);

  return (
    <div className="flex w-80 flex-col gap-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-zinc-200">{label}</span>
        {percent !== undefined && (
          <span className="font-mono text-xs text-zinc-400">{percent}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-emerald-400 to-amber-400 shadow-[0_0_12px] shadow-emerald-400/50 transition-[width] duration-700 ease-out"
          style={{ width: `${percent ?? 0}%` }}
        />
        {percent === undefined && (
          <div
            className="absolute inset-0 bg-linear-to-r from-transparent via-emerald-300/40 to-transparent"
            style={{ animation: "layer-shine 1.6s ease-in-out infinite" }}
          />
        )}
      </div>
      {progress !== undefined && !building && progress.totalBytes > 0 && (
        <p className="font-mono text-xs text-zinc-500">
          {formatSize(progress.completedBytes)} of {formatSize(progress.totalBytes)}
        </p>
      )}
    </div>
  );
}
