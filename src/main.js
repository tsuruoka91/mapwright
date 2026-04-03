import L from "leaflet";
import "./style.css";

/** タイル分割ロジック（将来の差し替え用にオブジェクトに集約） */
const TileGrid = {
  /** 一辺の長さ（メートル）。大きいほど1回で踏破する範囲が広い */
  tileSizeMeters: 100,
  metersPerDegreeLatitude: 111320,
  get stepDegrees() {
    return this.tileSizeMeters / this.metersPerDegreeLatitude;
  },
  idFromLatLng(lat, lng) {
    const s = this.stepDegrees;
    const latIndex = Math.floor(lat / s);
    const lngIndex = Math.floor(lng / s);
    return latIndex + "_" + lngIndex;
  },
  boundsFromId(tileId) {
    const parts = tileId.split("_");
    const latIndex = parseInt(parts[0], 10);
    const lngIndex = parseInt(parts[1], 10);
    if (Number.isNaN(latIndex) || Number.isNaN(lngIndex)) return null;
    const s = this.stepDegrees;
    const sw = [latIndex * s, lngIndex * s];
    const ne = [(latIndex + 1) * s, (lngIndex + 1) * s];
    return L.latLngBounds(sw, ne);
  },
};

const STORAGE_KEY = "exploration_map_tile_ids_m" + TileGrid.tileSizeMeters;

/** 地図タイルを覆う外周（穴＝踏破タイル以外は parchment 色のみ） */
const WORLD_MASK_OUTER = [
  [-85, -200],
  [-85, 200],
  [85, 200],
  [85, -200],
];

let map;
let userMarker;
let explorationMaskPolygon = null;
const exploredIds = new Set();

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

function loadExploredTileIdsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(function (id) {
          return typeof id === "string" && id.indexOf("_") !== -1;
        })
      : [];
  } catch (e) {
    console.warn("localStorage read failed", e);
    return [];
  }
}

function saveExploredTileIdsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(exploredIds)));
  } catch (e) {
    console.warn("localStorage write failed", e);
  }
}

function updateStatusDisplay() {
  const el = document.getElementById("status");
  if (el) {
    el.textContent = "踏破タイル数: " + exploredIds.size;
  }
}

function rebuildExplorationMask() {
  if (explorationMaskPolygon) {
    map.removeLayer(explorationMaskPolygon);
    explorationMaskPolygon = null;
  }
  const holes = [];
  exploredIds.forEach(function (id) {
    const b = TileGrid.boundsFromId(id);
    if (!b || !b.isValid()) return;
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const nw = L.latLng(ne.lat, sw.lng);
    const se = L.latLng(sw.lat, ne.lng);
    holes.push([
      [sw.lat, sw.lng],
      [se.lat, se.lng],
      [ne.lat, ne.lng],
      [nw.lat, nw.lng],
    ]);
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

function registerExploredTile(tileId) {
  if (exploredIds.has(tileId)) return false;
  exploredIds.add(tileId);
  rebuildExplorationMask();
  saveExploredTileIdsToStorage();
  updateStatusDisplay();
  return true;
}

function boundsCoveringTileIds(ids) {
  let union = null;
  ids.forEach(function (id) {
    const b = TileGrid.boundsFromId(id);
    if (b && b.isValid()) {
      union = union ? union.extend(b) : b;
    }
  });
  return union;
}

function restoreAllExploredTiles() {
  const ids = loadExploredTileIdsFromStorage();
  ids.forEach(function (id) {
    exploredIds.add(id);
  });
  rebuildExplorationMask();
  updateStatusDisplay();
  const u = boundsCoveringTileIds(ids);
  if (u && u.isValid()) {
    map.fitBounds(u, { padding: [48, 48], maxZoom: 18, animate: false });
  }
}

function onGeolocationSuccess(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const ll = L.latLng(lat, lng);
  userMarker.setLatLng(ll);
  map.panTo(ll, { animate: false });
  const tileId = TileGrid.idFromLatLng(lat, lng);
  registerExploredTile(tileId);
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
restoreAllExploredTiles();
startGeolocationWatch();
