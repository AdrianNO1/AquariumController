export const fakeEspConsoleHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Fake ESP console</title>
    <link rel="stylesheet" href="/console.css">
    <script src="/console.js" defer></script>
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">
        <span class="brand-mark">AQ</span>
        <span><strong>Fake ESPs</strong><small>Simulator console</small></span>
      </a>
      <div class="connection" role="status">
        <span class="connection-dot" aria-hidden="true"></span>
        <span id="connection-label">Connecting</span>
      </div>
    </header>
    <main>
      <div class="page-heading">
        <div>
          <p class="eyebrow">Local test equipment</p>
          <h1>Fake ESP32 devices</h1>
          <p class="lede">Power, network, pin output, and response fault controls.</p>
        </div>
        <button id="refresh-button" class="button secondary" type="button">Refresh</button>
      </div>
      <section id="summary" class="summary" aria-label="Simulator summary"></section>
      <p id="action-status" class="action-status" role="status"></p>
      <section id="device-grid" class="device-grid" aria-label="Fake ESP devices"></section>
    </main>
  </body>
</html>
`;

export const fakeEspConsoleCss = `
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --bg: #03161b;
  --surface: #082229;
  --surface-strong: #0c3038;
  --border: rgba(118, 199, 192, 0.19);
  --border-strong: rgba(118, 199, 192, 0.38);
  --text: #edf7f6;
  --muted: #91aaa8;
  --subtle: #6ec8c1;
  --accent: #75d9d0;
  --good: #4bc093;
  --warn: #e7bd67;
  --bad: #ed8074;
}

* { box-sizing: border-box; }

body {
  min-width: 320px;
  margin: 0;
  color: var(--text);
  background:
    radial-gradient(circle at 14% 0%, rgba(28, 111, 115, 0.14), transparent 34rem),
    var(--bg);
}

button,
input {
  font: inherit;
}

button {
  min-height: 34px;
  padding: 6px 11px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--text);
  background: var(--surface-strong);
  font-weight: 720;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }
button:disabled { cursor: wait; opacity: 0.55; }
button.danger { border-color: rgba(237, 128, 116, 0.45); color: #ffb6ae; }
button.good { border-color: rgba(75, 192, 147, 0.55); color: #8ae4bd; }

input {
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text);
  background: #061d23;
}

input[type="checkbox"] {
  width: 17px;
  min-height: 17px;
  accent-color: var(--accent);
}

.site-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 8px max(16px, calc((100vw - 1500px) / 2));
  border-bottom: 1px solid var(--border);
  background: rgba(3, 22, 27, 0.94);
  backdrop-filter: blur(12px);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
  text-decoration: none;
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  color: var(--accent);
  font-size: 0.72rem;
}

.brand strong,
.brand small {
  display: block;
}

.brand small {
  margin-top: 1px;
  color: var(--muted);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.connection {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 0.78rem;
}

.connection-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--warn);
  box-shadow: 0 0 0 3px rgba(231, 189, 103, 0.12);
}

.connection.connected .connection-dot {
  background: var(--good);
  box-shadow: 0 0 0 3px rgba(75, 192, 147, 0.12);
}

main {
  width: min(100% - 28px, 1500px);
  margin: 0 auto;
  padding: 22px 0 50px;
}

.page-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  font-size: clamp(1.65rem, 3vw, 2.15rem);
  letter-spacing: -0.04em;
}

h2 {
  font-size: 1.15rem;
  letter-spacing: -0.02em;
}

.eyebrow,
.section-label {
  color: var(--subtle);
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.eyebrow { margin-bottom: 4px; }
.lede { margin-top: 4px; color: var(--muted); font-size: 0.82rem; }

.summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.summary-item {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: rgba(8, 34, 41, 0.7);
}

.summary-item span,
.summary-item strong {
  display: block;
}

.summary-item span {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 0.65rem;
  text-transform: uppercase;
}

.summary-item strong { font-size: 1rem; }

.action-status {
  min-height: 21px;
  margin: 2px 2px 8px;
  color: var(--muted);
  font-size: 0.76rem;
}

.action-status.error { color: #ffb6ae; }

.device-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px;
}

.device-card {
  overflow: hidden;
  border: 1px solid var(--border);
  border-left: 4px solid var(--good);
  border-radius: 8px;
  background: rgba(8, 34, 41, 0.84);
}

.device-card.network-off {
  border-left-color: var(--warn);
  background: rgba(65, 47, 18, 0.34);
}

.device-card.power-off {
  border-left-color: var(--bad);
  background: rgba(66, 28, 27, 0.34);
}

.device-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 13px 10px;
  border-bottom: 1px solid var(--border);
}

.device-title {
  display: flex;
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 9px;
}

