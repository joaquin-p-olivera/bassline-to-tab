// Syncs the amp's saved takes with the user's Google Drive, straight from the
// page (Google Identity Services + Drive REST API). How takes are stored on
// Drive: README, "Google Drive sync".
//
// A local take remembers its Drive file (`driveFileId`): that is how a sync
// tells a take deleted on another device (linked, gone from Drive) from a new
// one (never linked). When both sides have it, the newer `updatedAt` wins.

import { GOOGLE_CLIENT_ID } from "./drive-config.js";
import { deleteTake, getTake, listTakes, saveTake } from "./storage.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_URL = "https://accounts.google.com/gsi/client";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "Bassline to Tab · amp takes";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TAKE_KIND = "amp-take";
const FOLDER_KIND = "amp-takes-folder";
/// localStorage: the Google account last synced ({ email }), and Drive files
/// of takes deleted here that still have to be removed from Drive.
const ACCOUNT_KEY = "bassline-to-tab.drive-account";
const PENDING_DELETES_KEY = "bassline-to-tab.drive-pending-deletes";

export const driveConfigured = Boolean(GOOGLE_CLIENT_ID);

let token = null;
let tokenClient = null;
let pendingToken = null;
let folderId = null;
let scriptPromise = null;

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered; the next sync asks again.
  }
}

/// The account this browser last synced with, or null.
export function driveAccount() {
  return readLocal(ACCOUNT_KEY, null);
}

/// True while there is a usable access token (about an hour after connecting).
export function driveConnected() {
  return Boolean(token && Date.now() < token.expiresAt);
}

/// Loads Google's sign-in script ahead of the click, so the popup opens
/// straight from the user's gesture.
export function preloadDrive() {
  if (!driveConfigured) return Promise.resolve();
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_URL;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load Google sign-in. Check the connection or any blocker."));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/// Asks Google for an access token. Call it from a click: the first time it
/// opens the consent popup, later ones close by themselves.
export async function connectDrive() {
  await preloadDrive();
  tokenClient ??= google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: (response) => {
      if (response.error) pendingToken?.reject(new Error(response.error_description || response.error));
      else pendingToken?.resolve(response);
    },
    error_callback: (error) => {
      const closed = error.type === "popup_closed";
      pendingToken?.reject(new Error(closed ? "The Google window was closed before finishing." : error.message || error.type));
    },
  });
  const response = await new Promise((resolve, reject) => {
    pendingToken = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: driveAccount() ? "" : "consent" });
  });
  pendingToken = null;
  token = { value: response.access_token, expiresAt: Date.now() + (Number(response.expires_in) - 60) * 1000 };

  // Takes linked to another account's files must not read as "deleted on
  // Drive" here: forget the links when the account changes.
  const { user } = await api("/about?fields=user(emailAddress)");
  const previous = driveAccount();
  if (previous && previous.email !== user.emailAddress) await forgetLinks();
  writeLocal(ACCOUNT_KEY, { email: user.emailAddress });
  if (previous?.email !== user.emailAddress) folderId = null;
  return user.emailAddress;
}

/// Stops syncing in this browser. The takes stay here and on Drive.
export async function disconnectDrive() {
  if (token) google.accounts.oauth2.revoke(token.value, () => {});
  token = null;
  folderId = null;
  writeLocal(ACCOUNT_KEY, null);
  writeLocal(PENDING_DELETES_KEY, null);
  await forgetLinks();
}

async function forgetLinks() {
  for (const take of await listTakes()) {
    if (take.driveFileId) await saveTake({ id: take.id, driveFileId: null });
  }
}

export class DriveAuthError extends Error {}

async function api(path, { method = "GET", body, headers = {}, upload = false, raw = false } = {}) {
  if (!driveConnected()) throw new DriveAuthError("Google Drive needs to be connected again.");
  const response = await fetch(`${upload ? UPLOAD_API : API}${path}`, {
    method,
    body,
    headers: { Authorization: `Bearer ${token.value}`, ...headers },
  });
  if (response.status === 401) {
    token = null;
    throw new DriveAuthError("Google Drive needs to be connected again.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = (await response.json()).error?.message ?? message;
    } catch {
      // Keep the status line.
    }
    const error = new Error(`Google Drive: ${message}`);
    error.status = response.status;
    throw error;
  }
  return raw ? response : response.json();
}

