import { Box, CircleAlert, LoaderCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

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

/** Image layers separating and merging back into one filesystem. */
export function IndexingAnimation({ label }: { label: string }) {
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
      <p className="text-sm text-zinc-300">{label}</p>
    </div>
  );
}
