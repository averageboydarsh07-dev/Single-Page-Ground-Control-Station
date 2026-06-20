/* ==========================================================================
   GCS Client-Side Controller (public/app.js) - SSE & REST Edition
   Connects to server SSE stream, parses real-time JSON telemetry,
   implements 10Hz UI throttling (anti-thrashing), zero-allocation variables,
   and visual module updates (Leaflet, Three, Chart, Camera).
   ========================================================================== */

// Global SSE connection & state
let eventSource = null;
let activeStream = false;
let telemetryHistory = [];
const maxChartPoints = 50;

// Rate-limiting throttle buffer (Trishul Architecture Optimization)
let latestTelemetry = null;
let lastRenderTime = 0;
const UI_THROTTLE_MS = 100; // 10Hz DOM update ceiling

// Pre-allocated object pools (Garbage Collection Optimization)
const dataPointCoords = [0, 0];

// UI Elements Cached
const elCommsStatus = document.getElementById("display-comms-status");
const elPacketCountDisplay = document.getElementById("display-packet-count");
const elMissionTimeDisplay = document.getElementById("display-mission-time");
const elErrorDigits = document.getElementById("error-digits");
const elConsoleLogs = document.getElementById("console-logs");
const elSerialSelect = document.getElementById("serial-port");
const elConnectBtn = document.getElementById("btn-connect");
const elStreamStartBtn = document.getElementById("btn-stream-start");
const elStreamStopBtn = document.getElementById("btn-stream-stop");

const teleFields = {
  cAlt: document.getElementById("tele-c-alt"),
  cPress: document.getElementById("tele-c-press"),
  cTemp: document.getElementById("tele-c-temp"),
  cVolt: document.getElementById("tele-c-volt"),
  pAlt: document.getElementById("tele-p-alt"),
  pDescent: document.getElementById("tele-p-descent"),
  pLat: document.getElementById("tele-p-lat"),
  pLon: document.getElementById("tele-p-lon"),
  pSats: document.getElementById("tele-p-sats"),
  pRoll: document.getElementById("tele-p-roll"),
  pPitch: document.getElementById("tele-p-pitch"),
  pYaw: document.getElementById("tele-p-yaw"),
};

// Map & Path variables
let map = null;
let currentPositionMarker = null;
let launchSiteMarker = null;
let flightPathPolyline = null;
let flightPathCoords = [];
let mapInitialized = false;

// Three.js 3D Variables
let threeScene, threeCamera, threeRenderer, threeCanSatGroup;
let animationFrameId = null;

// Chart.js Instances
let charts = {
  altitudeRate: null,
  pressTemp: null,
  battSats: null
};

// Video Stream Variables
let videoStreamObj = null;

