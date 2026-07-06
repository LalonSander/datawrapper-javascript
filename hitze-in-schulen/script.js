// --- STATE ---
let regionTooltips = {};  // name (lowercase) -> { name, ars, tooltip }
let regionNames = [];
let mapData = null;
let geometryByARS = {};
let geoPathGenerator = null;
let shadowRoot = null;
let hoverOutlineElement = null;
let currentPinArs = null;
let tooltipObserver = null;


// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const CHART_ID = 'eC2gr';

const CHART_DATA_POLL_TIMEOUT_MS = 10000;
const CHART_DATA_POLL_INTERVAL_MS = 300;

// Fallback Performance API patterns used if chartData polling times out
const BASEMAP_URL_PATTERN = 'datawrapper.dwcdn.net/lib/basemaps/germany-gemeinde';
const DATASET_URL_PATTERN = 'dataset.csv';
const POLL_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 300;

const REGION_PIN_GROUP_ID = 'region-pin-group';
const PIN_STROKE_COLOR = '#1f1f1f';
const PIN_STROKE_WIDTH = 2;
const PIN_DOT_RADIUS = 5;
const PIN_PULSE_RADIUS_START = PIN_DOT_RADIUS;
const PIN_PULSE_RADIUS_END = PIN_DOT_RADIUS * 4;
const PIN_PULSE_DURATION_MS = 1500;


// ─── DOM ELEMENTS ─────────────────────────────────────────────────────────────

const search = document.getElementById("search");
const list = document.getElementById("autocomplete-list");
const infoBox = document.getElementById("info-box");
const infoName = document.getElementById("info-name");
const infoData = document.getElementById("info-data");
const debugEl = document.getElementById("debug");
const toggleDebugBtn = document.getElementById("toggle-debug");
const clearInfoBtn = document.getElementById("clear-info");
const searchButton = document.getElementById("search-button");


// ─── DEBUG LOGGING ────────────────────────────────────────────────────────────

function log(msg) {
  console.log(msg);
  debugEl.textContent += msg + "\n";
  debugEl.scrollTop = debugEl.scrollHeight;
}

toggleDebugBtn.addEventListener("click", () => debugEl.classList.toggle("hidden"));
clearInfoBtn.addEventListener("click", clearInfoBox);


// ─── CSV PARSING ──────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

function parseDatasetCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headerCols = parseCSVLine(lines[0]);

  const nameColumnIndex = headerCols.indexOf('region');
  const agsColumnIndex = headerCols.indexOf('AGS');
  const tooltipColumnIndex = headerCols.indexOf('tooltip');

  if (nameColumnIndex === -1 || agsColumnIndex === -1 || tooltipColumnIndex === -1) {
    log("❌ dataset.csv missing expected columns. Found: " + headerCols.join(', '));
    return;
  }

  const dataLines = lines.slice(1);

  dataLines.forEach(line => {
    const cols = parseCSVLine(line);
    const name = cols[nameColumnIndex];
    const ags = cols[agsColumnIndex];
    const tooltip = cols[tooltipColumnIndex];

    if (name && ags && tooltip) {
      regionTooltips[name.toLowerCase()] = { name, ars: ags, tooltip };
      regionNames.push(name);
    }
  });

  log("✅ Loaded " + regionNames.length + " regions from dataset.csv");
}

function loadDatasetFromUrl(datasetUrl) {
  log("📡 Fetching dataset from: " + datasetUrl);

  fetch(datasetUrl)
    .then(r => r.text())
    .then(text => parseDatasetCSV(text))
    .catch(err => log("❌ dataset.csv fetch error: " + err));
}


// ─── CHART DATA LOADING (primary) ─────────────────────────────────────────────

