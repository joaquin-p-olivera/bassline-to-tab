// Song history in IndexedDB: the original file, the separated bass and the
// last transcription, so nothing is lost on reload and changing settings
// does not require running Demucs again.
//
// Record shape:
//   { id, name, createdAt, duration, file: File, bassWav: Blob | null,
//     separated: boolean, lastOptions, lastResult }

const DB_NAME = "bassline-to-tab";
const DB_VERSION = 1;
const STORE = "songs";

let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function withStore(mode, action) {
  const db = await openDb();
  const transaction = db.transaction(STORE, mode);
  const result = await requestToPromise(action(transaction.objectStore(STORE)));
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  return result;
}

/// Stable id for a file: same name, size and modification time → same song.
export function songId(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export async function getSong(id) {
  try {
    return await withStore("readonly", (store) => store.get(id));
  } catch (error) {
    console.warn("History unavailable", error);
    return undefined;
  }
}

/// Saves (or merges into) a song record. Returns false if storage failed.
export async function saveSong(record) {
  try {
    const existing = (await getSong(record.id)) ?? {};
    await withStore("readwrite", (store) => store.put({ ...existing, ...record }));
    // Ask the browser not to evict the history under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    return true;
  } catch (error) {
    console.warn("Could not save the song to the history", error);
    return false;
  }
}

export async function listSongs() {
  try {
    const songs = await withStore("readonly", (store) => store.getAll());
    return songs.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.warn("History unavailable", error);
    return [];
  }
}

export async function deleteSong(id) {
  try {
    await withStore("readwrite", (store) => store.delete(id));
  } catch (error) {
    console.warn("Could not delete the song", error);
  }
}

/// Bytes used by this site (history + cached model), if the browser reports it.
export async function storageUsage() {
  try {
    const { usage } = await navigator.storage.estimate();
    return usage ?? null;
  } catch {
    return null;
  }
}