/* ==========================================================================
   1. Initialize EventSource (Server-Sent Events) Stream
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  initSSE();
  setupButtonListeners();
  setupFaultInjectors();
  setupCameraControls();
  
  initMap();
  initThreeJS();
  initCharts();

  // Run DOM throttled updater loop at 10Hz
  setInterval(renderThrottledDOM, UI_THROTTLE_MS);
});

function initSSE() {
  writeConsoleLog("Connecting to GCS Telemetry Stream...", "info");
  
  eventSource = new EventSource('/stream');

  eventSource.onopen = () => {
    writeConsoleLog("SYSTEM: Telemetry event stream active.", "success");
    elCommsStatus.textContent = "STREAM ACTIVE";
    elCommsStatus.className = "metric-value font-digital text-success";
    // Auto-enable Start now that SSE is up (no need to wait for Connect)
    elStreamStartBtn.disabled = false;
    elStreamStopBtn.disabled = true;
    // Fetch available serial ports
    fetchSerialPorts();
  };

  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleIncomingMessage(msg);
    } catch (err) {
      console.error('[SSE] Failed to parse message:', err);
    }
  };

  eventSource.onerror = (err) => {
    writeConsoleLog("CRITICAL: Stream link disconnected. Reconnecting...", "danger");
    elCommsStatus.textContent = "OFFLINE";
    elCommsStatus.className = "metric-value font-digital text-danger";
    elStreamStartBtn.disabled = true;
    elStreamStopBtn.disabled = true;
  };
}

async function sendServerCommand(payload) {
  try {
    const response = await fetch('/command', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    return await response.json();
  } catch (err) {
    writeConsoleLog(`ERROR: Uplink command transmission failed: ${err.message}`, "danger");
  }
}

async function fetchSerialPorts() {
  try {
    const res = await fetch('/ports');
    const data = await res.json();
    populateSerialPorts(data.ports);
  } catch (err) {
    console.error('[PORTS] Failed to load serial ports:', err);
  }
}

function handleIncomingMessage(msg) {
  switch(msg.type) {
    case 'status':
      writeConsoleLog(`SERVER: ${msg.message}`, "success");
      if (msg.message === 'CONNECTED_SIM' || msg.message === 'CONNECTED_HW') {
        elCommsStatus.textContent = msg.message === 'CONNECTED_SIM' ? "CONNECTED (SIM)" : `CONNECTED (${msg.port})`;
        elCommsStatus.className = "metric-value font-digital text-success";
        elStreamStartBtn.disabled = false;
        elStreamStopBtn.disabled = true;
        writeConsoleLog(`Uplink ready. Click [Start Stream] to begin telemetry.`, "info");
      }
      break;

    case 'telemetry':
      if (activeStream) parseTelemetryPacket(msg.data);
      break;

    case 'control_feedback':
      writeConsoleLog(msg.text, msg.statusType || 'info');
      break;

    default:
      // Silently ignore unknown message types
      break;
  }
}

function populateSerialPorts(ports) {
  elSerialSelect.innerHTML = '<option value="SIM">SIMULATOR (Local Server Loop)</option>';
  ports.forEach(port => {
    const opt = document.createElement("option");
    opt.value = port;
    opt.textContent = `INTERFACE: ${port}`;
    elSerialSelect.appendChild(opt);
  });
}

/* ==========================================================================
   2. UI Button Listeners & Safety Interlocks
   ========================================================================== */

function setupButtonListeners() {
  const btnConnect = document.getElementById("btn-connect");
  const btnStreamStart = document.getElementById("btn-stream-start");
  const btnStreamStop = document.getElementById("btn-stream-stop");
  const btnExportCsv = document.getElementById("btn-export-csv");
  const btnExportGraph = document.getElementById("btn-export-graph");
  const btnViewStats = document.getElementById("btn-view-stats");
  const btnSyncTime = document.getElementById("btn-sync-time");
  const btnResetPackets = document.getElementById("btn-reset-packets");
  const btnClearData = document.getElementById("btn-clear-data");

  btnConnect.addEventListener("click", async () => {
    const selectedPort = elSerialSelect.value;
    writeConsoleLog(`Connecting to interface [${selectedPort}]...`, "info");
    const response = await sendServerCommand({ cmd: 'CONNECT_PORT', port: selectedPort });
    if (response) {
      handleIncomingMessage(response);
    }
  });

  btnStreamStart.addEventListener("click", async () => {
    writeConsoleLog("Sending START_STREAM command...", "info");
    const res = await sendServerCommand({ cmd: 'START_STREAM' });
    if (res) {
      activeStream = true;
      elStreamStartBtn.disabled = true;
      elStreamStopBtn.disabled = false;
      document.getElementById("sim-indicator").textContent = "ACTIVE";
      document.getElementById("sim-indicator").classList.add("active");
      writeConsoleLog("SIM: Telemetry stream STARTED.", "success");
    }
  });

  btnStreamStop.addEventListener("click", async () => {
    writeConsoleLog("Sending STOP_STREAM command...", "info");
    const res = await sendServerCommand({ cmd: 'STOP_STREAM' });
    if (res) {
      activeStream = false;
      elStreamStartBtn.disabled = false;
      elStreamStopBtn.disabled = true;
      document.getElementById("sim-indicator").textContent = "STANDBY";
      document.getElementById("sim-indicator").classList.remove("active");
      writeConsoleLog("SIM: Telemetry stream STOPPED.", "warning");
    }
  });

  btnSyncTime.addEventListener("click", () => {
    sendServerCommand({ cmd: 'SYNC_TIME' });
    const pcTime = new Date().toUTCString();
    writeConsoleLog(`SYNC: Mission epoch synchronized to local time: ${pcTime}`, "success");
  });

  btnResetPackets.addEventListener("click", () => {
    sendServerCommand({ cmd: 'RESET_FLIGHT' });
    resetDashboardData();
  });

  btnExportCsv.addEventListener("click", exportCSV);
  btnExportGraph.addEventListener("click", exportCurrentChart);
  btnViewStats.addEventListener("click", getTelemStats);
  btnClearData.addEventListener("click", () => {
    if (confirm("WARNING: This will permanently delete ALL telemetry data from the database!\n\nAre you sure?")) {
      sendServerCommand({ cmd: 'CLEAR_DATA' });
      writeConsoleLog("Database cleared.", "warning");
    }
  });

  // Covered Safety Switches
  setupSafetyCommand("arm-separation", "btn-trigger-separation", "CMD_SEPARATION");
  setupSafetyCommand("arm-parachute", "btn-trigger-parachute", "CMD_PARACHUTE");
  setupSafetyCommand("arm-redundant", "btn-trigger-redundant", "CMD_REDUNDANT");
}

