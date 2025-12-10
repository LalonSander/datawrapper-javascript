// --- LOAD CSV AND BUILD LOOKUP ---
let regionTooltips = {};  // name (lowercase) -> { name, tooltip }
let regionNames = [];

function parseCSVLine(line) {
  // Handle quoted CSV values
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
      lines.shift(); // remove header

      lines.forEach(line => {
        const cols = parseCSVLine(line);
        const name = cols[0];
        const tooltip = cols[1];

        if (name && tooltip) {
          regionTooltips[name.toLowerCase()] = { name, tooltip };
          regionNames.push(name);
        }
      });
      log("✅ Loaded " + regionNames.length + " regions with tooltips");
    })
    .catch(err => log("❌ CSV load error: " + err));
}

loadCSV();


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


// --- WAIT FOR CHART TO LOAD ---
function waitForChart() {
  const component = document.querySelector('datawrapper-visualization');

  if (component && component.shadowRoot) {
    dwComponent = component;
    shadowRoot = component.shadowRoot;
    log("✅ Found Datawrapper web component");

    setTimeout(setupTooltipInterception, 500);
  } else {
    setTimeout(waitForChart, 300);
  }
}

setTimeout(waitForChart, 500);


// --- SETUP TOOLTIP INTERCEPTION ---
function setupTooltipInterception() {
  // Find the native tooltip element
  tooltipElement = shadowRoot.querySelector('dw-tooltip');

  if (!tooltipElement) {
    tooltipElement = shadowRoot.querySelector('.tooltip, [class*="tooltip"]');
  }

  if (!tooltipElement) {
    log("❌ No tooltip element found");
    return;
  }

  log("✅ Found tooltip element");

  // Watch for tooltip content changes
  setupTooltipObserver();

  // Hide native tooltip visually but keep it functional
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


// --- OBSERVE TOOLTIP FOR H2 CHANGES ---
let tooltipObserver = null;

function setupTooltipObserver() {
  if (!tooltipElement) return;

  if (tooltipObserver) {
    tooltipObserver.disconnect();
  }

  tooltipObserver = new MutationObserver(() => {
    // Look for h2 inside the tooltip
    const h2 = tooltipElement.querySelector('h2');

    if (h2) {
      const regionName = h2.textContent.trim();
      log("📡 Tooltip h2: " + regionName);

      // Look up this region in our CSV
      const regionData = regionTooltips[regionName.toLowerCase()];

      if (regionData) {
        showInfoBox(regionData.name, regionData.tooltip);
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
}


// --- SEARCH: SHOW REGION IN INFO BOX ---
function showRegionFromSearch(regionName) {
  const regionData = regionTooltips[regionName.toLowerCase()];

  if (regionData) {
    showInfoBox(regionData.name, regionData.tooltip);
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

  // Exact match → show immediately
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
