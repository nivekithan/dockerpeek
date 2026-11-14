import type { EntryType } from "@docker-viewer/contract";
import { resolve } from "pathe";
import { extract, type Header } from "tar-stream";
import type { LayerEntry } from "../storage.ts";

/** Drains tar-stream entries while preserving their offsets in the original decompressed tar. */
export class TarParser {
  private readonly parser = extract();
  private readonly completion: Promise<void>;
  private failure: Error | undefined;

  constructor(onEntry: (entry: LayerEntry) => void) {
    let finished = false;
    this.completion = new Promise<void>((resolve, reject) => {
      this.parser.once("finish", () => {
        finished = true;
        resolve();
      });
      this.parser.on("error", (error: Error) => {
        this.failure = error;
        reject(error);
      });
      this.parser.once("close", () => {
        if (!finished) reject(this.failure ?? new Error("tar parsing was cancelled"));
      });
    });
    // Parser errors can arrive between writes; push/end still observe the original rejection.
    void this.completion.catch(() => {});
    this.parser.on("entry", (header, body, next) => {
      try {
        const path = resolve("/", header.name);
        const offset = body.offset + BLOCK_SIZE;
        if (!Number.isSafeInteger(header.size) || header.size < 0 || !Number.isSafeInteger(offset))
          throw new Error("tar entry has an invalid size or offset");
        if (path !== "/") {
          onEntry({
            path,
            type: entryType(header.type),
            mode: header.mode,
            size: HEADER_ONLY_TYPES.has(header.type) ? 0 : header.size,
            linkTarget:
              header.type === "link" || header.type === "symlink" ? header.linkname : undefined,
            offset,
          });
        }
        body.once("end", () => next());
        body.once("error", (error: Error) => next(error));
        body.resume();
      } catch (cause) {
        next(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  async push(chunk: Uint8Array) {
    if (this.failure !== undefined) throw this.failure;
    if (this.parser.destroying) throw new Error("tar parser is closed");
    if (this.parser.write(chunk)) return;

    let onDrain = () => {};
    const drained = new Promise<void>((resolve) => {
      onDrain = resolve;
      this.parser.once("drain", onDrain);
    });
    try {
      // An error may already have fired before the drain listener was installed.
      await Promise.race([drained, this.completion]);
    } finally {
      this.parser.off("drain", onDrain);
    }
  }

  async end() {
    this.parser.end(new Uint8Array(0));
    await this.completion;
  }

  destroy() {
    this.parser.destroy();
  }
}

const entryType = (type: Header["type"]): EntryType => {
  switch (type) {
    case "file":
    case "contiguous-file":
      return "file";
    case "link":
      return "hardlink";
    case "symlink":
      return "symlink";
    case "directory":
      return "directory";
    default:
      return "other";
  }
};

const BLOCK_SIZE = 512;
const HEADER_ONLY_TYPES = new Set([
  "link",
  "symlink",
  "directory",
  "block-device",
  "character-device",
  "fifo",
]);