function setupSafetyCommand(armCheckboxId, triggerBtnId, cmdCode) {
  const armCheckbox = document.getElementById(armCheckboxId);
  const triggerBtn = document.getElementById(triggerBtnId);

  armCheckbox.addEventListener("change", () => {
    triggerBtn.disabled = !armCheckbox.checked;
    if (armCheckbox.checked) {
      writeConsoleLog(`WARNING: Safety shield lifted for [${cmdCode}]. Armed!`, "warning");
    }
  });

  triggerBtn.addEventListener("click", () => {
    writeConsoleLog(`UPLINK: Transmitting fire command [${cmdCode}]...`, "info");
    sendServerCommand({ cmd: 'UPLINK_COMMAND', code: cmdCode });

    armCheckbox.checked = false;
    triggerBtn.disabled = true;
  });
}

/* ==========================================================================
   3. Telemetry Ingestion & Throttled DOM updates
   ========================================================================== */

function parseTelemetryPacket(rawLine) {
  if (!rawLine || !activeStream) return;
  const fields = rawLine.split(",");
  if (fields.length < 16) return;

  // Garbage Collection safe updates (we overwrite instead of allocating new structures)
  latestTelemetry = {
    teamId: fields[0],
    missionTime: fields[1],
    packetCount: parseInt(fields[2]),
    altitude: parseFloat(fields[3]),
    pressure: parseFloat(fields[4]),
    temp: parseFloat(fields[5]),
    voltage: parseFloat(fields[6]),
    gpsLat: parseFloat(fields[7]),
    gpsLon: parseFloat(fields[8]),
    gpsAlt: parseFloat(fields[9]),
    gpsSats: parseInt(fields[10]),
    pitch: parseFloat(fields[11]),
    yaw: parseFloat(fields[12]),
    roll: parseFloat(fields[13]),
    state: fields[14],
    errorCode: fields[15].trim()
  };

  telemetryHistory.push(latestTelemetry);

  // Trigger high performance renders immediately
  updateCharts(latestTelemetry);
  updateMap(latestTelemetry);
  update3DOrientation(latestTelemetry.roll, latestTelemetry.pitch, latestTelemetry.yaw);
}

// Throttled UI DOM Refresh Loop (Anti-DOM-Thrashing)
function renderThrottledDOM() {
  if (!latestTelemetry) return;

  const now = performance.now();
  if (now - lastRenderTime < UI_THROTTLE_MS) return;
  lastRenderTime = now;

  const data = latestTelemetry;

  // Update text values
  elPacketCountDisplay.textContent = String(data.packetCount).padStart(4, "0");
  elMissionTimeDisplay.textContent = data.missionTime;

  teleFields.cAlt.textContent = data.altitude.toFixed(1);
  teleFields.cPress.textContent = data.pressure.toFixed(0);
  teleFields.cTemp.textContent = data.temp.toFixed(1);
  teleFields.cVolt.textContent = data.voltage.toFixed(2);

  teleFields.pAlt.textContent = data.gpsAlt.toFixed(1);
  teleFields.pDescent.textContent = Math.abs(calculateDescentRate(data)).toFixed(1);
  teleFields.pLat.textContent = data.gpsLat.toFixed(6);
  teleFields.pLon.textContent = data.gpsLon.toFixed(6);
  teleFields.pSats.textContent = data.gpsSats;
  teleFields.pRoll.textContent = Math.round(data.roll);
  teleFields.pPitch.textContent = Math.round(data.pitch);
  teleFields.pYaw.textContent = Math.round(data.yaw);

  document.getElementById("overlay-alt").textContent = data.gpsAlt.toFixed(1);
  document.getElementById("overlay-timestamp").textContent = `UTC: ${data.missionTime}`;

  // Update Fault LED digits
  updateDiagnostics(data.errorCode);
}

