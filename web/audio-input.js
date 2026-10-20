// Audio input picker shared by the pages that listen to the bass: lists the
// microphones and audio interfaces the browser sees, remembers the choice and
// opens it. A bass plugged into a USB interface shows up as one more input.

const KEY = "bassline-to-tab.audio-input";
const DEFAULT = "";

/// Echo cancellation, noise suppression and gain control are made for voices:
/// they filter out and pump the low, sustained notes of a bass.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

function remembered() {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function remember(deviceId) {
  try {
    if (deviceId) localStorage.setItem(KEY, deviceId);
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; the page works the same.
  }
}

/// Fills `select` with the audio inputs and keeps it up to date as devices
/// come and go. Browsers only give names after the page was allowed to use
/// the microphone, so the list is filled again once a stream opens.
export function setupInputSelect(select) {
  select.addEventListener("change", () => remember(select.value));
  navigator.mediaDevices?.addEventListener?.("devicechange", () => refreshInputs(select));
  return refreshInputs(select);
}

export async function refreshInputs(select) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    select.disabled = true;
    return;
  }
  let inputs = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // "default" and "communications" are aliases of a real device (Chrome);
    // an empty id means the page cannot see the devices yet.
    inputs = devices.filter(
      (d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications",
    );
  } catch {
    // Keep only the default input.
  }

  const wanted = remembered();
  select.replaceChildren(new Option("Default input", DEFAULT));
  inputs.forEach((device, i) => select.add(new Option(device.label || `Input ${i + 1}`, device.deviceId)));
  // A remembered device that is unplugged stays listed until it comes back,
  // so the choice is not lost; opening it falls back to the default input.
  if (wanted && !inputs.some((d) => d.deviceId === wanted)) {
    select.add(new Option("Remembered input (not connected)", wanted));
  }
  select.value = wanted;
}

/// Opens the input chosen in `select`. If that device is gone, opens the
/// default input instead and reports `fellBack`. Errors other than a missing
/// device (blocked permission, no input at all) are thrown as they come.
export async function openInput(select) {
  const deviceId = select.value;
  let stream;
  let fellBack = false;
  if (deviceId) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW, deviceId: { exact: deviceId } } });
    } catch (error) {
      if (error.name !== "OverconstrainedError" && error.name !== "NotFoundError") throw error;
      fellBack = true;
    }
  }
  stream ??= await navigator.mediaDevices.getUserMedia({ audio: RAW });
  await refreshInputs(select);
  return { stream, fellBack };
}
