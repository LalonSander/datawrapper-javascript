// --- LOAD CSV AND BUILD LOOKUP ---
let regionTooltips = {};  // name (lowercase) -> { name, ars, tooltip }
let regionNames = [];

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

function loadCSV() {
  fetch('regions.csv')
    .then(r => r.text())
    .then(text => {
      const lines = text.trim().split('\n');
      lines.shift();

      lines.forEach(line => {
        const cols = parseCSVLine(line);
        const name = cols[0];
        const ags = cols[1];
        const tooltip = cols[2];

        if (name && ags && tooltip) {
          regionTooltips[name.toLowerCase()] = { name, ars: ags, tooltip };
          regionNames.push(name);
        }
      });
      log("✅ Loaded " + regionNames.length + " regions with tooltips");
    })
    .catch(err => log("❌ CSV load error: " + err));
}

loadCSV();


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

    // Now that the component exists, start polling for the basemap in
    // performance entries — Datawrapper will have fetched it by this point
    // or will fetch it very shortly
    pollForBasemapUrl();

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

  // Setup path generator if map data has already arrived by this point
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
}


// --- SEARCH: SHOW REGION IN INFO BOX ---
function showRegionFromSearch(regionName) {
  const regionData = regionTooltips[regionName.toLowerCase()];

  if (regionData) {
    showInfoBox(regionData.name, regionData.tooltip);
    updateHoverOutline(regionData.ars);
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


// --- CLOSE AUTOCOMPLETE ON OUTSIDE CLICK ---
document.addEventListener("click", (e) => {
  if (e.target !== search) {
    list.innerHTML = "";
  }
});