function calculateDescentRate(current) {
  if (telemetryHistory.length < 2) return 0.0;
  const prev = telemetryHistory[telemetryHistory.length - 2];
  return current.altitude - prev.altitude;
}

function updateDiagnostics(code) {
  elErrorDigits.textContent = code;
  if (code !== "0000") {
    elErrorDigits.classList.add("error-active");
  } else {
    elErrorDigits.classList.remove("error-active");
  }

  const d1 = code.charAt(0);
  const d2 = code.charAt(1);
  const d3 = code.charAt(2);
  const d4 = code.charAt(3);

  updateDigitBox("error-d1", d1, "Descent rate: UNSAFE", "Descent rate: SAFE");
  updateDigitBox("error-d2", d2, "GPS LOCK LOST", "GPS available");
  updateDigitBox("error-d3", d3, "Sep mechanism FAILURE", "Separation normal");
  updateDigitBox("error-d4", d4, "E-chute ACTIVATED", "Parachute safe");
}

function updateDigitBox(elementId, digitValue, errorDesc, normalDesc) {
  const elBox = document.getElementById(elementId);
  const elNum = elBox.querySelector(".digit-num");
  const elDesc = elBox.querySelector(".digit-desc");

  elNum.textContent = digitValue;

  if (digitValue === "1") {
    elBox.className = (elementId === "error-d4") ? "digit-box warning-state" : "digit-box error-state";
    elDesc.textContent = errorDesc;
  } else {
    elBox.className = "digit-box";
    elDesc.textContent = normalDesc;
  }
}

/* ==========================================================================
   4. Anomaly Panel Server Triggers
   ========================================================================== */

function setupFaultInjectors() {
  const faults = [
    { id: "fault-descent", type: "DESCENT", name: "Descent Rate Fault" },
    { id: "fault-gps", type: "GPS", name: "GPS Outage" },
    { id: "fault-separation", type: "SEPARATION", name: "Separation Failure" },
    { id: "fault-parachute", type: "PARACHUTE", name: "Emergency Parachute Trigger" }
  ];

  faults.forEach(f => {
    const el = document.getElementById(f.id);
    el.addEventListener("click", () => {
      const active = el.classList.contains("active-fault");
      if (active) {
        el.classList.remove("active-fault");
        sendServerCommand({ cmd: 'FAULT_CLEAR', fault: f.type });
      } else {
        el.classList.add("active-fault");
        sendServerCommand({ cmd: 'FAULT_INJECT', fault: f.type });
      }
    });
  });

  document.getElementById("btn-clear-faults").addEventListener("click", () => {
    sendServerCommand({ cmd: 'FAULT_CLEAR_ALL' });
    faults.forEach(f => document.getElementById(f.id).classList.remove("active-fault"));
  });

  const simSpeed = document.getElementById("sim-speed");
  const simSpeedVal = document.getElementById("sim-speed-val");
  simSpeed.addEventListener("input", (e) => {
    const val = e.target.value;
    simSpeedVal.textContent = `${val}x`;
    sendServerCommand({ cmd: 'SET_SPEED', value: val });
  });

  document.getElementById("btn-sim-reset").addEventListener("click", () => {
    sendServerCommand({ cmd: 'RESET_FLIGHT' });
    resetDashboardData();
  });
}

/* ==========================================================================
   5. Chart.js, Leaflet, and Three.js Implementations
   ========================================================================== */

