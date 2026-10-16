"use strict";

const POLL_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const $ = (id) => document.getElementById(id);

const form = $("form");
const fileInput = $("audio");
const submitButton = $("submit");
const statusSection = $("status");
const resultSection = $("result");

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function setStatus(text, { busy = true, progress = "", error = "" } = {}) {
  show(statusSection, true);
  $("status-text").textContent = text;
  $("progress").textContent = progress;
  show($("spinner"), busy);
  const errorBox = $("error");
  errorBox.textContent = error;
  show(errorBox, error !== "");
}

function setUploadProgress(fraction) {
  show($("upload-bar"), fraction !== null);
  if (fraction !== null) {
    $("upload-fill").style.width = `${Math.round(fraction * 100)}%`;
  }
}

function tuningValue() {
  const selected = $("tuning").value;
  return selected === "custom" ? $("tuning-custom").value.trim() : selected;
}

function buildFormData() {
  const data = new FormData();
  data.append("tuning", tuningValue());
  data.append("frets", $("frets").value);
  data.append("bpm", $("bpm").value);
  data.append("separate", $("separate").checked ? "true" : "false");
  // The audio goes last so the options are validated before the file is stored.
  data.append("audio", fileInput.files[0]);
  return data;
}

// fetch() cannot report upload progress, so the upload uses XMLHttpRequest.
function uploadJob(data) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/jobs");
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      const body = request.response || {};
      if (request.status === 202) {
        resolve(body.id);
      } else {
        reject(new Error(body.error || `Upload failed (HTTP ${request.status})`));
      }
    };
    request.onerror = () => reject(new Error("Network error while uploading"));
    request.send(data);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchStatus(id) {
  const response = await fetch(`/api/jobs/${id}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { fatal: response.status === 404 });
  }
  return body;
}

function describe(job) {
  if (job.status === "queued") {
    return `Waiting in the queue (position ${job.queue_position})`;
  }
  return "Transcribing: separating the bass and detecting notes. This can take several minutes.";
}

async function waitForJob(id) {
  let consecutiveErrors = 0;
  for (;;) {
    try {
      const job = await fetchStatus(id);
      consecutiveErrors = 0;
      if (job.status === "done" || job.status === "failed") {
        return job;
      }
      setStatus(describe(job), { progress: job.progress });
    } catch (error) {
      consecutiveErrors += 1;
      if (error.fatal || consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw error;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

function showResult(id, job) {
  $("tab").textContent = job.tab;
  const midiLink = $("download-midi");
  midiLink.hidden = !job.has_midi;
  midiLink.href = `/api/jobs/${id}/midi`;
  show(resultSection, true);
  resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function onSubmit(event) {
  event.preventDefault();
  if (!fileInput.files.length) {
    return;
  }
  if (tuningValue() === "") {
    setStatus("Enter the tuning notes, for example E1 A1 D2 G2.", { busy: false, error: "Custom tuning is empty." });
    return;
  }

  submitButton.disabled = true;
  show(resultSection, false);
  setUploadProgress(0);
  setStatus("Uploading...");
  try {
    const id = await uploadJob(buildFormData());
    setUploadProgress(null);
    setStatus("Queued");
    const job = await waitForJob(id);
    if (job.status === "failed") {
      setStatus("The transcription failed", { busy: false, error: job.error });
    } else {
      setStatus("Done", { busy: false });
      showResult(id, job);
    }
  } catch (error) {
    setUploadProgress(null);
    setStatus("Something went wrong", { busy: false, error: error.message });
  } finally {
    submitButton.disabled = false;
  }
}

function showChosenFile() {
  const file = fileInput.files[0];
  $("file-label").textContent = file ? `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)` : "Click to choose a file, or drop it here";
}

function setUpDropZone() {
  const drop = $("drop");
  for (const name of ["dragenter", "dragover"]) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add("border-amber-500");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("border-amber-500");
    });
  }
  drop.addEventListener("drop", (event) => {
    if (event.dataTransfer.files.length) {
      fileInput.files = event.dataTransfer.files;
      showChosenFile();
    }
  });
}

function main() {
  form.addEventListener("submit", onSubmit);
  fileInput.addEventListener("change", showChosenFile);
  $("tuning").addEventListener("change", () => {
    $("tuning-custom").hidden = $("tuning").value !== "custom";
  });
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("tab").textContent);
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy"), 1500);
  });
  $("download-tab").addEventListener("click", () => download("bassline-tab.txt", $("tab").textContent));
  setUpDropZone();
}

main();
