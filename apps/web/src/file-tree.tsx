import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTree as FileTreeModel, FileTreeDirectoryHandle } from "@pierre/trees";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { describeError, treeQuery, type Entry } from "./api.ts";
import { ancestorPaths, joinPath, normalizePath } from "./format.ts";
import { ErrorMessage, Spinner } from "./ui.tsx";

/**
 * The API lists one directory at a time, so directories are fetched when first
 * expanded and their entries are added to the tree model.
 */
export function ImageTree({ digest, selectedPath }: { digest: string; selectedPath: string }) {
  const root = useQuery(treeQuery(digest, "/"));
  if (root.isPending) return <Spinner label="Loading…" />;
  if (root.isError) return <ErrorMessage>{describeError(root.error)}</ErrorMessage>;
  return <LoadedTree digest={digest} root={root.data.entries} selectedPath={selectedPath} />;
}

/** The tree does not render entries added to an initially empty model, so it starts from the root listing. */
function LoadedTree({
  digest,
  root,
  selectedPath,
}: {
  digest: string;
  root: readonly Entry[];
  selectedPath: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const [state] = useState(() => ({
    entries: new Map(root.map((entry) => [joinPath("/", entry.name), entry])),
    loaded: new Set(["/"]),
    loading: new Map<string, Promise<void>>(),
  }));

  const { model } = useFileTree({
    paths: root.map((entry) => toTreePath(joinPath("/", entry.name), entry.type === "directory")),
    density: "compact",
    stickyFolders: true,
    onSelectionChange: (paths) => {
      const [path] = paths;
      if (path === undefined || paths.length !== 1) return;
      // The model keeps the callbacks it was created with, so read the current URL from the router.
      const selected = fromTreePath(path);
      if (selected === normalizePath(router.state.location.search.path ?? "/")) return;
      void router.navigate({
        to: "/images/$digest",
        params: { digest },
        search: (previous) => ({ ...previous, path: selected }),
      });
    },
    renderRowDecoration: ({ item }) => {
      const entry = state.entries.get(fromTreePath(item.path));
      return entry?.type === "symlink" && entry.linkTarget !== undefined
        ? { text: `→ ${entry.linkTarget}`, title: entry.linkTarget }
        : null;
    },
  });

  const loadDirectory = useCallback(
    (directory: string) => {
      if (state.loaded.has(directory)) return Promise.resolve();
      const pending = state.loading.get(directory);
      if (pending !== undefined) return pending;

      const load = queryClient
        .fetchQuery(treeQuery(digest, directory))
        .then((listing) => {
          if (state.loaded.has(directory)) return;
          state.loaded.add(directory);
          for (const entry of listing.entries)
            state.entries.set(joinPath(directory, entry.name), entry);
          model.batch(
            listing.entries.map((entry) => ({
              type: "add" as const,
              path: toTreePath(joinPath(directory, entry.name), entry.type === "directory"),
            })),
          );
        })
        .finally(() => state.loading.delete(directory));
      state.loading.set(directory, load);
      return load;
    },
    [digest, model, queryClient, state],
  );

  // Expanding a directory in the tree is the only signal that its children are needed.
  useEffect(
    () =>
      model.subscribe(() => {
        for (const [path, entry] of state.entries) {
          if (entry.type !== "directory" || state.loaded.has(path)) continue;
          if (getDirectory(model, path)?.isExpanded()) void loadDirectory(path);
        }
      }),
    [model, state, loadDirectory],
  );

  // Reveal paths selected outside the tree, such as breadcrumbs and directory listings.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const ancestor of ancestorPaths(selectedPath)) {
        await loadDirectory(ancestor);
        if (cancelled) return;
        if (ancestor !== "/") {
          const directory = getDirectory(model, ancestor);
          if (directory?.isExpanded() === false) directory.expand();
        }
      }
      if (selectedPath === "/") return;

      const entry = state.entries.get(selectedPath);
      const treePath = toTreePath(selectedPath, entry?.type === "directory");
      for (const path of model.getSelectedPaths()) {
        if (path !== treePath) model.getItem(path)?.deselect();
      }
      const item = model.getItem(treePath);
      if (item === null) return;
      if (!item.isSelected()) item.select();
      model.scrollToPath(treePath, { focus: false, offset: "nearest" });
    })().catch(() => {
      // The main panel reports listing errors for the selected path.
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, model, state, loadDirectory]);

  return <FileTree model={model} className="tree-theme h-full" />;
}

function getDirectory(model: FileTreeModel, path: string): FileTreeDirectoryHandle | undefined {
  const item = model.getItem(toTreePath(path, true));
  return item !== null && "expand" in item ? item : undefined;
}

function toTreePath(path: string, isDirectory: boolean) {
  return path.slice(1) + (isDirectory ? "/" : "");
}

function fromTreePath(path: string) {
  return `/${path.replace(/\/$/, "")}`;
}