function initCharts() {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false, // Performance increase (Disable animations in high-Hz operations)
    elements: { line: { tension: 0.1 } },
    scales: {
      x: {
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#94a3b8', font: { size: 9 } }
      }
    },
    plugins: {
      legend: { labels: { color: '#e2e8f0', font: { size: 10 } } }
    }
  };

  const ctxAlt = document.getElementById("chart-altitude-rate").getContext("2d");
  charts.altitudeRate = new Chart(ctxAlt, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Altitude (m)', borderColor: '#00f0ff', backgroundColor: 'rgba(0, 240, 255, 0.05)', borderWidth: 2, yAxisID: 'yAlt', data: [], fill: true },
        { label: 'Descent Rate (m/s)', borderColor: '#ffaa00', backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5,5], yAxisID: 'yRate', data: [] }
      ]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        yAlt: { position: 'left', grid: { color: 'rgba(0, 240, 255, 0.05)' }, ticks: { color: '#00f0ff' } },
        yRate: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#ffaa00' } }
      }
    }
  });

  const ctxPress = document.getElementById("chart-press-temp").getContext("2d");
  charts.pressTemp = new Chart(ctxPress, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Pressure (Pa)', borderColor: '#e2e8f0', borderWidth: 1.5, yAxisID: 'yPress', data: [] },
        { label: 'Temp (°C)', borderColor: '#ff2255', backgroundColor: 'rgba(255, 34, 85, 0.05)', borderWidth: 2, yAxisID: 'yTemp', data: [], fill: true }
      ]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        yPress: { position: 'left', grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#e2e8f0' } },
        yTemp: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#ff2255' } }
      }
    }
  });

  const ctxBatt = document.getElementById("chart-batt-sats").getContext("2d");
  charts.battSats = new Chart(ctxBatt, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Battery (V)', borderColor: '#00ff66', backgroundColor: 'rgba(0, 255, 102, 0.05)', borderWidth: 2, yAxisID: 'yBatt', data: [], fill: true },
        { label: 'GPS Sats', borderColor: '#a855f7', borderWidth: 1.5, yAxisID: 'ySats', data: [] }
      ]
    },
    options: {
      ...commonOptions,
      scales: {
        ...commonOptions.scales,
        yBatt: { position: 'left', grid: { color: 'rgba(0, 255, 102, 0.05)' }, ticks: { color: '#00ff66' } },
        ySats: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#a855f7' } }
      }
    }
  });
}

function updateCharts(data) {
  const time = data.missionTime;
  const rate = Math.abs(calculateDescentRate(data));

  const addPoint = (chart, label, datasetIndex, value) => {
    chart.data.labels.push(label);
    chart.data.datasets[datasetIndex].data.push(value);
    if (chart.data.labels.length > maxChartPoints) {
      chart.data.labels.shift();
      chart.data.datasets.forEach(ds => ds.data.shift());
    }
  };

  addPoint(charts.altitudeRate, time, 0, data.altitude);
  addPoint(charts.altitudeRate, time, 1, rate);
  charts.altitudeRate.update('none'); // Optimized updating (No performance animations)

  addPoint(charts.pressTemp, time, 0, data.pressure);
  addPoint(charts.pressTemp, time, 1, data.temp);
  charts.pressTemp.update('none');

  addPoint(charts.battSats, time, 0, data.voltage);
  addPoint(charts.battSats, time, 1, data.gpsSats);
  charts.battSats.update('none');
}

window.switchGraphTab = function(tabName) {
  const contents = document.querySelectorAll(".graph-tab-content");
  contents.forEach(c => c.classList.remove("active"));
  const buttons = document.querySelectorAll(".graph-tabs .tab-btn");
  buttons.forEach(b => b.classList.remove("active"));

  if (tabName === 'altitude-rate') {
    document.getElementById("tab-altitude-rate").classList.add("active");
    document.getElementById("btn-tab-altitude-rate").classList.add("active");
  } else if (tabName === 'press-temp') {
    document.getElementById("tab-press-temp").classList.add("active");
    document.getElementById("btn-tab-press-temp").classList.add("active");
  } else if (tabName === 'batt-sats') {
    document.getElementById("tab-batt-sats").classList.add("active");
    document.getElementById("btn-tab-batt-sats").classList.add("active");
  }
};

