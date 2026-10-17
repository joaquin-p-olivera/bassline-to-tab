// Export and import of the song history as one file, so it can be backed up
// or moved to another browser.
//
// File layout (little endian):
//   8 bytes   magic "BLTABHX1"
//   4 bytes   manifest length in bytes
//   N bytes   manifest: UTF-8 JSON { format, version, exportedAt, songs }
//   ...       binary section: every Blob and byte array of every song, back to back
//
// In the manifest, binary values are replaced by references into the binary
// section: { $blob: { offset, size, type, name?, lastModified? } } for Blobs
// and Files, { $bytes: { offset, size, kind } } for typed arrays (the MIDI).
// Blobs are concatenated without being read into memory, and on import they
// are slices of the chosen file, so large histories do not fill the RAM.

const MAGIC = "BLTABHX1";
const HEADER_SIZE = MAGIC.length + 4;
const FORMAT = "bassline-to-tab-history";
const VERSION = 1;
export const ARCHIVE_EXTENSION = ".bltab";

const TYPED_ARRAYS = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};

/// Builds the archive for the given song records.
export function exportSongs(songs) {
  const parts = [];
  let offset = 0;
  const addPart = (part, size) => {
    const reference = { offset, size };
    parts.push(part);
    offset += size;
    return reference;
  };

  const encode = (value) => {
    if (value instanceof Blob) {
      const reference = { ...addPart(value, value.size), type: value.type };
      if (value instanceof File) {
        reference.name = value.name;
        reference.lastModified = value.lastModified;
      }
      return { $blob: reference };
    }
    if (ArrayBuffer.isView(value)) {
      const kind = value.constructor.name in TYPED_ARRAYS ? value.constructor.name : "Uint8Array";
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { $bytes: { ...addPart(bytes, bytes.byteLength), kind } };
    }
    if (value instanceof ArrayBuffer) {
      return { $bytes: { ...addPart(value, value.byteLength), kind: "ArrayBuffer" } };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    }
    return value;
  };

  const manifest = { format: FORMAT, version: VERSION, exportedAt: Date.now(), songs: songs.map(encode) };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(HEADER_SIZE);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(MAGIC.length, json.byteLength, true);
  return new Blob([header, json, ...parts], { type: "application/octet-stream" });
}

/// Reads an archive made by exportSongs and returns the song records.
/// Throws an Error with a readable message if the file is not an archive.
export async function importSongs(file) {
  const notArchive = new Error("This file is not a song history exported by Bassline to Tab.");
  if (file.size < HEADER_SIZE) throw notArchive;
  const header = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer());
  if (new TextDecoder().decode(header.subarray(0, MAGIC.length)) !== MAGIC) throw notArchive;
  const jsonSize = new DataView(header.buffer).getUint32(MAGIC.length, true);
  const dataStart = HEADER_SIZE + jsonSize;
  if (dataStart > file.size) throw new Error("The history file is incomplete.");

  let manifest;
  try {
    manifest = JSON.parse(await file.slice(HEADER_SIZE, dataStart).text());
  } catch {
    throw notArchive;
  }
  if (manifest?.format !== FORMAT || !Array.isArray(manifest.songs)) throw notArchive;
  if (manifest.version > VERSION) {
    throw new Error("This history was exported by a newer version of the app. Reload the page and try again.");
  }

  const slice = ({ offset, size }, type = "") => {
    const start = dataStart + offset;
    if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || start + size > file.size) {
      throw new Error("The history file is damaged.");
    }
    return file.slice(start, start + size, type);
  };

  const decode = async (value) => {
    if (Array.isArray(value)) return Promise.all(value.map(decode));
    if (!value || typeof value !== "object") return value;
    if (value.$blob) {
      const { type = "", name, lastModified } = value.$blob;
      const blob = slice(value.$blob, type);
      return typeof name === "string" ? new File([blob], name, { type, lastModified }) : blob;
    }
    if (value.$bytes) {
      const buffer = await slice(value.$bytes).arrayBuffer();
      if (value.$bytes.kind === "ArrayBuffer") return buffer;
      const TypedArray = TYPED_ARRAYS[value.$bytes.kind] ?? Uint8Array;
      return new TypedArray(buffer);
    }
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await decode(item)]));
    return Object.fromEntries(entries);
  };

  const songs = await decode(manifest.songs);
  return songs.filter((song) => song && typeof song.id === "string" && song.file instanceof Blob);
}