function extractBasemapUrlFromChartData(chartData) {
  const assets = chartData.assets;
  const basemapAssetKey = Object.keys(assets).find(key => key.includes('germany-gemeinde'));

  if (!basemapAssetKey) {
    log("❌ Could not find germany-gemeinde basemap in chart assets");
    return null;
  }

  const relativeUrl = assets[basemapAssetKey].url;
  const chartPublicUrl = chartData.chart.publicUrl;
  const chartBase = chartPublicUrl.replace(/\/[^/]+\/?$/, '/');
  const resolvedUrl = new URL(relativeUrl, chartBase).href;

  log("📍 Resolved basemap URL: " + resolvedUrl);
  return resolvedUrl;
}

function extractDatasetUrlFromChartData(chartData) {
  const assets = chartData.assets;

  if (!assets['dataset.csv']) {
    log("❌ Could not find dataset.csv in chart assets");
    return null;
  }

  const resolvedUrl = new URL(assets['dataset.csv'].url, chartData.chart.publicUrl).href;
  log("📍 Resolved dataset URL: " + resolvedUrl);
  return resolvedUrl;
}

function loadFromChartData() {
  const startTime = Date.now();

  function attempt() {
    const chartDataExists = window.datawrapper
      && window.datawrapper.chartData
      && window.datawrapper.chartData[CHART_ID];

    if (chartDataExists) {
      window.datawrapper.chartData[CHART_ID]
        .then(chartData => {
          const basemapUrl = extractBasemapUrlFromChartData(chartData);
          const datasetUrl = extractDatasetUrlFromChartData(chartData);

          if (basemapUrl) loadMapDataFromBasemapUrl(basemapUrl);
          if (datasetUrl) loadDatasetFromUrl(datasetUrl);
        })
        .catch(err => log("❌ Failed to resolve chart data Promise: " + err));
      return;
    }

    const elapsedMs = Date.now() - startTime;

    if (elapsedMs >= CHART_DATA_POLL_TIMEOUT_MS) {
      log("❌ chartData timed out — falling back to Performance API");
      pollForUrl(BASEMAP_URL_PATTERN, loadMapDataFromBasemapUrl);
      pollForUrl(DATASET_URL_PATTERN, loadDatasetFromUrl);
      return;
    }

    setTimeout(attempt, CHART_DATA_POLL_INTERVAL_MS);
  }

  attempt();
}


// ─── PERFORMANCE API FALLBACK ─────────────────────────────────────────────────

function pollForUrl(pattern, onFound) {
  const startTime = Date.now();

  function attempt() {
    const entries = performance.getEntriesByType('resource');
    const match = entries.find(entry => entry.name.includes(pattern));

    if (match) {
      onFound(match.name);
      return;
    }

    if (Date.now() - startTime >= POLL_TIMEOUT_MS) {
      log("❌ Timed out polling for: " + pattern);
      return;
    }

    setTimeout(attempt, POLL_INTERVAL_MS);
  }

  attempt();
}


// ─── MAP DATA ─────────────────────────────────────────────────────────────────

function loadMapDataFromBasemapUrl(basemapUrl) {
  log("📡 Fetching basemap from: " + basemapUrl);

  fetch(basemapUrl)
    .then(r => r.json())
    .then(data => {
      mapData = data.content || data;
      buildGeometryLookup();
      log("✅ Loaded basemap");

      if (shadowRoot) {
        setupPathGenerator();
      }
    })
    .catch(err => log("❌ Basemap fetch error: " + err));
}

function buildGeometryLookup() {
  if (!mapData || !mapData.objects || !mapData.objects.regions) return;

  mapData.objects.regions.geometries.forEach(geom => {
    if (geom.properties.ARS) geometryByARS[geom.properties.ARS] = geom;
    if (geom.properties.AGS) geometryByARS[geom.properties.AGS] = geom;
  });

  log("✅ Built geometry lookup with " + Object.keys(geometryByARS).length + " entries");
}


// ─── SVG PATH GENERATOR ───────────────────────────────────────────────────────

