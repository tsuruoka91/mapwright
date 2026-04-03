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

/** 地図タイルを覆う外周（穴＝未踏破以外は parchment 色のみ） */
const WORLD_MASK_OUTER = [
  [-85, -200],
  [-85, 200],
  [85, 200],
  [85, -200],
];

/** 踏破穴を円で近似する分割数（スタンプが多いときは 32 程度が無難） */
const EXPLORATION_HOLE_SEGMENTS = 32;

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

function circleRingLatLngs(centerLat, centerLng, radiusMeters, segments) {
  const mPerLat = Geo.metersPerDegreeLatitude;
  const latRad = (centerLat * Math.PI) / 180;
  const mPerLng = mPerLat * Math.cos(latRad);
  const ring = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    const eastM = radiusMeters * Math.cos(angle);
    const northM = radiusMeters * Math.sin(angle);
    ring.push([centerLat + northM / mPerLat, centerLng + eastM / mPerLng]);
  }
  return ring;
}

let map;
let userMarker;
let explorationMaskPolygon = null;
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
    el.textContent = "踏破ポイント: " + strokeCenters.length;
  }
}

function rebuildExplorationMask() {
  if (explorationMaskPolygon) {
    map.removeLayer(explorationMaskPolygon);
    explorationMaskPolygon = null;
  }
  const holes = [];
  strokeCenters.forEach(function (pair) {
    holes.push(
      circleRingLatLngs(pair[0], pair[1], BRUSH_RADIUS_METERS, EXPLORATION_HOLE_SEGMENTS)
    );
  });
  const latlngs = holes.length ? [WORLD_MASK_OUTER].concat(holes) : [WORLD_MASK_OUTER];
  explorationMaskPolygon = L.polygon(latlngs, {
    stroke: false,
    fillColor: "#b89a6e",
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);
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

function tryRegisterBrushStamp(lat, lng) {
  if (
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
  tryRegisterBrushStamp(lat, lng);
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
startGeolocationWatch();