.device-title h2 {
  overflow: hidden;
  max-width: 22rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-id {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 7px;
  border-radius: 999px;
  color: #b5f1d9;
  background: rgba(75, 192, 147, 0.14);
  font-size: 0.65rem;
  font-weight: 800;
}

.badge.warn {
  color: #f4d38f;
  background: rgba(231, 189, 103, 0.14);
}

.badge.bad {
  color: #ffb6ae;
  background: rgba(237, 128, 116, 0.14);
}

.device-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.device-body {
  padding: 11px 13px 13px;
}

.device-meta {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}

.meta-item span,
.meta-item strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-item span {
  margin-bottom: 3px;
  color: var(--muted);
  font-size: 0.62rem;
  text-transform: uppercase;
}

.meta-item strong {
  font-size: 0.75rem;
  font-weight: 700;
}

.device-section + .device-section {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.section-heading small { color: var(--muted); }

.pin-list {
  display: grid;
  gap: 5px;
}

.pin-row {
  display: grid;
  grid-template-columns: 54px minmax(90px, 1fr) 55px 92px auto;
  align-items: center;
  gap: 8px;
  min-height: 34px;
}

.pin-number {
  font-weight: 800;
  white-space: nowrap;
}

.pin-track {
  overflow: hidden;
  height: 8px;
  border-radius: 999px;
  background: rgba(112, 160, 157, 0.15);
}

.pin-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #4d77d4, #75d9d0);
}

.pin-value {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 800;
}

.pin-raw {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.68rem;
}

.pin-failure {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-size: 0.68rem;
  white-space: nowrap;
}

.empty {
  padding: 8px 0;
  color: var(--muted);
  font-size: 0.75rem;
}

.fault-form {
  display: grid;
  grid-template-columns: 100px repeat(3, minmax(0, 1fr)) auto;
  align-items: end;
  gap: 8px;
}

.fault-form label > span {
  display: block;
  margin-bottom: 3px;
  color: var(--muted);
  font-size: 0.62rem;
  text-transform: uppercase;
}

.check-field {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 0.72rem;
}

.last-error {
  margin-top: 9px;
  color: #ffb6ae;
  font-size: 0.72rem;
}

@media (max-width: 1050px) {
  .device-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 720px) {
  .site-header { align-items: flex-start; flex-direction: column; gap: 5px; }
  main { width: min(100% - 18px, 1500px); padding-top: 14px; }
  .page-heading { align-items: flex-start; flex-direction: column; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .device-header { flex-direction: column; }
  .device-actions { justify-content: flex-start; }
  .device-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fault-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fault-form button { grid-column: 1 / -1; }
  .pin-row {
    grid-template-columns: 42px minmax(70px, 1fr) 48px;
  }
  .pin-raw { display: none; }
  .pin-failure { grid-column: 2 / -1; }
}
`;

export const fakeEspConsoleJavaScript = `
"use strict";

const connection = document.querySelector(".connection");
const connectionLabel = document.getElementById("connection-label");
const summary = document.getElementById("summary");
const deviceGrid = document.getElementById("device-grid");
const actionStatus = document.getElementById("action-status");
const refreshButton = document.getElementById("refresh-button");
let latestSnapshot = null;
let controlActionPending = false;
const faultDrafts = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setConnection(connected) {
  connection.classList.toggle("connected", connected);
  connectionLabel.textContent = connected ? "Simulator connected" : "Reconnecting";
}

function setAction(message, error) {
  actionStatus.textContent = message;
  actionStatus.classList.toggle("error", Boolean(error));
}

function render(snapshot, force) {
  latestSnapshot = snapshot;
  renderSummary(snapshot);
  const active = document.activeElement;
  const editing =
    active &&
    deviceGrid.contains(active) &&
    (active.tagName === "INPUT" ||
      active.tagName === "SELECT" ||
      active.tagName === "BUTTON");
  if ((editing || controlActionPending) && !force) return;
  deviceGrid.replaceChildren(...snapshot.devices.map(deviceCard));
}

function renderSummary(snapshot) {
  const powered = snapshot.devices.filter((device) => device.powered).length;
  const connected = snapshot.devices.filter(
    (device) => device.powered && device.networkEnabled && device.mqttConnected,
  ).length;
  const activePins = snapshot.devices.reduce(
    (count, device) => count + device.pins.filter((pin) => pin.attached).length,
    0,
  );
  const faulted = snapshot.devices.filter((device) => {
    const faults = device.responseFaults;
    return (
      faults.drop ||
      faults.malformed ||
      faults.delayMilliseconds > 0 ||
      faults.duplicateResponses > 0 ||
      device.pins.some((pin) => pin.attachmentFailure)
    );
  }).length;
  summary.replaceChildren(
    summaryItem("Power", powered + " / " + snapshot.devices.length + " on"),
    summaryItem("MQTT", connected + " connected"),
    summaryItem("Attached pins", String(activePins)),
    summaryItem("Injected faults", String(faulted)),
  );
}

function summaryItem(label, value) {
  const item = element("article", "summary-item");
  item.append(element("span", "", label), element("strong", "", value));
  return item;
}

function deviceCard(device) {
  const stateClass = !device.powered
    ? " power-off"
    : !device.networkEnabled
      ? " network-off"
      : "";
  const card = element("article", "device-card" + stateClass);
  card.dataset.deviceKey = device.key;
  card.setAttribute("aria-label", "Fake ESP " + device.deviceName);

  const header = element("div", "device-header");
  const title = element("div", "device-title");
  title.append(
    element("h2", "", device.deviceName),
    element("span", "device-id", "ID: " + device.deviceId),
    stateBadge(device),
  );
  const actions = element("div", "device-actions");
  actions.append(
    actionButton(
      device.powered ? "Power off" : "Power on",
      "power",
      device.powered ? "danger" : "good",
    ),
    actionButton("Reboot", "reboot", "", !device.powered),
    actionButton(
      device.networkEnabled ? "Disconnect MQTT" : "Reconnect MQTT",
      "network",
      "",
      !device.powered,
    ),
  );
  header.append(title, actions);

  const body = element("div", "device-body");
  const metadata = element("div", "device-meta");
  metadata.append(
    metaItem("Key", device.key),
    metaItem("Firmware", device.firmwareVersion),
    metaItem(
      "PWM",
      device.frequencyHz + " Hz / " + device.resolutionBits + "-bit",
    ),
    metaItem("Local UTC", formatMinute(device.currentMinuteOfDay)),
    metaItem("Schedule", device.scheduleBytes + " bytes"),
  );
  body.append(metadata, pinsSection(device), faultsSection(device));
  if (device.lastError) {
    body.append(
      element(
        "p",
        "last-error",
        "Last " +
          device.lastError.severity +
          ": " +
          device.lastError.message,
      ),
    );
  }
  card.append(header, body);
  return card;
}

function stateBadge(device) {
  if (!device.powered) return element("span", "badge bad", "Power off");
  if (!device.networkEnabled) return element("span", "badge warn", "MQTT isolated");
  if (!device.mqttConnected) return element("span", "badge warn", "Connecting");
  return element("span", "badge", "Online");
}

function actionButton(label, action, className, disabled) {
  const button = element("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  button.disabled = Boolean(disabled);
  return button;
}

function metaItem(label, value) {
  const item = element("div", "meta-item");
  item.append(element("span", "", label), element("strong", "", value));
  return item;
}

function pinsSection(device) {
  const section = element("section", "device-section");
  const heading = element("div", "section-heading");
  heading.append(
    element("p", "section-label", "Live pin output"),
    element(
      "small",
      "",
      device.powered ? device.pins.length + " observed" : "Outputs de-energized",
    ),
  );
  const list = element("div", "pin-list");
  if (device.pins.length === 0) {
    list.append(
      element(
        "p",
        "empty",
        device.powered
          ? "No pins have been attached or written yet."
          : "Power on the device to inspect its pins.",
      ),
    );
  } else {
    for (const pin of device.pins) list.append(pinRow(pin));
  }
  section.append(heading, list);
  return section;
}

function pinRow(pin) {
  const row = element("div", "pin-row");
  const track = element("div", "pin-track");
  const fill = element("div", "pin-fill");
  fill.style.width = Math.max(0, Math.min(100, pin.outputPercentage)) + "%";
  track.append(fill);
  const failure = element("label", "pin-failure");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = pin.attachmentFailure;
  checkbox.dataset.action = "pin-failure";
  checkbox.dataset.pin = String(pin.pin);
  failure.append(checkbox, document.createTextNode("Fail attach"));
  const source = pin.overwritten ? "override" : pin.attached ? "schedule" : "detached";
  row.append(
    element("span", "pin-number", "Pin " + pin.pin),
    track,
    element("span", "pin-value", formatPercentage(pin.outputPercentage)),
    element("span", "pin-raw", pin.outputValue + " raw · " + source),
    failure,
  );
  return row;
}

function faultsSection(device) {
  const faults = faultDrafts.get(device.key) || device.responseFaults;
  const section = element("section", "device-section");
  const heading = element("div", "section-heading");
  heading.append(
    element("p", "section-label", "Response faults"),
    element("small", "", "Applied until cleared"),
  );
  const form = element("form", "fault-form");
  form.dataset.action = "faults";
  const applyButton = actionButton("Apply faults", "apply-faults");
  applyButton.type = "submit";
  form.append(
    numberField("Delay ms", "delayMilliseconds", faults.delayMilliseconds, 0, 60000),
    numberField("Duplicates", "duplicateResponses", faults.duplicateResponses, 0, 20),
    checkField("Drop responses", "drop", faults.drop),
    checkField("Malformed", "malformed", faults.malformed),
    applyButton,
  );
  section.append(heading, form);
  return section;
}

function numberField(label, name, value, minimum, maximum) {
  const field = element("label", "");
  field.append(element("span", "", label));
  const input = document.createElement("input");
  input.type = "number";
  input.name = name;
  input.min = String(minimum);
  input.max = String(maximum);
  input.step = "1";
  input.value = String(value);
  field.append(input);
  return field;
}

function checkField(label, name, checked) {
  const field = element("label", "check-field");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = checked;
  field.append(input, document.createTextNode(label));
  return field;
}

function formatPercentage(value) {
  return (Math.round(value * 10) / 10).toFixed(value % 1 === 0 ? 0 : 1) + "%";
}

function formatMinute(minute) {
  if (minute === null) return "Clock unavailable";
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return hours + ":" + minutes;
}

async function request(path, body, onSuccess) {
  setAction("Applying simulator change…", false);
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || "Simulator request failed");
  if (onSuccess) onSuccess();
  render(result, true);
  setAction("Simulator change applied.", false);
}

async function refresh() {
  const response = await fetch("/api/snapshot", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Snapshot request failed");
  render(await response.json(), true);
  setConnection(true);
}

deviceGrid.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".device-card");
  if (!card) return;
  const device = latestSnapshot.devices.find((item) => item.key === card.dataset.deviceKey);
  if (!device) return;
  const action = button.dataset.action;
  if (action === "apply-faults") return;
  button.disabled = true;
  const operation =
    action === "power"
      ? request("/api/devices/" + encodeURIComponent(device.key) + "/power", {
          powered: !device.powered,
        })
      : action === "reboot"
        ? request("/api/devices/" + encodeURIComponent(device.key) + "/reboot", {})
        : action === "network"
          ? request("/api/devices/" + encodeURIComponent(device.key) + "/network", {
              enabled: !device.networkEnabled,
            })
          : Promise.resolve();
  operation.catch((error) => setAction(error.message, true)).finally(() => {
    button.disabled = false;
  });
});