function setupPathGenerator() {
  if (!shadowRoot || !mapData) return;

  const svg = shadowRoot.querySelector('svg.svg-main');
  const width = svg.getAttribute('width');
  const height = svg.getAttribute('height');

  const bbox = mapData.bbox;
  const bboxWidth = bbox[2] - bbox[0];
  const bboxHeight = bbox[3] - bbox[1];
  const scale = Math.min(width / bboxWidth, height / bboxHeight);
  const translateX = width / 2 - (bbox[0] + bboxWidth / 2) * scale;
  const translateY = height / 2 - (bbox[1] + bboxHeight / 2) * scale;

  log(`Transform: scale=${scale.toFixed(6)}, translate=(${translateX.toFixed(2)}, ${translateY.toFixed(2)})`);

  geoPathGenerator = { scaleX: scale, scaleY: scale, translateX, translateY };

  if (currentPinArs) {
    updateRegionPin(currentPinArs);
  }
}

function geometryToPath(geometry, scaleX, scaleY, translateX, translateY) {
  if (!mapData || !mapData.arcs) return '';

  const arcs = mapData.arcs;

  function transformPoint(coord) {
    return [coord[0] * scaleX + translateX, coord[1] * scaleY + translateY];
  }

  function processArc(arcIndex) {
    const reverse = arcIndex < 0;
    const idx = reverse ? ~arcIndex : arcIndex;
    const arc = arcs[idx];
    if (!arc) return [];
    let coords = arc.map(transformPoint);
    if (reverse) coords = coords.slice().reverse();
    return coords;
  }

  function ringToPath(ring) {
    let coords = [];
    ring.forEach((arcIndex, i) => {
      let arcCoords = processArc(arcIndex);
      if (i > 0 && arcCoords.length > 0) arcCoords = arcCoords.slice(1);
      coords = coords.concat(arcCoords);
    });

    if (coords.length === 0) return '';

    let d = 'M' + coords[0][0].toFixed(2) + ',' + coords[0][1].toFixed(2);
    for (let i = 1; i < coords.length; i++) {
      d += 'L' + coords[i][0].toFixed(2) + ',' + coords[i][1].toFixed(2);
    }
    return d + 'Z';
  }

  let pathString = '';

  if (geometry.type === 'Polygon') {
    geometry.arcs.forEach(ring => { pathString += ringToPath(ring); });
  } else if (geometry.type === 'MultiPolygon') {
    geometry.arcs.forEach(polygon => {
      polygon.forEach(ring => { pathString += ringToPath(ring); });
    });
  }

  return pathString;
}


// ─── REGION PIN ───────────────────────────────────────────────────────────────

function computeGeometryCentroid(geometry) {
  const allCoords = [];

  function collectFromRing(ring) {
    for (const arcIndex of ring) {
      const actualIndex = arcIndex < 0 ? ~arcIndex : arcIndex;
      const arc = mapData.arcs[actualIndex];
      if (!arc) continue;
      for (const coord of arc) allCoords.push(coord);
    }
  }

  if (geometry.type === 'Polygon') {
    for (const ring of geometry.arcs) collectFromRing(ring);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.arcs) {
      for (const ring of polygon) collectFromRing(ring);
    }
  }

  if (allCoords.length === 0) return null;

  let sumX = 0;
  let sumY = 0;
  for (const coord of allCoords) {
    sumX += coord[0];
    sumY += coord[1];
  }

  return { x: sumX / allCoords.length, y: sumY / allCoords.length };
}