const json = (value) => ({ body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });
const quoted = (value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function listFiles(query, fields) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${fields})`, pageSize: "100", spaces: "drive" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await api(`/files?${params}`);
    files.push(...page.files);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

async function folder() {
  if (folderId) return folderId;
  const [existing] = await listFiles(
    `mimeType=${quoted(FOLDER_MIME)} and appProperties has { key='kind' and value=${quoted(FOLDER_KIND)} } and trashed=false`,
    "id",
  );
  folderId =
    existing?.id ??
    (await api("/files?fields=id", { method: "POST", ...json({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { kind: FOLDER_KIND } }) })).id;
  return folderId;
}

function mimeOf(take) {
  return (take.audio?.type || "audio/webm").split(";")[0];
}

const EXTENSIONS = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav" };

function metadataOf(take) {
  return {
    name: `${take.name}.${EXTENSIONS[mimeOf(take)] ?? "webm"}`,
    description: JSON.stringify({
      name: take.name,
      createdAt: take.createdAt,
      duration: take.duration,
      updatedAt: take.updatedAt ?? take.createdAt,
      settings: take.settings,
    }),
  };
}

async function upload(take) {
  const metadata = {
    ...metadataOf(take),
    mimeType: mimeOf(take),
    parents: [await folder()],
    appProperties: { kind: TAKE_KIND, takeId: take.id },
  };
  const boundary = `bassline-${crypto.randomUUID?.() ?? Date.now()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`,
    take.audio,
    `\r\n--${boundary}--`,
  ]);
  const { id } = await api("/files?uploadType=multipart&fields=id", {
    method: "POST",
    upload: true,
    body,
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  await saveTake({ id: take.id, driveFileId: id });
}

async function updateMetadata(take) {
  await api(`/files/${take.driveFileId}?fields=id`, { method: "PATCH", ...json(metadataOf(take)) });
}

async function trash(fileId) {
  try {
    await api(`/files/${fileId}?fields=id`, { method: "PATCH", ...json({ trashed: true }) });
  } catch (error) {
    // Already gone, or a file of another account.
    if (error.status !== 404 && error.status !== 403) throw error;
  }
}

/// The takes on Drive, by take id.
async function remoteTakes() {
  const files = await listFiles(
    `appProperties has { key='kind' and value=${quoted(TAKE_KIND)} } and trashed=false`,
    "id,name,description,appProperties",
  );
  const takes = new Map();
  for (const file of files) {
    let meta = {};
    try {
      meta = JSON.parse(file.description ?? "{}") ?? {};
    } catch {
      // A description edited by hand: keep the audio, defaults for the rest.
    }
    const takeId = file.appProperties?.takeId;
    if (takeId) takes.set(takeId, { fileId: file.id, fileName: file.name, meta });
  }
  return takes;
}

/// Brings this browser and Drive up to date. Returns how many takes were
/// uploaded, downloaded, updated and deleted here.
export async function syncTakes() {
  const counts = { uploaded: 0, downloaded: 0, updated: 0, deleted: 0 };
  const pending = readLocal(PENDING_DELETES_KEY, []);
  for (const fileId of pending) await trash(fileId);
  writeLocal(PENDING_DELETES_KEY, null);

  const remote = await remoteTakes();
  for (const fileId of pending) {
    for (const [takeId, file] of remote) if (file.fileId === fileId) remote.delete(takeId);
  }

  for (const take of await listTakes()) {
    const file = remote.get(take.id);
    remote.delete(take.id);
    if (!file) {
      if (take.driveFileId) {
        await deleteTake(take.id);
        counts.deleted++;
      } else {
        await upload(take);
        counts.uploaded++;
      }
      continue;
    }
    const linked = { ...take, driveFileId: file.fileId };
    if (take.driveFileId !== file.fileId) await saveTake({ id: take.id, driveFileId: file.fileId });
    const here = take.updatedAt ?? take.createdAt ?? 0;
    const there = file.meta.updatedAt ?? 0;
    if (here > there) {
      await updateMetadata(linked);
    } else if (there > here) {
      await saveTake({
        id: take.id,
        name: file.meta.name ?? take.name,
        settings: file.meta.settings ?? take.settings,
        updatedAt: there,
      });
      counts.updated++;
    }
  }

  for (const [takeId, file] of remote) {
    const response = await api(`/files/${file.fileId}?alt=media`, { raw: true });
    const audio = await response.blob();
    const { meta } = file;
    await saveTake({
      id: takeId,
      name: meta.name ?? file.fileName.replace(/\.[^.]+$/, ""),
      createdAt: meta.createdAt ?? Date.now(),
      duration: meta.duration ?? 0,
      updatedAt: meta.updatedAt ?? 0,
      settings: meta.settings ?? {},
      audio,
      driveFileId: file.fileId,
    });
    counts.downloaded++;
  }
  return counts;
}

/// Sends one take's latest state to Drive (new take, rename, new settings).
/// Does nothing unless connected; a later sync catches up otherwise.
export async function pushTake(id) {
  if (!driveConnected()) return;
  const take = await getTake(id);
  if (!take) return;
  if (take.driveFileId) await updateMetadata(take);
  else await upload(take);
}

/// Removes a deleted take's file from Drive, now or at the next sync.
export async function forgetTake(take) {
  if (!take.driveFileId) return;
  if (driveConnected()) {
    try {
      await trash(take.driveFileId);
      return;
    } catch {
      // Retried at the next sync.
    }
  }
  writeLocal(PENDING_DELETES_KEY, [...readLocal(PENDING_DELETES_KEY, []), take.driveFileId]);
}
