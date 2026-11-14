import { File, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { Download, File as FileIcon, FileQuestion, Folder, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  MAX_PREVIEW_BYTES,
  describeError,
  downloadUrl,
  isApiError,
  previewQuery,
  treeQuery,
  type Entry,
} from "./api.ts";
import { baseName, formatMode, formatSize, joinPath, parentPath } from "./format.ts";
import { ErrorMessage, Spinner } from "./ui.tsx";

/** Shows a directory listing or file contents, depending on what `path` is. */
export function PathView({
  digest,
  path,
  onNavigate,
}: {
  digest: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const parent = useQuery({ ...treeQuery(digest, parentPath(path)), enabled: path !== "/" });

  if (path === "/") return <DirectoryPanel digest={digest} path={path} onNavigate={onNavigate} />;
  if (parent.isPending) return <Spinner label="Loading…" />;
  if (parent.isError) return <ErrorMessage>{describeError(parent.error)}</ErrorMessage>;

  const entry = parent.data.entries.find((candidate) => candidate.name === baseName(path));
  if (entry === undefined) return <ErrorMessage>{path} does not exist.</ErrorMessage>;

  switch (entry.type) {
    case "directory":
      return <DirectoryPanel digest={digest} path={path} onNavigate={onNavigate} />;
    case "symlink":
      return <SymlinkPanel digest={digest} path={path} entry={entry} onNavigate={onNavigate} />;
    case "file":
    case "hardlink":
      return <FilePanel digest={digest} path={path} entry={entry} />;
    case "other":
      return <Notice icon={<FileQuestion />} title="Special file"></Notice>;
  }
}

function DirectoryPanel({
  digest,
  path,
  onNavigate,
}: {
  digest: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const listing = useQuery(treeQuery(digest, path));
  if (listing.isPending) return <Spinner label="Loading directory…" />;
  if (listing.isError) return <ErrorMessage>{describeError(listing.error)}</ErrorMessage>;

  const entries = listing.data.entries.toSorted(
    (a, b) =>
      Number(b.type === "directory") - Number(a.type === "directory") ||
      a.name.localeCompare(b.name),
  );
  if (entries.length === 0) return <Notice icon={<Folder />} title="Empty directory" />;

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left font-mono text-[13px]">
        <thead className="sticky top-0 bg-panel/95 text-xs text-zinc-500 backdrop-blur">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 text-right font-medium">Size</th>
            <th className="px-4 py-2 font-medium">Mode</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.name}
              className="cursor-pointer border-b border-white/[0.03] transition-colors hover:bg-emerald-400/[0.06]"
              onClick={() => onNavigate(joinPath(path, entry.name))}
            >
              <td className="px-4 py-1.5">
                <span className="flex items-center gap-2">
                  <EntryIcon entry={entry} />
                  <span
                    className={entry.type === "directory" ? "text-emerald-300" : "text-zinc-200"}
                  >
                    {entry.name}
                  </span>
                  {entry.linkTarget !== undefined && (
                    <span className="truncate text-zinc-500">→ {entry.linkTarget}</span>
                  )}
                </span>
              </td>
              <td className="px-4 py-1.5 text-right whitespace-nowrap text-zinc-400">
                {entry.type === "directory" || entry.type === "symlink"
                  ? ""
                  : formatSize(entry.size)}
              </td>
              <td className="px-4 py-1.5 text-zinc-500">{formatMode(entry)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The listing does not say what a link resolves to, so try it as a directory first. */
function SymlinkPanel({
  digest,
  path,
  entry,
  onNavigate,
}: {
  digest: string;
  path: string;
  entry: Entry;
  onNavigate: (path: string) => void;
}) {
  const target = useQuery({ ...treeQuery(digest, path), retry: false });
  if (target.isPending) return <Spinner label="Resolving link…" />;
  if (target.isSuccess)
    return <DirectoryPanel digest={digest} path={path} onNavigate={onNavigate} />;
  if (isApiError(target.error) && target.error._tag === "NotADirectory") {
    return <FilePanel digest={digest} path={path} entry={entry} />;
  }
  if (isApiError(target.error) && target.error._tag === "PathNotFound") {
    return (
      <Notice icon={<Link2 />} title="Broken symlink">
        <code className="text-zinc-300">{entry.linkTarget}</code> does not exist.
      </Notice>
    );
  }
  return <ErrorMessage>{describeError(target.error)}</ErrorMessage>;
}

function FilePanel({ digest, path, entry }: { digest: string; path: string; entry: Entry }) {
  const tooLarge = entry.type !== "symlink" && entry.size > MAX_PREVIEW_BYTES;
  const preview = useQuery({ ...previewQuery(digest, path), enabled: !tooLarge });

  const download = (
    <a
      href={downloadUrl(digest, path)}
      download
      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 font-sans text-xs text-emerald-200 transition hover:bg-emerald-400/20"
    >
      <Download className="size-3.5" /> Download
    </a>
  );

  let body: ReactNode;
  if (
    tooLarge ||
    (preview.isError && isApiError(preview.error) && preview.error._tag === "PreviewTooLarge")
  ) {
    body = (
      <Notice icon={<FileIcon />} title="File too large to preview" action={download}>
        Limit is {formatSize(MAX_PREVIEW_BYTES)}.
      </Notice>
    );
  } else if (preview.isPending) {
    body = <Spinner label="Loading file…" />;
  } else if (preview.isError) {
    body = <ErrorMessage>{describeError(preview.error)}</ErrorMessage>;
  } else if (preview.data.kind === "binary") {
    body = (
      <Notice icon={<FileIcon />} title="Binary file" action={download}>
        {formatSize(preview.data.size)}
      </Notice>
    );
  } else {
    body = (
      <Virtualizer className="h-full overflow-auto">
        <File
          file={{
            name: baseName(path),
            contents: preview.data.text,
            cacheKey: `${digest}:${path}`,
          }}
          options={{
            theme: { dark: "pierre-dark", light: "pierre-light" },
            disableFileHeader: true,
            unsafeCSS: `:host { --diffs-dark-bg: var(--color-panel, #111113); }`,
            overflow: "scroll",
          }}
        />
      </Virtualizer>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-4 border-b border-line bg-surface/60 px-4 py-2 font-mono text-xs text-zinc-500">
        <span>{formatMode(entry)}</span>
        {entry.type !== "symlink" && <span>{formatSize(entry.size)}</span>}
        {entry.linkTarget !== undefined && <span>→ {entry.linkTarget}</span>}
        <span className="ml-auto">{download}</span>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

function EntryIcon({ entry }: { entry: Entry }) {
  const className = "size-4 shrink-0";
  switch (entry.type) {
    case "directory":
      return <Folder className={`${className} text-emerald-400`} />;
    case "symlink":
      return <Link2 className={`${className} text-amber-400`} />;
    case "other":
      return <FileQuestion className={`${className} text-zinc-500`} />;
    default:
      return <FileIcon className={`${className} text-zinc-500`} />;
  }
}

function Notice({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="rounded-2xl border border-line bg-raised p-4 text-emerald-400 [&>svg]:size-8">
        {icon}
      </div>
      <p className="font-medium text-zinc-200">{title}</p>
      {children && <p className="max-w-md text-sm text-zinc-500">{children}</p>}
      {action}
    </div>
  );
}