function buildPinGroup(svgX, svgY) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('id', REGION_PIN_GROUP_ID);

  const pulseRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pulseRing.setAttribute('cx', svgX);
  pulseRing.setAttribute('cy', svgY);
  pulseRing.setAttribute('r', PIN_PULSE_RADIUS_START);
  pulseRing.setAttribute('fill', 'none');
  pulseRing.setAttribute('stroke', PIN_STROKE_COLOR);
  pulseRing.setAttribute('stroke-width', PIN_STROKE_WIDTH);
  pulseRing.setAttribute('opacity', '0.6');

  const animateRadius = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  animateRadius.setAttribute('attributeName', 'r');
  animateRadius.setAttribute('from', PIN_PULSE_RADIUS_START);
  animateRadius.setAttribute('to', PIN_PULSE_RADIUS_END);
  animateRadius.setAttribute('dur', `${PIN_PULSE_DURATION_MS}ms`);
  animateRadius.setAttribute('repeatCount', 'indefinite');

  const animateOpacity = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  animateOpacity.setAttribute('attributeName', 'opacity');
  animateOpacity.setAttribute('from', '0.6');
  animateOpacity.setAttribute('to', '0');
  animateOpacity.setAttribute('dur', `${PIN_PULSE_DURATION_MS}ms`);
  animateOpacity.setAttribute('repeatCount', 'indefinite');

  pulseRing.appendChild(animateRadius);
  pulseRing.appendChild(animateOpacity);
  group.appendChild(pulseRing);

  return group;
}

function updateRegionPin(ars) {
  clearRegionPin();

  if (!geoPathGenerator) {
    log("⚠️ Cannot place pin — path generator not ready");
    return;
  }

  const geometry = geometryByARS[ars];
  if (!geometry) {
    log("⚠️ Cannot place pin — no geometry for ARS: " + ars);
    return;
  }

  const centroid = computeGeometryCentroid(geometry);
  if (!centroid) {
    log("⚠️ Cannot place pin — centroid failed for ARS: " + ars);
    return;
  }

  const svgX = centroid.x * geoPathGenerator.scaleX + geoPathGenerator.translateX;
  const svgY = centroid.y * geoPathGenerator.scaleY + geoPathGenerator.translateY;

  const svg = shadowRoot.querySelector('svg.svg-main');
  if (!svg) {
    log("⚠️ Cannot place pin — SVG not found");
    return;
  }

  svg.appendChild(buildPinGroup(svgX, svgY));
  currentPinArs = ars;
  log(`✅ Pin placed at (${svgX.toFixed(1)}, ${svgY.toFixed(1)}) for ARS: ${ars}`);
}

function clearRegionPin() {
  if (!shadowRoot) return;
  const svg = shadowRoot.querySelector('svg.svg-main');
  if (!svg) return;

  const existingPin = svg.getElementById(REGION_PIN_GROUP_ID);
  if (existingPin) existingPin.remove();

  currentPinArs = null;
}


// ─── HOVER OUTLINE ────────────────────────────────────────────────────────────

function updateHoverOutline(ars) {
  if (!hoverOutlineElement) {
    hoverOutlineElement = shadowRoot?.querySelector('.hover-outline');
  }

  if (!hoverOutlineElement || !geoPathGenerator) return;

  const geometry = geometryByARS[ars];
  if (!geometry) return;

  const pathData = geometryToPath(
    geometry,
    geoPathGenerator.scaleX,
    geoPathGenerator.scaleY,
    geoPathGenerator.translateX,
    geoPathGenerator.translateY
  );

  if (pathData) {
    hoverOutlineElement.setAttribute('d', pathData);
  }
}

function clearHoverOutline() {
  if (hoverOutlineElement) {
    hoverOutlineElement.setAttribute('d', '');
  }
}


// ─── INFO BOX ─────────────────────────────────────────────────────────────────

function showInfoBox(name, tooltipHtml) {
  infoName.textContent = name;
  infoData.innerHTML = tooltipHtml;
  infoBox.classList.add('has-content');
}

function clearInfoBox() {
  infoName.textContent = '';
  infoData.innerHTML = '';
  infoBox.classList.remove('has-content');
  clearHoverOutline();
  clearRegionPin();
}


// ─── REGION SELECTION (shared by events API and search) ───────────────────────

