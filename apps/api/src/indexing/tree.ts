import { basename, dirname, resolve } from "pathe";
import type { EntryType } from "@docker-viewer/contract";
import type { LayerEntry, StoredDirEntry } from "../storage.ts";

export interface TreeNode {
  type: EntryType;
  mode: number;
  size: number;
  linkTarget?: string | undefined;
  layer?: number | undefined;
  offset?: number | undefined;
  children?: Map<string, TreeNode> | undefined;
}

/**
 * Applies one layer on top of the tree, the way container runtimes unpack it.
 * Whiteouts only remove what lower layers added, so they run before additions.
 */
export const applyLayer = (root: TreeNode, entries: ReadonlyArray<LayerEntry>, layer: number) => {
  for (const entry of entries) {
    const { parent, name } = splitParent(entry.path);
    if (name === OPAQUE_MARKER) lookup(root, parent)?.children?.clear();
    else if (name.startsWith(WHITEOUT_PREFIX))
      lookup(root, parent)?.children?.delete(name.slice(WHITEOUT_PREFIX.length));
  }

  for (const entry of entries) {
    const { parent, name } = splitParent(entry.path);
    if (name.startsWith(WHITEOUT_PREFIX)) continue;
    const children = ensureDirectory(root, parent).children ?? new Map<string, TreeNode>();
    const existing = children.get(name);

    if (entry.type === "directory") {
      if (existing?.children !== undefined) existing.mode = entry.mode;
      else children.set(name, newDirectory(entry.mode));
      continue;
    }

    if (entry.type === "hardlink") {
      // A hardlink shares the data of a file unpacked earlier, in this layer or a lower one.
      const target =
        entry.linkTarget === undefined
          ? undefined
          : lookup(root, splitPath(resolve("/", entry.linkTarget)));
      if (target?.type === "file") {
        children.set(name, {
          type: "file",
          mode: entry.mode,
          size: target.size,
          layer: target.layer,
          offset: target.offset,
        });
        continue;
      }
    }

    children.set(name, {
      type: entry.type,
      mode: entry.mode,
      size: entry.size,
      linkTarget: entry.linkTarget,
      layer: entry.type === "file" ? layer : undefined,
      offset: entry.type === "file" ? entry.offset : undefined,
    });
  }
};

/** Yields every directory with its absolute path and listing, starting with `/`. */
export function* directories(
  root: TreeNode,
): Generator<{ path: string; entries: StoredDirEntry[] }> {
  const queue: Array<{ path: string; node: TreeNode }> = [{ path: "/", node: root }];
  for (let index = 0, item = queue[0]; item !== undefined; item = queue[++index]) {
    const entries: StoredDirEntry[] = [];
    for (const [name, child] of [...(item.node.children ?? new Map<string, TreeNode>())].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      entries.push({
        name,
        type: child.type,
        mode: child.mode,
        size: child.size,
        linkTarget: child.linkTarget,
        layer: child.layer,
        offset: child.offset,
      });
      if (child.children !== undefined)
        queue.push({ path: item.path === "/" ? `/${name}` : `${item.path}/${name}`, node: child });
    }
    yield { path: item.path, entries };
  }
}

export const newDirectory = (mode = 0o755): TreeNode => ({
  type: "directory",
  mode,
  size: 0,
  children: new Map(),
});

const splitPath = (path: string) => path.split("/").filter((segment) => segment !== "");

const splitParent = (path: string) => ({ parent: splitPath(dirname(path)), name: basename(path) });

const lookup = (root: TreeNode, segments: ReadonlyArray<string>) => {
  let node: TreeNode | undefined = root;
  for (const segment of segments) node = node?.children?.get(segment);
  return node;
};

/** Returns the directory at `segments`, creating missing directories and replacing files that are in the way. */
const ensureDirectory = (root: TreeNode, segments: ReadonlyArray<string>) => {
  let node = root;
  for (const segment of segments) {
    const children = node.children ?? new Map<string, TreeNode>();
    node.children = children;
    let child = children.get(segment);
    if (child?.children === undefined) {
      child = newDirectory();
      children.set(segment, child);
    }
    node = child;
  }
  return node;
};

const OPAQUE_MARKER = ".wh..wh..opq";
const WHITEOUT_PREFIX = ".wh.";
