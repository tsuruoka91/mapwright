import L from "leaflet";
import "./style.css";

const Geo = {
  metersPerDegreeLatitude: 111320,
};

const STORAGE_KEY = "exploration_map_brush_stroke_v1";

/** 筆の半径（m）。GPS 誤差と見た目のバランスで調整 */
const BRUSH_RADIUS_METERS = 20;
/** 前スタンプからこの距離（m）以上動いたら新しい円を追加（重なり過ぎ防止） */
const BRUSH_MIN_STEP_METERS = 10;

/** `?debug=1` … GPS なしで地図クリックによりスタンプ（連打で負荷が上がるので動作確認専用） */
const DEBUG_MODE = new URLSearchParams(location.search).get("debug") === "1";

const MASK_FILL = "#b89a6e";

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** 現在の縮尺で、緯度 lat における meters の距離が何 container ピクセルか（円半径用） */
function metersToContainerPixels(map, lat, lng, meters) {
  const mPerLat = Geo.metersPerDegreeLatitude;
  const latRad = (lat * Math.PI) / 180;
  const mPerLng = mPerLat * Math.cos(latRad);
  const ll0 = L.latLng(lat, lng);
  const ll1 = L.latLng(lat, lng + meters / mPerLng);
  const p0 = map.latLngToContainerPoint(ll0);
  const p1 = map.latLngToContainerPoint(ll1);
  return Math.hypot(p1.x - p0.x, p1.y - p0.y);
}

let map;
let userMarker;
/** @type {HTMLCanvasElement | null} */
let explorationMaskCanvas = null;
let explorationMaskRedrawScheduled = false;
/** @type {number[][]} 各要素は [lat, lng] */
const strokeCenters = [];
let lastStampLatLng = null;

function initMap() {
  map = L.map("map", {
    zoomControl: false,
    maxZoom: 18,
  });
  map.setView([35.6812, 139.7671], 17);
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
    maxNativeZoom: 18,
  }).addTo(map);
  userMarker = L.circleMarker([35.6812, 139.7671], {
    radius: 9,
    color: "#1a1a1a",
    weight: 2,
    fillColor: "#2d2d2d",
    fillOpacity: 0.95,
  }).addTo(map);
  if (DEBUG_MODE) {
    document.body.classList.add("mapwright-debug");
    map.on("click", function (e) {
      userMarker.setLatLng(e.latlng);
      registerBrushStamp(e.latlng.lat, e.latlng.lng, { force: true });
    });
  }
}

function loadBrushStrokesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (p) {
      return (
        Array.isArray(p) &&
        p.length >= 2 &&
        typeof p[0] === "number" &&
        typeof p[1] === "number" &&
        !Number.isNaN(p[0]) &&
        !Number.isNaN(p[1])
      );
    });
  } catch (e) {
    console.warn("localStorage read failed", e);
    return [];
  }
}

function saveBrushStrokesToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(strokeCenters));
  } catch (e) {
    console.warn("localStorage write failed", e);
  }
}

function updateStatusDisplay() {
  const el = document.getElementById("status");
  if (el) {
    let t = "踏破ポイント: " + strokeCenters.length;
    if (DEBUG_MODE) {
      t += " [DEBUG]";
    }
    el.textContent = t;
  }
}

function ensureExplorationMaskCanvas() {
  if (explorationMaskCanvas) {
    return;
  }
  explorationMaskCanvas = L.DomUtil.create("canvas", "mapwright-exploration-mask");
  explorationMaskCanvas.style.pointerEvents = "none";
  map.getPanes().overlayPane.appendChild(explorationMaskCanvas);
  function schedule() {
    scheduleExplorationMaskRedraw();
  }
  map.on("move moveend zoom zoomend resize viewreset", schedule);
}

function scheduleExplorationMaskRedraw() {
  if (explorationMaskRedrawScheduled || !map || !explorationMaskCanvas) {
    return;
  }
  explorationMaskRedrawScheduled = true;
  L.Util.requestAnimFrame(function () {
    explorationMaskRedrawScheduled = false;
    redrawExplorationMaskCanvas();
  });
}