function selectRegionByName(regionName) {
  // Look up by name from our CSV data — used by both the Datawrapper
  // events API (which gives us the region name) and the search field
  const regionData = regionTooltips[regionName.toLowerCase()];

  if (regionData) {
    showInfoBox(regionData.name, regionData.tooltip);
    updateHoverOutline(regionData.ars);
    updateRegionPin(regionData.ars);
    search.value = regionData.name;
    list.innerHTML = "";
  } else {
    log("⚠️ No CSV match for: " + regionName);
  }
}

function selectRegionFromSearch(regionName) {
  // Called from the search field — same logic but shows fallback message
  // when the typed name doesn't exactly match a region in our data
  const regionData = regionTooltips[regionName.toLowerCase()];

  if (regionData) {
    showInfoBox(regionData.name, regionData.tooltip);
    updateHoverOutline(regionData.ars);
    updateRegionPin(regionData.ars);
  } else {
    showInfoBox(regionName, "Keine Daten verfügbar");
  }
}


// ─── DATAWRAPPER EVENTS API ───────────────────────────────────────────────────
// region.mouseenter fires on both desktop hover and mobile touch tap,
// replacing the previous MutationObserver approach entirely.

datawrapper.on('region.mouseenter', ({ chartId, data }) => {
  if (chartId !== CHART_ID) return;
  log("📡 region.mouseenter: " + data.region);
  selectRegionByName(data.region);
});

datawrapper.on('region.mouseleave', ({ chartId }) => {
  if (chartId !== CHART_ID) return;
  // Only clear outline and pin on desktop — on mobile the sticky tooltip
  // stays visible until the user taps elsewhere, so we leave the selection
  // in place to match what they tapped on
  const isTouchDevice = window.matchMedia('(hover: none)').matches;
  if (!isTouchDevice) {
    clearHoverOutline();
    clearRegionPin();
  }
});


// ─── CHART INITIALISATION ─────────────────────────────────────────────────────

function waitForChart() {
  const component = document.querySelector('datawrapper-visualization');

  if (component && component.shadowRoot) {
    shadowRoot = component.shadowRoot;
    log("✅ Found Datawrapper web component");

    loadFromChartData();

    // Get hover outline element and set up resize observer
    hoverOutlineElement = shadowRoot.querySelector('.hover-outline');
    if (hoverOutlineElement) {
      log("✅ Found hover-outline element");
    }

    observeResizeForPathGenerator();
  } else {
    setTimeout(waitForChart, 300);
  }
}

setTimeout(waitForChart, 500);

function observeResizeForPathGenerator() {
  const svg = shadowRoot.querySelector('svg.svg-main');
  if (!svg) return;

  let resizeTimeout;

  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      setupPathGenerator();
    }, 500);
  });

  resizeObserver.observe(svg);
  log("🔄 Resize observer attached to SVG");
}


// ─── SEARCH ───────────────────────────────────────────────────────────────────

function fuzzySearch(query) {
  if (!query) return [];
  const lowerQuery = query.toLowerCase();
  return regionNames.filter(name => name.toLowerCase().includes(lowerQuery));
}

function renderAutocomplete(matches) {
  list.innerHTML = "";

  matches.slice(0, 10).forEach(name => {
    const div = document.createElement("div");
    div.textContent = name;

    div.addEventListener("click", () => {
      search.value = name;
      list.innerHTML = "";
      selectRegionFromSearch(name);
    });

    list.appendChild(div);
  });
}

search.addEventListener("input", () => {
  const q = search.value.trim();
  if (!q) {
    list.innerHTML = "";
    return;
  }

  renderAutocomplete(fuzzySearch(q));

  if (regionTooltips[q.toLowerCase()]) {
    selectRegionFromSearch(q);
  }
});

searchButton.addEventListener("click", () => {
  const q = search.value.trim();
  if (!q) return;
  list.innerHTML = "";
  selectRegionFromSearch(q);
});

document.addEventListener("click", (e) => {
  if (e.target !== search) {
    list.innerHTML = "";
  }
});
