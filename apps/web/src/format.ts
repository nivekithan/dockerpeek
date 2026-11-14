import type { Entry } from "./api.ts";

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Renders `ls -l` style permissions, including setuid, setgid, and sticky bits. */
export function formatMode(entry: Entry) {
  const typeChar = { directory: "d", symlink: "l", file: "-", hardlink: "-", other: "?" }[
    entry.type
  ];
  const { mode } = entry;
  const triplet = (shift: number, special: number, specialChar: string) => {
    const execute = (mode >> shift) & 1;
    const isSpecial = (mode & special) !== 0;
    return (
      ((mode >> (shift + 2)) & 1 ? "r" : "-") +
      ((mode >> (shift + 1)) & 1 ? "w" : "-") +
      (isSpecial ? (execute ? specialChar : specialChar.toUpperCase()) : execute ? "x" : "-")
    );
  };
  return typeChar + triplet(6, 0o4000, "s") + triplet(3, 0o2000, "s") + triplet(0, 0o1000, "t");
}

export function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

export function joinPath(directory: string, name: string) {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

export function baseName(path: string) {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

/** Directories from the root down to, but excluding, `path`. */
export function ancestorPaths(path: string) {
  const ancestors = ["/"];
  const segments = path.split("/").filter(Boolean);
  for (let i = 1; i < segments.length; i++) ancestors.push(`/${segments.slice(0, i).join("/")}`);
  return path === "/" ? [] : ancestors;
}

export function normalizePath(path: string) {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  return `/${segments.join("/")}`;
}

export function shortDigest(digest: string) {
  return digest.replace(/^sha256:/, "").slice(0, 12);
}