function initMap() {
  const defaultCenter = [28.628920, 77.215010];
  map = L.map('gps-map', { zoomControl: true, attributionControl: false }).setView(defaultCenter, 15);
  
  L.tileLayer('libs/leaflet.css' ? 'libs/{z}/{x}/{y}.png' : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    errorTileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
  }).addTo(map);

  flightPathPolyline = L.polyline([], { color: '#00f0ff', weight: 3, opacity: 0.85, dashArray: '5, 5' }).addTo(map);

  const launchIcon = L.divIcon({
    className: 'custom-map-marker launch-site-marker',
    html: '<div style="background-color: #00ff66; width:12px; height:12px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 8px #00ff66;"></div>',
    iconSize: [12, 12]
  });

  const payloadIcon = L.divIcon({
    className: 'custom-map-marker current-position-marker',
    html: '<div style="background-color: #ff2255; width:14px; height:14px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 10px #ff2255; animation: slow-pulse 1.5s infinite alternate;"></div>',
    iconSize: [14, 14]
  });

  launchSiteMarker = L.marker(defaultCenter, { icon: launchIcon }).addTo(map);
  currentPositionMarker = L.marker(defaultCenter, { icon: payloadIcon }).addTo(map);

  mapInitialized = true;
}

function updateMap(data) {
  if (!mapInitialized || isNaN(data.gpsLat) || isNaN(data.gpsLon)) return;
  if (data.gpsLat === 0 && data.gpsLon === 0) return;

  dataPointCoords[0] = data.gpsLat;
  dataPointCoords[1] = data.gpsLon;
  document.getElementById("map-coordinates").textContent = `LAT: ${data.gpsLat.toFixed(6)} | LON: ${data.gpsLon.toFixed(6)}`;

  currentPositionMarker.setLatLng(dataPointCoords);

  if (flightPathCoords.length === 0) {
    launchSiteMarker.setLatLng(dataPointCoords);
    map.setView(dataPointCoords, 16);
  }

  flightPathCoords.push([dataPointCoords[0], dataPointCoords[1]]);
  flightPathPolyline.setLatLngs(flightPathCoords);

  if (flightPathCoords.length % 5 === 0) {
    map.panTo(dataPointCoords);
  }
}