function redrawExplorationMaskCanvas() {
  if (!map || !explorationMaskCanvas) {
    return;
  }
  const size = map.getSize();
  const canvas = explorationMaskCanvas;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(size.x * dpr));
  canvas.height = Math.max(1, Math.floor(size.y * dpr));
  canvas.style.width = size.x + "px";
  canvas.style.height = size.y + "px";

  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.fillStyle = MASK_FILL;
  ctx.fillRect(0, 0, size.x, size.y);
  ctx.globalCompositeOperation = "destination-out";
  strokeCenters.forEach(function (pair) {
    const lat = pair[0];
    const lng = pair[1];
    const p = map.latLngToContainerPoint(L.latLng(lat, lng));
    let r = metersToContainerPixels(map, lat, lng, BRUSH_RADIUS_METERS);
    if (r < 1) {
      r = 1;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalCompositeOperation = "source-over";
}

function rebuildExplorationMask() {
  ensureExplorationMaskCanvas();
  scheduleExplorationMaskRedraw();
  userMarker.bringToFront();
}

function boundsCoveringStrokesWithRadius(strokes, radiusMeters) {
  if (!strokes.length) return null;
  const mPerLat = Geo.metersPerDegreeLatitude;
  let union = null;
  strokes.forEach(function (pair) {
    const lat = pair[0];
    const lng = pair[1];
    const latRad = (lat * Math.PI) / 180;
    const mPerLng = mPerLat * Math.cos(latRad);
    const dLat = radiusMeters / mPerLat;
    const dLng = radiusMeters / mPerLng;
    const sw = L.latLng(lat - dLat, lng - dLng);
    const ne = L.latLng(lat + dLat, lng + dLng);
    const b = L.latLngBounds(sw, ne);
    union = union ? union.extend(b) : b;
  });
  return union;
}

function restoreExplorationFromStorage() {
  const loaded = loadBrushStrokesFromStorage();
  loaded.forEach(function (pair) {
    strokeCenters.push(pair);
  });
  if (strokeCenters.length) {
    const last = strokeCenters[strokeCenters.length - 1];
    lastStampLatLng = L.latLng(last[0], last[1]);
  }
  rebuildExplorationMask();
  updateStatusDisplay();
  const u = boundsCoveringStrokesWithRadius(strokeCenters, BRUSH_RADIUS_METERS);
  if (u && u.isValid()) {
    map.fitBounds(u, { padding: [48, 48], maxZoom: 18, animate: false });
  }
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ force?: boolean }} [options] force なら距離閾値を無視（デバッグ用クリック）
 */
function registerBrushStamp(lat, lng, options) {
  const force = options && options.force === true;
  if (
    !force &&
    lastStampLatLng !== null &&
    haversineDistanceMeters(lastStampLatLng.lat, lastStampLatLng.lng, lat, lng) <
      BRUSH_MIN_STEP_METERS
  ) {
    return false;
  }
  strokeCenters.push([lat, lng]);
  lastStampLatLng = L.latLng(lat, lng);
  rebuildExplorationMask();
  saveBrushStrokesToStorage();
  updateStatusDisplay();
  return true;
}

function onGeolocationSuccess(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const ll = L.latLng(lat, lng);
  userMarker.setLatLng(ll);
  map.panTo(ll, { animate: false });
  registerBrushStamp(lat, lng, { force: false });
}

function onGeolocationError(err) {
  console.warn("Geolocation error", err.code, err.message);
}

function startGeolocationWatch() {
  if (!navigator.geolocation) {
    console.warn("Geolocation is not supported");
    return;
  }
  navigator.geolocation.watchPosition(onGeolocationSuccess, onGeolocationError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });
}

initMap();
restoreExplorationFromStorage();
if (!DEBUG_MODE) {
  startGeolocationWatch();
}
