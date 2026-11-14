import { Option, Schema } from "effect";

/** Most recently opened image references, newest first. */
export function loadRecentImages(): string[] {
  const stored = readStorage();
  return stored === null ? [] : Option.getOrElse(decode(stored), () => []).slice(0, MAX_RECENT);
}

/** Moves `reference` to the front and returns the updated list. */
export function rememberImage(reference: string): string[] {
  const recent = [reference, ...loadRecentImages().filter((item) => item !== reference)].slice(
    0,
    MAX_RECENT,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Storage can be full or disabled; recents are a convenience only.
  }
  return recent;
}

function readStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

const STORAGE_KEY = "dockerpeek:recent-images";
const MAX_RECENT = 6;