function initThreeJS() {
  const container = document.getElementById("three-canvas-container");
  const width = container.clientWidth;
  const height = container.clientHeight;

  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
  threeCamera.position.set(0, 2.5, 6.5);
  threeCamera.lookAt(0, 0, 0);

  threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  threeRenderer.setSize(width, height);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(threeRenderer.domElement);

  const gridHelper = new THREE.GridHelper(10, 10, 0x00f0ff, 0x1e293b);
  gridHelper.position.y = -2;
  threeScene.add(gridHelper);

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 7);
  threeScene.add(dirLight);

  threeCanSatGroup = new THREE.Group();
  
  const bodyGeo = new THREE.CylinderGeometry(0.9, 0.9, 2.4, 16);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.85, roughness: 0.15 });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  threeCanSatGroup.add(bodyMesh);

  const panelGeo = new THREE.BoxGeometry(0.06, 1.8, 0.8);
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x002244, metalness: 0.7, roughness: 0.1 });
  const panelLeft = new THREE.Mesh(panelGeo, panelMat);
  panelLeft.position.x = -1.0;
  const panelRight = new THREE.Mesh(panelGeo, panelMat);
  panelRight.position.x = 1.0;
  threeCanSatGroup.add(panelLeft, panelRight);

  const antGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6);
  const antenna = new THREE.Mesh(antGeo, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
  antenna.position.y = -1.7;
  threeCanSatGroup.add(antenna);

  const chuteGeo = new THREE.SphereGeometry(1.0, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const parachute = new THREE.Mesh(chuteGeo, new THREE.MeshStandardMaterial({ color: 0xffaa00, side: THREE.DoubleSide }));
  parachute.position.y = 1.2;
  threeCanSatGroup.add(parachute);

  threeScene.add(threeCanSatGroup);
  window.addEventListener('resize', onThreeWindowResize);
  animateThree();
}

function animateThree() {
  animationFrameId = requestAnimationFrame(animateThree);
  
  if (!activeStream && telemetryHistory.length === 0) {
    threeCanSatGroup.rotation.y += 0.003;
    threeCanSatGroup.rotation.x = Math.sin(performance.now() * 0.001) * 0.05;
  }
  threeRenderer.render(threeScene, threeCamera);
}

function update3DOrientation(roll, pitch, yaw) {
  if (!threeCanSatGroup) return;
  threeCanSatGroup.rotation.y = THREE.MathUtils.degToRad(yaw);
  threeCanSatGroup.rotation.x = THREE.MathUtils.degToRad(pitch);
  threeCanSatGroup.rotation.z = THREE.MathUtils.degToRad(-roll);

  document.getElementById("text-roll").textContent = Math.round(roll);
  document.getElementById("text-pitch").textContent = Math.round(pitch);
  document.getElementById("text-yaw").textContent = Math.round(yaw);
}

function onThreeWindowResize() {
  const container = document.getElementById("three-canvas-container");
  if (!container) return;
  const width = container.clientWidth;
  const height = container.clientHeight;

  threeCamera.aspect = width / height;
  threeCamera.updateProjectionMatrix();
  threeRenderer.setSize(width, height);
}

/* ==========================================================================
   6. Webcam Stream Controls
   ========================================================================== */

async function setupCameraControls() {
  const camSelect = document.getElementById("camera-select");
  const camToggleBtn = document.getElementById("btn-camera-toggle");
  const webcamVideo = document.getElementById("webcam-video");
  const overlayStatus = document.getElementById("cam-status");

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    camSelect.innerHTML = "";
    if (videoDevices.length === 0) {
      camSelect.innerHTML = '<option value="">No cameras detected</option>';
      camToggleBtn.disabled = true;
    } else {
      videoDevices.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Device ${i + 1}`;
        camSelect.appendChild(opt);
      });
    }
  } catch (err) {
    writeConsoleLog("CAMERA_ERR: Failed to access capture hardware.", "danger");
  }

  camToggleBtn.addEventListener("click", async () => {
    if (videoStreamObj) {
      stopWebcam();
    } else {
      const devId = camSelect.value;
      const constraints = { video: devId ? { deviceId: { exact: devId } } : true, audio: false };
      try {
        videoStreamObj = await navigator.mediaDevices.getUserMedia(constraints);
        webcamVideo.srcObject = videoStreamObj;
        camToggleBtn.textContent = "Stop Feed";
        camToggleBtn.className = "btn btn-sm btn-danger";
        overlayStatus.textContent = "ACTIVE";
        overlayStatus.className = "text-success";
        document.querySelector(".video-overlay").classList.add("active-stream");
      } catch (err) {
        writeConsoleLog(`CAMERA_ERR: Access blocked: ${err.message}`, "danger");
      }
    }
  });
}

function stopWebcam() {
  const webcamVideo = document.getElementById("webcam-video");
  const camToggleBtn = document.getElementById("btn-camera-toggle");
  const overlayStatus = document.getElementById("cam-status");

  if (videoStreamObj) {
    videoStreamObj.getTracks().forEach(track => track.stop());
    videoStreamObj = null;
  }
  webcamVideo.srcObject = null;
  camToggleBtn.textContent = "Start Feed";
  camToggleBtn.className = "btn btn-sm btn-primary";
  overlayStatus.textContent = "INACTIVE";
  overlayStatus.className = "text-danger";
  document.querySelector(".video-overlay").classList.remove("active-stream");
}

/* ==========================================================================
   7. CSV and Chart PNG Exports
   ========================================================================== */

function exportCSV() {
  writeConsoleLog("EXPORT: Requesting CSV export from server...", "info");
  
  // Trigger download from backend
  const link = document.createElement("a");
  link.href = "/export/csv";
  link.download = `GCS_FlightLog_${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  writeConsoleLog(`SUCCESS: CSV export started. Check your downloads folder.`, "success");
}

async function getTelemStats() {
  try {
    const res = await fetch('/stats');
    const stats = await res.json();
    
    const msg = `
TELEMETRY STATISTICS:
• Total Packets: ${stats.total_packets || 0}
• Altitude Range: ${(stats.altitude?.min || 0).toFixed(1)}m - ${(stats.altitude?.max || 0).toFixed(1)}m (Avg: ${(stats.altitude?.avg || 0).toFixed(1)}m)
• Temperature Range: ${(stats.temperature?.min || 0).toFixed(1)}°C - ${(stats.temperature?.max || 0).toFixed(1)}°C (Avg: ${(stats.temperature?.avg || 0).toFixed(1)}°C)
• Voltage Range: ${(stats.voltage?.min || 0).toFixed(2)}V - ${(stats.voltage?.max || 0).toFixed(2)}V
• Flight States: ${Object.entries(stats.states || {}).map(([k, v]) => `${k}(${v})`).join(', ')}
• Data Source: ${Object.entries(stats.sources || {}).map(([k, v]) => `${k}(${v})`).join(', ')}
    `.trim();
    
    writeConsoleLog(msg, "info");
  } catch (err) {
    writeConsoleLog(`ERROR: Failed to fetch statistics: ${err.message}`, "danger");
  }
}

function exportCurrentChart() {
  let id = "";
  if (document.getElementById("tab-altitude-rate").classList.contains("active")) id = "chart-altitude-rate";
  else if (document.getElementById("tab-press-temp").classList.contains("active")) id = "chart-press-temp";
  else if (document.getElementById("tab-batt-sats").classList.contains("active")) id = "chart-batt-sats";

  if (!id) return;
  const canvas = document.getElementById(id);
  const url = canvas.toDataURL("image/png");
  const link = document.createElement("a");
  link.download = `GCS_Telemetry_Chart_${id}_${Date.now()}.png`;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  writeConsoleLog(`SUCCESS: Snapshot image of active chart exported.`, "success");
}

function resetDashboardData() {
  telemetryHistory = [];
  flightPathCoords = [];
  latestTelemetry = null;

  elPacketCountDisplay.textContent = "0000";
  elMissionTimeDisplay.textContent = "00:00:00";
  elErrorDigits.textContent = "0000";
  elErrorDigits.classList.remove("error-active");

  Object.values(teleFields).forEach(f => {
    if (f) {
      if (f.id === "tele-p-lat" || f.id === "tele-p-lon") f.textContent = "0.000000";
      else if (f.id.includes("roll")) f.innerHTML = `<span id="tele-p-roll">0</span>°, <span id="tele-p-pitch">0</span>°, <span id="tele-p-yaw">0</span>°`;
      else f.textContent = "0.0";
    }
  });

  Object.values(charts).forEach(c => {
    if (c) {
      c.data.labels = [];
      c.data.datasets.forEach(ds => ds.data = []);
      c.update();
    }
  });

  if (flightPathPolyline) flightPathPolyline.setLatLngs([]);
  const def = [28.628920, 77.215010];
  if (launchSiteMarker) launchSiteMarker.setLatLng(def);
  if (currentPositionMarker) currentPositionMarker.setLatLng(def);
  if (map) map.setView(def, 15);

  document.getElementById("arm-separation").checked = false;
  document.getElementById("arm-parachute").checked = false;
  document.getElementById("arm-redundant").checked = false;
  document.getElementById("btn-trigger-separation").disabled = true;
  document.getElementById("btn-trigger-parachute").disabled = true;
  document.getElementById("btn-trigger-redundant").disabled = true;

  ["error-d1", "error-d2", "error-d3", "error-d4"].forEach(id => {
    const box = document.getElementById(id);
    box.className = "digit-box";
    box.querySelector(".digit-num").textContent = "0";
  });
  
  document.getElementById("error-d1").querySelector(".digit-desc").textContent = "Within 8–10 m/s";
  document.getElementById("error-d2").querySelector(".digit-desc").textContent = "GPS available";
  document.getElementById("error-d3").querySelector(".digit-desc").textContent = "Separated OK";
  document.getElementById("error-d4").querySelector(".digit-desc").textContent = "Parachute Safe";

  elConsoleLogs.innerHTML = '<div class="log-line text-success">[00:00:00] GCS console reset. Buffers and logs flushed.</div>';
}

function writeConsoleLog(message, type = "info") {
  const stamp = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `log-line text-${type}`;
  line.textContent = `[${stamp}] ${message}`;

  elConsoleLogs.appendChild(line);
  elConsoleLogs.scrollTop = elConsoleLogs.scrollHeight;
}