deviceGrid.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const faultForm = input.closest('form[data-action="faults"]');
  if (faultForm) {
    rememberFaultDraft(faultForm);
    return;
  }
  if (input.dataset.action !== "pin-failure") return;
  const card = input.closest(".device-card");
  if (!card) return;
  request(
    "/api/devices/" +
      encodeURIComponent(card.dataset.deviceKey) +
      "/pin-failures/" +
      encodeURIComponent(input.dataset.pin),
    { failing: input.checked },
  ).catch((error) => setAction(error.message, true));
});

deviceGrid.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const form = input.closest('form[data-action="faults"]');
  if (form) rememberFaultDraft(form);
});

deviceGrid.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset.action !== "faults") return;
  event.preventDefault();
  const card = form.closest(".device-card");
  if (!card) return;
  const delay = form.elements.namedItem("delayMilliseconds");
  const duplicates = form.elements.namedItem("duplicateResponses");
  const drop = form.elements.namedItem("drop");
  const malformed = form.elements.namedItem("malformed");
  const deviceKey = card.dataset.deviceKey;
  rememberFaultDraft(form);
  controlActionPending = true;
  request(
    "/api/devices/" + encodeURIComponent(deviceKey) + "/faults",
    {
      delayMilliseconds: Number(delay.value),
      duplicateResponses: Number(duplicates.value),
      drop: drop.checked,
      malformed: malformed.checked,
    },
    () => faultDrafts.delete(deviceKey),
  )
    .catch((error) => setAction(error.message, true))
    .finally(() => {
      controlActionPending = false;
    });
});

function rememberFaultDraft(form) {
  const card = form.closest(".device-card");
  if (!card) return;
  const delay = form.elements.namedItem("delayMilliseconds");
  const duplicates = form.elements.namedItem("duplicateResponses");
  const drop = form.elements.namedItem("drop");
  const malformed = form.elements.namedItem("malformed");
  faultDrafts.set(card.dataset.deviceKey, {
    delayMilliseconds: Number(delay.value),
    duplicateResponses: Number(duplicates.value),
    drop: drop.checked,
    malformed: malformed.checked,
  });
}

refreshButton.addEventListener("click", () => {
  refresh().catch((error) => setAction(error.message, true));
});

const events = new EventSource("/api/events");
events.onopen = () => setConnection(true);
events.onerror = () => setConnection(false);
events.onmessage = (event) => {
  render(JSON.parse(event.data), false);
};

refresh().catch((error) => {
  setConnection(false);
  setAction(error.message, true);
});
`;
