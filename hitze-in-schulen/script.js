// --- TOOLTIP DATA (loaded via Performance API after Datawrapper fetches dataset.csv) ---
let regionTooltips = {};  // name (lowercase) -> { name, ars, tooltip }
let regionNames = [];

// Maximum time to wait for the dataset.csv resource to appear in performance entries
const DATASET_POLL_TIMEOUT_MS = 10000;
const DATASET_POLL_INTERVAL_MS = 300;
const DATASET_URL_PATTERN = 'dataset.csv';

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

function findDatasetUrlFromPerformanceEntries() {
  const resourceEntries = performance.getEntriesByType('resource');

  for (const entry of resourceEntries) {
    if (entry.name.includes(DATASET_URL_PATTERN)) {
      return entry.name;
    }
  }

  return null;
}

function parseDatasetCSV(csvText) {
  const lines = csvText.trim().split('\n');

  // First line is the header row — find the column index for each field we need
  const headerCols = parseCSVLine(lines[0]);
  const nameColumnIndex = headerCols.indexOf('region');
  const agsColumnIndex = headerCols.indexOf('AGS');
  const tooltipColumnIndex = headerCols.indexOf('tooltip');

  if (nameColumnIndex === -1 || agsColumnIndex === -1 || tooltipColumnIndex === -1) {
    log("❌ dataset.csv missing expected columns (region, AGS, tooltip). Found: " + headerCols.join(', '));
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

  log("✅ Loaded " + regionNames.length + " regions with tooltips from dataset.csv");
}

function loadDatasetFromUrl(datasetUrl) {
  log("📡 Fetching dataset from: " + datasetUrl);

  fetch(datasetUrl)
    .then(r => r.text())
    .then(text => parseDatasetCSV(text))
    .catch(err => log("❌ dataset.csv fetch error: " + err));
}

function pollForDatasetUrl() {
  const startTime = Date.now();

  function attempt() {
    const datasetUrl = findDatasetUrlFromPerformanceEntries();

    if (datasetUrl) {
      loadDatasetFromUrl(datasetUrl);
      return;
    }

    const elapsedMs = Date.now() - startTime;

    if (elapsedMs >= DATASET_POLL_TIMEOUT_MS) {
      log("❌ Timed out waiting for dataset.csv resource in performance entries");
      return;
    }

    setTimeout(attempt, DATASET_POLL_INTERVAL_MS);
  }

  attempt();
}


// --- MAP DATA (loaded via Performance API after Datawrapper fetches it) ---
let mapData = null;
let geometryByARS = {};
let geoPathGenerator = null;

// Maximum time to wait for the basemap resource to appear in performance entries
const BASEMAP_POLL_TIMEOUT_MS = 10000;
const BASEMAP_POLL_INTERVAL_MS = 300;
const BASEMAP_URL_PATTERN = 'datawrapper.dwcdn.net/lib/basemaps/germany-gemeinde';

function findBasemapUrlFromPerformanceEntries() {
  const resourceEntries = performance.getEntriesByType('resource');

  for (const entry of resourceEntries) {
    if (entry.name.includes(BASEMAP_URL_PATTERN)) {
      return entry.name;
    }
  }

  return null;
}

function loadMapDataFromBasemapUrl(basemapUrl) {
  log("📡 Fetching basemap from: " + basemapUrl);

  fetch(basemapUrl)
    .then(r => r.json())
    .then(data => {
      mapData = data.content || data;
      buildGeometryLookup();
      log("✅ Loaded basemap via Performance API");

      // Setup path generator now that map data is available
      if (shadowRoot) {
        setupPathGenerator();
      }
    })
    .catch(err => log("❌ Basemap fetch error: " + err));
}

function pollForBasemapUrl() {
  const startTime = Date.now();

  function attempt() {
    const basemapUrl = findBasemapUrlFromPerformanceEntries();

    if (basemapUrl) {
      loadMapDataFromBasemapUrl(basemapUrl);
      return;
    }

    const elapsedMs = Date.now() - startTime;

    if (elapsedMs >= BASEMAP_POLL_TIMEOUT_MS) {
      log("❌ Timed out waiting for basemap resource in performance entries");
      return;
    }

    setTimeout(attempt, BASEMAP_POLL_INTERVAL_MS);
  }

  attempt();
}

function buildGeometryLookup() {
  if (!mapData || !mapData.objects || !mapData.objects.regions) return;

  const geometries = mapData.objects.regions.geometries;

  geometries.forEach(geom => {
    const properties = geom.properties;

    if (properties.ARS) {
      geometryByARS[properties.ARS] = geom;
    }

    if (properties.AGS) {
      geometryByARS[properties.AGS] = geom;
    }
  });

  log("✅ Built geometry lookup with " + Object.keys(geometryByARS).length + " entries");
}


// --- SETUP D3 PATH GENERATOR ---
function setupPathGenerator() {
  if (!shadowRoot || !mapData) return;

  const svg = shadowRoot.querySelector('svg.svg-main');
  const width = svg.getAttribute('width');
  const height = svg.getAttribute('height');

  log(`SVG dimensions: ${width} x ${height}`);
  const { left } = svg.getBoundingClientRect();
  console.log("SVG X offset from viewport:", left);

  const bbox = mapData.bbox;
  const bboxMinX = bbox[0];
  const bboxMinY = bbox[1];
  const bboxMaxX = bbox[2];
  const bboxMaxY = bbox[3];
  const bboxWidth = bboxMaxX - bboxMinX;
  const bboxHeight = bboxMaxY - bboxMinY;

  log(`Map bbox: [${bbox.join(', ')}]`);
  log(`Bbox size: ${bboxWidth.toFixed(4)} x ${bboxHeight.toFixed(4)}`);

  const scale = Math.min(width / bboxWidth, height / bboxHeight);

  const translateX = width / 2 - (bboxMinX + bboxWidth / 2) * scale;
  const translateY = height / 2 - (bboxMinY + bboxHeight / 2) * scale;

  log(`Transform: scale=${scale.toFixed(6)}, translate=(${translateX.toFixed(2)}, ${translateY.toFixed(2)})`);

  geoPathGenerator = {
    scaleX: scale,
    scaleY: scale,
    translateX: translateX,
    translateY: translateY
  };

  // If a pin is currently shown, reposition it since the transform has changed
  if (currentPinArs) {
    updateRegionPin(currentPinArs);
  }
}

function getFirstPoint(ars) {
  const geom = geometryByARS[ars];
  if (!geom) return null;

  const firstArc = geom.type === 'MultiPolygon' ? geom.arcs[0][0][0] : geom.arcs[0][0];
  const arcIdx = firstArc < 0 ? ~firstArc : firstArc;
  const coord = mapData.arcs[arcIdx][0];

  return { x: coord[0], y: coord[1] };
}

function verifyTransform(ars, expectedX, expectedY, name) {
  const geom = geometryByARS[ars];
  if (!geom || !geoPathGenerator) return;

  const firstArc = geom.type === 'MultiPolygon' ? geom.arcs[0][0][0] : geom.arcs[0][0];
  const arcIdx = firstArc < 0 ? ~firstArc : firstArc;
  const coord = mapData.arcs[arcIdx][0];

  const calcX = coord[0] * geoPathGenerator.scaleX + geoPathGenerator.translateX;
  const calcY = coord[1] * geoPathGenerator.scaleY + geoPathGenerator.translateY;

  const diffX = Math.abs(calcX - expectedX);
  const diffY = Math.abs(calcY - expectedY);

  if (diffX < 1 && diffY < 1) {
    log(`✅ ${name}: calc(${calcX.toFixed(2)}, ${calcY.toFixed(2)}) matches expected!`);
  } else {
    log(`⚠️ ${name}: calc(${calcX.toFixed(2)}, ${calcY.toFixed(2)}) vs expected(${expectedX}, ${expectedY}) - diff(${diffX.toFixed(2)}, ${diffY.toFixed(2)})`);
  }
}


// --- CONVERT TOPOJSON GEOMETRY TO SVG PATH ---
function geometryToPath(geometry, scaleX, scaleY, translateX, translateY) {
  if (!mapData || !mapData.arcs) return '';

  const arcs = mapData.arcs;

  function transformPoint(coord) {
    return [
      coord[0] * scaleX + translateX,
      coord[1] * scaleY + translateY
    ];
  }

  function processArc(arcIndex) {
    const reverse = arcIndex < 0;
    const idx = reverse ? ~arcIndex : arcIndex;
    const arc = arcs[idx];

    if (!arc) return [];

    let coords = arc.map(transformPoint);
    if (reverse) {
      coords = coords.slice().reverse();
    }
    return coords;
  }

  function ringToPath(ring) {
    let coords = [];
    ring.forEach((arcIndex, i) => {
      let arcCoords = processArc(arcIndex);
      if (i > 0 && arcCoords.length > 0) {
        arcCoords = arcCoords.slice(1);
      }
      coords = coords.concat(arcCoords);
    });

    if (coords.length === 0) return '';

    let d = 'M' + coords[0][0].toFixed(2) + ',' + coords[0][1].toFixed(2);
    for (let i = 1; i < coords.length; i++) {
      d += 'L' + coords[i][0].toFixed(2) + ',' + coords[i][1].toFixed(2);
    }
    d += 'Z';
    return d;
  }

  let pathString = '';

  if (geometry.type === 'Polygon') {
    geometry.arcs.forEach(ring => {
      pathString += ringToPath(ring);
    });
  } else if (geometry.type === 'MultiPolygon') {
    geometry.arcs.forEach(polygon => {
      polygon.forEach(ring => {
        pathString += ringToPath(ring);
      });
    });
  }

  return pathString;
}


// --- REGION PIN ---

// Tracks which region currently has a pin so we can reposition it on resize
let currentPinArs = null;

// ID used to find and remove the pin group from the shadow DOM SVG
const REGION_PIN_GROUP_ID = 'region-pin-group';

// Pin appearance — taz red to match the design system
const PIN_COLOR = '#d50d2e';
const PIN_DOT_RADIUS = 5;

// Pulse ring starts at the same size as the dot and expands outward
const PIN_PULSE_RADIUS_START = PIN_DOT_RADIUS;
const PIN_PULSE_RADIUS_END = PIN_DOT_RADIUS * 4;

// Duration of one pulse cycle in milliseconds
const PIN_PULSE_DURATION_MS = 1500;


function collectAllArcCoordinates(geometry) {
  // Collect every coordinate point from every arc in the geometry so we
  // can compute the mean centroid by averaging all of them.
  // This is a rough but visually good centroid for placing a pin.
  const allCoords = [];

  function collectFromRing(ring) {
    for (const arcIndex of ring) {
      const isReversed = arcIndex < 0;
      const actualIndex = isReversed ? ~arcIndex : arcIndex;
      const arc = mapData.arcs[actualIndex];

      if (!arc) continue;

      for (const coord of arc) {
        allCoords.push(coord);
      }
    }
  }

  if (geometry.type === 'Polygon') {
    for (const ring of geometry.arcs) {
      collectFromRing(ring);
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.arcs) {
      for (const ring of polygon) {
        collectFromRing(ring);
      }
    }
  }

  return allCoords;
}


function computeGeometryCentroid(geometry) {
  // Average all coordinate points in the geometry to find a mean centroid.
  // Returns coordinates in TopoJSON space (before SVG transform is applied).
  const allCoords = collectAllArcCoordinates(geometry);

  if (allCoords.length === 0) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;

  for (const coord of allCoords) {
    sumX += coord[0];
    sumY += coord[1];
  }

  const centroidX = sumX / allCoords.length;
  const centroidY = sumY / allCoords.length;

  return { x: centroidX, y: centroidY };
}


function convertCentroidToSvgCoords(centroid) {
  // Apply the same transform used by geometryToPath to convert from
  // TopoJSON coordinate space into SVG pixel coordinates
  const svgX = centroid.x * geoPathGenerator.scaleX + geoPathGenerator.translateX;
  const svgY = centroid.y * geoPathGenerator.scaleY + geoPathGenerator.translateY;

  return { x: svgX, y: svgY };
}


function buildPinPulseAnimation(radiusStart, radiusEnd, durationMs) {
  // Build an SVG <animate> element that expands the pulse ring outward
  // and fades it out, creating a ripple effect. Using SVG-native animation
  // avoids needing to inject a <style> element into the shadow DOM.
  const animateRadius = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  animateRadius.setAttribute('attributeName', 'r');
  animateRadius.setAttribute('from', radiusStart);
  animateRadius.setAttribute('to', radiusEnd);
  animateRadius.setAttribute('dur', `${durationMs}ms`);
  animateRadius.setAttribute('repeatCount', 'indefinite');

  const animateOpacity = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
  animateOpacity.setAttribute('attributeName', 'opacity');
  animateOpacity.setAttribute('from', '0.6');
  animateOpacity.setAttribute('to', '0');
  animateOpacity.setAttribute('dur', `${durationMs}ms`);
  animateOpacity.setAttribute('repeatCount', 'indefinite');

  return [animateRadius, animateOpacity];
}


function buildPinGroup(svgX, svgY) {
  // Build the full pin marker: a pulsing outer ring plus a solid centre dot.
  // Both are appended to a <g> group so they can be removed together.
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  group.setAttribute('id', REGION_PIN_GROUP_ID);

  // Outer pulse ring — starts at dot size, expands and fades via SVG animation
  const pulseRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pulseRing.setAttribute('cx', svgX);
  pulseRing.setAttribute('cy', svgY);
  pulseRing.setAttribute('r', PIN_PULSE_RADIUS_START);
  pulseRing.setAttribute('fill', 'none');
  pulseRing.setAttribute('stroke', PIN_COLOR);
  pulseRing.setAttribute('stroke-width', '2');
  pulseRing.setAttribute('opacity', '0.6');

  const [animateRadius, animateOpacity] = buildPinPulseAnimation(
    PIN_PULSE_RADIUS_START,
    PIN_PULSE_RADIUS_END,
    PIN_PULSE_DURATION_MS
  );
  pulseRing.appendChild(animateRadius);
  pulseRing.appendChild(animateOpacity);

  // Solid centre dot — always visible, sits on top of the pulse ring
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', svgX);
  dot.setAttribute('cy', svgY);
  dot.setAttribute('r', PIN_DOT_RADIUS);
  dot.setAttribute('fill', PIN_COLOR);

  group.appendChild(pulseRing);
  group.appendChild(dot);

  return group;
}


function updateRegionPin(ars) {
  // Remove any existing pin first, then place a new one at the centroid
  // of the region identified by the given ARS/AGS code
  clearRegionPin();

  if (!geoPathGenerator) {
    log("⚠️ Cannot place pin — path generator not ready");
    return;
  }

  const geometry = geometryByARS[ars];
  if (!geometry) {
    log("⚠️ Cannot place pin — no geometry found for ARS: " + ars);
    return;
  }

  const centroid = computeGeometryCentroid(geometry);
  if (!centroid) {
    log("⚠️ Cannot place pin — centroid computation returned no coordinates for ARS: " + ars);
    return;
  }

  const svgCoords = convertCentroidToSvgCoords(centroid);

  const svg = shadowRoot.querySelector('svg.svg-main');
  if (!svg) {
    log("⚠️ Cannot place pin — SVG element not found in shadow DOM");
    return;
  }

  const pinGroup = buildPinGroup(svgCoords.x, svgCoords.y);
  svg.appendChild(pinGroup);

  // Remember which region has the pin so setupPathGenerator can reposition
  // it if the SVG resizes and the transform changes
  currentPinArs = ars;

  log(`✅ Placed pin at SVG (${svgCoords.x.toFixed(1)}, ${svgCoords.y.toFixed(1)}) for ARS: ${ars}`);
}


function clearRegionPin() {
  // Remove the pin group from the shadow DOM SVG if it exists
  if (!shadowRoot) return;

  const svg = shadowRoot.querySelector('svg.svg-main');
  if (!svg) return;

  const existingPin = svg.getElementById(REGION_PIN_GROUP_ID);
  if (existingPin) {
    existingPin.remove();
  }

  currentPinArs = null;
}


// --- DOM ELEMENTS ---
const search = document.getElementById("search");
const list = document.getElementById("autocomplete-list");
const infoBox = document.getElementById("info-box");
const infoName = document.getElementById("info-name");
const infoData = document.getElementById("info-data");
const debugEl = document.getElementById("debug");
const toggleDebugBtn = document.getElementById("toggle-debug");
const clearInfoBtn = document.getElementById("clear-info");


// --- DEBUG LOGGING ---
function log(msg) {
  console.log(msg);
  debugEl.textContent += msg + "\n";
  debugEl.scrollTop = debugEl.scrollHeight;
}

toggleDebugBtn.addEventListener("click", () => debugEl.classList.toggle("hidden"));
clearInfoBtn.addEventListener("click", clearInfoBox);


// --- DATAWRAPPER COMPONENT ---
let dwComponent = null;
let shadowRoot = null;
let tooltipElement = null;
let hoverOutlineElement = null;


// --- WAIT FOR CHART TO LOAD ---
function waitForChart() {
  const component = document.querySelector('datawrapper-visualization');

  if (component && component.shadowRoot) {
    dwComponent = component;
    shadowRoot = component.shadowRoot;
    log("✅ Found Datawrapper web component");

    pollForBasemapUrl();
    pollForDatasetUrl();

    setTimeout(setupTooltipInterception, 500);
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


// --- SETUP TOOLTIP INTERCEPTION ---
function setupTooltipInterception(retries = 10) {
  tooltipElement = shadowRoot.querySelector('dw-tooltip');

  if (!tooltipElement) {
    tooltipElement = shadowRoot.querySelector('.tooltip, [class*="tooltip"]');
  }

  if (!tooltipElement) {
    log(`❌ No tooltip element found. Retries left: ${retries}`);

    if (retries > 0) {
      return setTimeout(() => setupTooltipInterception(retries - 1), 300);
    } else {
      log("❌ setupTooltipInterception failed permanently — giving up.");
      return;
    }
  }

  log("✅ Found tooltip element");

  hoverOutlineElement = shadowRoot.querySelector('.hover-outline');
  if (hoverOutlineElement) {
    log("✅ Found hover-outline element");
  } else {
    log("⚠️ No hover-outline element found");
  }

  if (mapData) {
    setupPathGenerator();
  }

  observeResizeForPathGenerator();
  setupTooltipObserver();
  hideNativeTooltip();
}


// --- HIDE NATIVE TOOLTIP ---
function hideNativeTooltip() {
  if (!tooltipElement) return;

  tooltipElement.style.cssText = `
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
    position: absolute !important;
    left: -9999px !important;
  `;

  log("✅ Native tooltip hidden");
}


// --- UPDATE HOVER OUTLINE FROM MAP DATA ---
function updateHoverOutline(ars) {
  if (!hoverOutlineElement) {
    hoverOutlineElement = shadowRoot?.querySelector('.hover-outline');
  }

  if (!hoverOutlineElement) {
    log("⚠️ Cannot update hover outline - element not found");
    return;
  }

  if (!geoPathGenerator) {
    log("⚠️ Cannot update hover outline - path generator not ready");
    setupPathGenerator();
    if (!geoPathGenerator) return;
  }

  const geometry = geometryByARS[ars];

  if (!geometry) {
    log("⚠️ No geometry found for ARS: " + ars);
    return;
  }

  const pathData = geometryToPath(
    geometry,
    geoPathGenerator.scaleX,
    geoPathGenerator.scaleY,
    geoPathGenerator.translateX,
    geoPathGenerator.translateY
  );

  if (pathData) {
    hoverOutlineElement.setAttribute('d', pathData);
    log("✅ Updated hover outline for ARS: " + ars + " (" + pathData.length + " chars)");
  } else {
    log("⚠️ Could not convert geometry to path for ARS: " + ars);
  }
}


// --- CLEAR HOVER OUTLINE ---
function clearHoverOutline() {
  if (hoverOutlineElement) {
    hoverOutlineElement.setAttribute('d', '');
  }
}


// --- OBSERVE TOOLTIP FOR H2 CHANGES ---
let tooltipObserver = null;

function setupTooltipObserver() {
  if (!tooltipElement) return;

  if (tooltipObserver) {
    tooltipObserver.disconnect();
  }

  tooltipObserver = new MutationObserver(() => {
    const h2 = tooltipElement.querySelector('h2');

    if (h2) {
      const regionName = h2.textContent.trim();
      log("📡 Tooltip h2: " + regionName);

      const regionData = regionTooltips[regionName.toLowerCase()];

      if (regionData) {
        showInfoBox(regionData.name, regionData.tooltip);
        updateHoverOutline(regionData.ars);
        updateRegionPin(regionData.ars);
      } else {
        log("⚠️ No CSV match for: " + regionName);
      }
    }
  });

  tooltipObserver.observe(tooltipElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  log("✅ Tooltip observer active (watching for h2)");
}


// --- INFO BOX DISPLAY ---
function showInfoBox(name, data) {
  infoName.textContent = name;
  infoData.innerHTML = data;
  infoBox.classList.add('has-content');
}

function clearInfoBox() {
  infoName.textContent = '';
  infoData.innerHTML = '';
  infoBox.classList.remove('has-content');
  clearHoverOutline();
  clearRegionPin();
}


// --- SEARCH: SHOW REGION IN INFO BOX ---
function showRegionFromSearch(regionName) {
  const regionData = regionTooltips[regionName.toLowerCase()];

  if (regionData) {
    showInfoBox(regionData.name, regionData.tooltip);
    updateHoverOutline(regionData.ars);
    updateRegionPin(regionData.ars);
  } else {
    showInfoBox(regionName, "Keine Daten verfügbar");
  }
}


// --- FUZZY SEARCH ---
function fuzzySearch(query) {
  if (!query) return [];
  query = query.toLowerCase();
  return regionNames.filter(name => name.toLowerCase().includes(query));
}


// --- AUTOCOMPLETE ---
function renderAutocomplete(matches) {
  list.innerHTML = "";

  matches.slice(0, 10).forEach(name => {
    const div = document.createElement("div");
    div.textContent = name;

    div.addEventListener("click", () => {
      search.value = name;
      list.innerHTML = "";
      showRegionFromSearch(name);
    });

    list.appendChild(div);
  });
}


// --- SEARCH INPUT HANDLER ---
search.addEventListener("input", () => {
  const q = search.value.trim();
  if (!q) {
    list.innerHTML = "";
    return;
  }

  const matches = fuzzySearch(q);
  renderAutocomplete(matches);

  if (regionTooltips[q.toLowerCase()]) {
    showRegionFromSearch(q);
  }
});


// --- SEARCH BUTTON CLICK HANDLER ---
// Clicking the magnifier button submits whatever is currently typed,
// same behaviour as pressing Enter would give in a native search form
const searchButton = document.getElementById("search-button");

searchButton.addEventListener("click", () => {
  const q = search.value.trim();
  if (!q) {
    return;
  }

  list.innerHTML = "";
  showRegionFromSearch(q);
});


// --- CLOSE AUTOCOMPLETE ON OUTSIDE CLICK ---
document.addEventListener("click", (e) => {
  if (e.target !== search) {
    list.innerHTML = "";
  }
});
