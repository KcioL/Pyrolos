/* =========================================================================
   Pyrolos — script.js
   Charge cols.json puis construit : carte, filtres, classement, succès,
   météo en direct (Open-Meteo, sans clé), suivi "cols roulés" (localStorage).
   Pour ajouter / modifier un col : éditer uniquement cols.json.
   ========================================================================= */

const STATE_COLOR = { bon: "#7fa96f", vigilance: "#c98a3c" };
const RIDDEN_KEY = "pyrolos_cols_roules";

const BADGES = [
  // --- progression générale ---
  { id: "premier", icon: "🏁", nom: "Premier virage",
    desc: "Coche ton premier col roulé.",
    test: (r) => r.size >= 1 },

  { id: "cinq", icon: "🛣️", nom: "Chasseur de cols",
    desc: "5 cols roulés ou plus.",
    test: (r) => r.size >= 5 },

  { id: "dix", icon: "🧭", nom: "Habitué des Pyrénées",
    desc: "10 cols roulés ou plus.",
    test: (r) => r.size >= 10 },

  { id: "complet", icon: "🏆", nom: "Collection complète",
    desc: "Tous les cols de la liste, roulés.",
    test: (r, cols) => cols.length > 0 && cols.every(c => r.has(c.nom)) },

  // --- altitude ---
  { id: "sommet", icon: "⛰️", nom: "Grand sommet",
    desc: "Un col roulé au-dessus de 2000 m.",
    test: (r, cols) => cols.some(c => r.has(c.nom) && c.alt >= 2000) },

  { id: "toit", icon: "👑", nom: "Le toit des Pyrénées",
    desc: "Rouler le col le plus haut de la liste.",
    test: (r, cols) => {
      if (!cols.length) return false;
      const top = cols.reduce((a, b) => (b.alt > a.alt ? b : a));
      return r.has(top.nom);
    } },

  { id: "cumul", icon: "📈", nom: "10 000 mètres",
    desc: "Cumuler 10 000 m d'altitude de cols roulés.",
    test: (r, cols) =>
      cols.filter(c => r.has(c.nom)).reduce((s, c) => s + c.alt, 0) >= 10000 },

  // --- géographie ---
  { id: "massifs3", icon: "🗺️", nom: "Multi-massifs",
    desc: "Des cols roulés dans 3 massifs différents.",
    test: (r, cols) =>
      new Set(cols.filter(c => r.has(c.nom)).map(c => c.massif)).size >= 3 },

  { id: "massifsAll", icon: "🌍", nom: "D'un océan à l'autre",
    desc: "Au moins un col roulé dans chaque massif.",
    test: (r, cols) => {
      const tous = new Set(cols.map(c => c.massif));
      const faits = new Set(cols.filter(c => r.has(c.nom)).map(c => c.massif));
      return tous.size > 0 && faits.size === tous.size;
    } },

  { id: "frontiere", icon: "🛂", nom: "Passeport tamponné",
    desc: "Rouler un col frontalier (Andorre ou Espagne).",
    test: (r, cols) => cols.some(c =>
      r.has(c.nom) && /andorre|espagn|isp[ée]guy|envalira/i.test(c.massif + " " + c.nom + " " + (c.desc || ""))) },

  // --- état de la route ---
  { id: "vigilance", icon: "⚠️", nom: "Pas peur du gravillon",
    desc: "3 cols roulés classés en vigilance.",
    test: (r, cols) => cols.filter(c => r.has(c.nom) && c.etat === "vigilance").length >= 3 },

  { id: "mythique", icon: "🐐", nom: "Le géant",
    desc: "Rouler le Col du Tourmalet.",
    test: (r) => r.has("Col du Tourmalet") }
];

let COLS = [];
let map = null;
let markers = {};
let currentMassif = "tous";
let currentQuery = "";
let selectedIndex = null;
let currentSort = "note";

const listEl = document.getElementById("pmw-list");
const detailEl = document.getElementById("pmw-detail");
const countEl = document.getElementById("pmw-count");
const highestEl = document.getElementById("pmw-highest");
const massifsCountEl = document.getElementById("pmw-massifs-count");
const chipsEl = document.getElementById("pmw-chips");
const searchEl = document.getElementById("pmw-search");
const rankingEl = document.getElementById("pmw-ranking");
const sortEl = document.getElementById("pmw-sort");
const badgesEl = document.getElementById("pmw-badges");
const progressTextEl = document.getElementById("pmw-progress-text");
const progressFillEl = document.getElementById("pmw-progress-fill");

init();

async function init() {
  try {
    const res = await fetch("cols.json");
    if (!res.ok) throw new Error("Impossible de charger cols.json (" + res.status + ")");
    COLS = await res.json();
  } catch (err) {
    listEl.innerHTML = `<div class="pmw-empty">
      Erreur de chargement de cols.json.<br>
      Si tu ouvres index.html directement depuis le disque (file://),
      certains navigateurs bloquent le fetch() de fichiers locaux.<br>
      Lance un petit serveur local (ex. <code>python3 -m http.server</code> dans le
      dossier du site) puis ouvre http://localhost:8000.
    </div>`;
    console.error(err);
    return;
  }

  await loadRoutes();
  buildStats();
  buildMassifChips();
  buildMap();
  render();
  renderRanking();
  renderBadges();
  initTabs();
  initSort();
  initBuilder();
}

/* ---------- Stats & filtres (vue Carte) ---------- */

function buildStats() {
  const massifs = [...new Set(COLS.map(c => c.massif))];
  const highest = Math.max(...COLS.map(c => c.alt));
  countEl.textContent = COLS.length;
  highestEl.textContent = highest + " m";
  massifsCountEl.textContent = massifs.length;
  document.getElementById("pmw-progress-text").textContent = `0 / ${COLS.length} cols roulés`;
}

function buildMassifChips() {
  const massifs = [...new Set(COLS.map(c => c.massif))];
  massifs.forEach(massif => {
    const btn = document.createElement("button");
    btn.className = "pmw-chip";
    btn.dataset.massif = massif;
    btn.textContent = massif;
    chipsEl.appendChild(btn);
  });

  chipsEl.querySelectorAll(".pmw-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      chipsEl.querySelectorAll(".pmw-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentMassif = chip.dataset.massif;
      render();
    });
  });
}

function buildMap() {
  map = L.map("pmw-map", { zoomControl: true, scrollWheelZoom: false }).setView([42.85, 0.6], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 14,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  COLS.forEach((c, i) => {
    const marker = L.circleMarker([c.lat, c.lon], {
      radius: 8, weight: 2, color: "#14161a",
      fillColor: STATE_COLOR[c.etat] || STATE_COLOR.bon, fillOpacity: 1
    }).addTo(map);
    marker.bindTooltip(c.nom + " · " + c.alt + " m", { direction: "top", offset: [0, -6] });
    marker.on("click", () => openDetail(i));
    markers[i] = marker;
  });
}

function matches(c) {
  const massifOk = currentMassif === "tous" || c.massif === currentMassif;
  const q = currentQuery.trim().toLowerCase();
  const queryOk = !q || c.nom.toLowerCase().includes(q) || c.massif.toLowerCase().includes(q);
  return massifOk && queryOk;
}

function render() {
  listEl.innerHTML = "";
  let shown = 0;

  COLS.forEach((c, i) => {
    const visible = matches(c);
    if (markers[i]) markers[i].setStyle({ opacity: visible ? 1 : 0.15, fillOpacity: visible ? 1 : 0.1 });
    if (!visible) return;
    shown++;

    const ridden = getRidden().has(c.nom);
    const card = document.createElement("div");
    card.className = "pmw-card" + (selectedIndex === i ? " selected" : "");
    card.innerHTML = `
      <div class="pmw-sign">
        <div class="altunit">ALT.</div>
        <div class="alt">${c.alt}</div>
        <div class="name">${c.nom}</div>
      </div>
      <div class="pmw-card-body">
        <div class="pmw-card-top">
          <h3>${c.nom}${ridden ? ' ✅' : ''}</h3>
          <span class="pmw-massif">${c.massif}</span>
        </div>
        <div class="pmw-desc">${c.desc}</div>
        <div class="pmw-tags">
          <span class="pmw-tag state-${c.etat}">● ${c.etat === "bon" ? "Bon état" : "Vigilance"}</span>
          <span class="pmw-tag">${c.virages}</span>
        </div>
      </div>
    `;
    card.addEventListener("click", () => openDetail(i));
    listEl.appendChild(card);
  });

  if (shown === 0) {
    listEl.innerHTML = `<div class="pmw-empty">Aucun col ne correspond à cette recherche.</div>`;
  }
}

function openDetail(i) {
  selectedIndex = i;
  const c = COLS[i];
  const ridden = getRidden().has(c.nom);

  detailEl.classList.add("open");
  detailEl.innerHTML = `
    <div class="pmw-detail-head">
      <div>
        <h2>${c.nom}</h2>
        <div class="pmw-detail-sub">${c.massif} · ${c.alt} m d'altitude</div>
      </div>
      <button class="pmw-ridden-toggle ${ridden ? "on" : ""}" id="pmw-ridden-btn">${ridden ? "✅ Roulé" : "☐ Marquer comme roulé"}</button>
      <button class="pmw-close" id="pmw-close">Fermer</button>
    </div>

    <div class="pmw-weather" id="pmw-weather">
      <div class="pmw-weather-loading">Chargement de la météo en direct…</div>
    </div>

    <div class="pmw-detail-grid">
      <div class="pmw-metric"><b>${c.alt} m</b><span>Altitude sommet</span></div>
      <div class="pmw-metric"><b>${c.etat === "bon" ? "Bon" : "Vigilance"}</b><span>État revêtement</span></div>
      <div class="pmw-metric"><b>${c.massif.split(" / ")[0]}</b><span>Massif</span></div>
    </div>

    <div class="pmw-rating-host" id="pmw-rating-host"></div>

    <div class="pmw-detail-text">
      <p>${c.desc}</p>
      <p><strong>Virages :</strong> ${c.virages}</p>
      <p><strong>Revêtement :</strong> ${c.revetement}</p>
      <p><strong>Ouverture :</strong> ${c.ouverture || "Non renseignée"}</p>
    </div>
    <div class="pmw-note">⚠️ ${c.conseil} — vérifie toujours l'état de la route et la météo avant de partir.</div>
  `;

  document.getElementById("pmw-close").addEventListener("click", () => {
    detailEl.classList.remove("open");
    selectedIndex = null;
    render();
  });

  document.getElementById("pmw-ridden-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    await toggleRidden(c.nom);
    btn.disabled = false;
    openDetail(i);          // ré-affiche la fiche avec le nouvel état
    render();
    renderBadges();
  });

  loadWeather(c.lat, c.lon);

  // widget de notation communautaire (module Firebase)
  const ratingHost = document.getElementById("pmw-rating-host");
  if (ratingHost && window.PyrolosRating) {
    window.PyrolosRating.mount(ratingHost, c);
  }

  render();
  detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- Météo en direct (Open-Meteo, gratuit, sans clé) ---------- */

const WEATHER_ICONS = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "❄️",
  80: "🌦️", 81: "🌧️", 82: "⛈️",
  95: "⛈️", 96: "⛈️", 99: "⛈️"
};

async function loadWeather(lat, lon) {
  const box = document.getElementById("pmw-weather");
  if (!box) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("météo indisponible");
    const data = await res.json();
    const cw = data.current_weather;
    if (!cw) throw new Error("pas de données actuelles");
    const icon = WEATHER_ICONS[cw.weathercode] || "🌡️";
    box.innerHTML = `
      <div class="pmw-weather-icon">${icon}</div>
      <div>
        <div class="pmw-weather-temp">${Math.round(cw.temperature)}°C</div>
        <div class="pmw-weather-desc">Vent ${Math.round(cw.windspeed)} km/h · au sommet, en direct (Open-Meteo)</div>
      </div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="pmw-weather-loading">Météo indisponible pour le moment.</div>`;
    console.error(err);
  }
}

/* ---------- Suivi "cols roulés" ----------
   Délégué à window.PyrolosRidden (module Firebase) :
   Firestore quand l'utilisateur est connecté, localStorage sinon.
   Les fonctions ci-dessous servent de façade synchrone pour le rendu. */

function getRidden() {
  return window.PyrolosRidden ? window.PyrolosRidden.get() : new Set();
}

async function toggleRidden(nom) {
  if (!window.PyrolosRidden) return;
  await window.PyrolosRidden.toggle(nom);
}

/** Rafraîchit tout l'affichage dépendant des cols roulés.
    Appelé par le module Firebase après connexion/déconnexion. */
window.pyrolosRefreshRidden = function () {
  render();
  renderBadges();
  if (selectedIndex !== null) {
    const btn = document.getElementById("pmw-ridden-btn");
    if (btn) {
      const isRidden = getRidden().has(COLS[selectedIndex].nom);
      btn.classList.toggle("on", isRidden);
      btn.textContent = isRidden ? "✅ Roulé" : "☐ Marquer comme roulé";
    }
  }
};

/* ---------- Classement (vue Classement) ---------- */

function renderRanking() {
  if (!rankingEl) return;
  const sorted = [...COLS].sort((a, b) => {
    if (currentSort === "note") return (b.note || 0) - (a.note || 0);
    if (currentSort === "alt") return b.alt - a.alt;
    if (currentSort === "nom") return a.nom.localeCompare(b.nom);
    return 0;
  });

  rankingEl.innerHTML = sorted.map((c, idx) => `
    <div class="pmw-rank-row">
      <div class="pmw-rank-num">${idx + 1}</div>
      <div class="pmw-rank-name"><b>${c.nom}</b><span>${c.massif}</span></div>
      <div class="pmw-rank-note">★ ${c.note ? c.note.toFixed(1) : "–"}<span>/5</span></div>
      <div class="pmw-rank-alt">${c.alt} m</div>
    </div>
  `).join("");
}

function initSort() {
  if (!sortEl) return;
  sortEl.querySelectorAll(".pmw-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      sortEl.querySelectorAll(".pmw-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentSort = chip.dataset.sort;
      renderRanking();
    });
  });
}

/* ---------- Succès (vue Succès) ---------- */

function renderBadges() {
  if (!badgesEl) return;
  const ridden = getRidden();

  // succès débloqués en premier, pour valoriser la progression
  const evalues = BADGES.map(b => ({ b, unlocked: b.test(ridden, COLS) }));
  evalues.sort((x, y) => Number(y.unlocked) - Number(x.unlocked));

  badgesEl.innerHTML = evalues.map(({ b, unlocked }) => `
      <div class="pmw-badge ${unlocked ? "unlocked" : ""}">
        <div class="pmw-badge-icon">${unlocked ? b.icon : "🔒"}</div>
        <div class="pmw-badge-text"><b>${b.nom}</b><span>${b.desc}</span></div>
      </div>
    `).join("");

  const done = evalues.filter(e => e.unlocked).length;
  progressTextEl.textContent =
    `${ridden.size} / ${COLS.length} cols roulés · ${done} / ${BADGES.length} succès`;
  progressFillEl.style.width = `${COLS.length ? (ridden.size / COLS.length) * 100 : 0}%`;
}

/* =========================================================================
   ITINÉRAIRES
   ========================================================================= */

let ROUTES = [];          // itinéraires pré-créés (itineraires.json)
let builderMap = null;    // carte du créateur de parcours
let builderMarkers = {};
let routeLine = null;
let selection = [];       // noms des cols choisis, dans l'ordre

/* ---------- Itinéraires pré-créés ---------- */

async function loadRoutes() {
  try {
    const res = await fetch("itineraires.json");
    if (!res.ok) throw new Error(res.status);
    ROUTES = await res.json();
  } catch (err) {
    console.warn("itineraires.json introuvable :", err);
    ROUTES = [];
  }
  renderRoutes();
}

function renderRoutes() {
  const host = document.getElementById("pmw-routes");
  if (!host) return;

  if (!ROUTES.length) {
    host.innerHTML = `<div class="pmw-empty">Aucun itinéraire pour le moment.</div>`;
    return;
  }

  host.innerHTML = ROUTES.map(r => `
    <a class="pmw-route" href="${r.url}" target="_blank" rel="noopener noreferrer">
      <div class="pmw-route-head">
        <h3>${r.nom}</h3>
        <span class="pmw-route-diff diff-${(r.difficulte || "").toLowerCase()}">${r.difficulte || ""}</span>
      </div>
      <div class="pmw-route-meta">
        ${r.distance ? `<span>📏 ${r.distance}</span>` : ""}
        ${r.duree ? `<span>🕒 ${r.duree}</span>` : ""}
        ${r.depart ? `<span>📍 ${r.depart}</span>` : ""}
      </div>
      <p class="pmw-route-desc">${r.desc || ""}</p>
      ${(r.cols || []).length
        ? `<div class="pmw-route-cols">${r.cols.map(c => `<span>${c}</span>`).join("")}</div>`
        : ""}
      <span class="pmw-route-cta">Ouvrir dans Google Maps →</span>
    </a>
  `).join("");
}

/* ---------- Créateur de parcours ----------
   Itinéraire routier réel via OSRM (sans clé), profil altimétrique via
   Open-Meteo, export GPX. Le tracé suit les vraies routes.               */

const OSRM = "https://router.project-osrm.org/route/v1/driving/";

const trip = {
  start: null,          // {lat, lon, label}
  end: null,
  via: [],              // points de passage libres
  cols: [],             // noms de cols, dans l'ordre
  mode: "boucle",       // boucle | aller-retour | point
  route: null           // résultat OSRM
};

let pickMode = null;    // "start" | "end" | "via" | null
let startMarker = null, endMarker = null, viaMarkers = [], routeLayer = null;

function initBuilder() {
  const mapEl = document.getElementById("pmw-builder-map");
  if (!mapEl) return;

  builderMap = L.map("pmw-builder-map", { zoomControl: true, scrollWheelZoom: false })
                .setView([42.85, 0.6], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 15, attribution: "&copy; OpenStreetMap"
  }).addTo(builderMap);

  // marqueurs des cols : clic = ajouter / retirer du parcours
  COLS.forEach(c => {
    const m = L.circleMarker([c.lat, c.lon], {
      radius: 9, weight: 2, color: "#14161a",
      fillColor: STATE_COLOR[c.etat] || STATE_COLOR.bon, fillOpacity: 1
    }).addTo(builderMap);
    m.bindTooltip(`${c.nom} · ${c.alt} m`, { direction: "top", offset: [0, -6] });
    m.on("click", e => {
      if (pickMode) return;              // en mode sélection de point, on ignore
      L.DomEvent.stopPropagation(e);
      toggleCol(c.nom);
    });
    builderMarkers[c.nom] = m;
  });

  // clic sur la carte = poser le point en cours de sélection
  builderMap.on("click", e => {
    if (!pickMode) return;
    const pt = { lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5) };
    pt.label = `${pt.lat}, ${pt.lon}`;
    if (pickMode === "start") trip.start = pt;
    else if (pickMode === "end") trip.end = pt;
    else if (pickMode === "via") trip.via.push(pt);
    setPickMode(null);
    renderBuilder();
    reverseGeocode(pt);                  // nom lisible, en arrière-plan
  });

  // liste déroulante des cols
  const sel = document.getElementById("pmw-add-col");
  COLS.forEach(c => {
    const o = document.createElement("option");
    o.value = c.nom;
    o.textContent = `${c.nom} (${c.alt} m)`;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    if (sel.value) { toggleCol(sel.value); sel.value = ""; }
  });

  document.querySelectorAll("[data-pick]").forEach(b =>
    b.addEventListener("click", () => setPickMode(b.dataset.pick)));

  document.querySelectorAll(".pmw-mode").forEach(b =>
    b.addEventListener("click", () => {
      trip.mode = b.dataset.mode;
      document.querySelectorAll(".pmw-mode").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("pmw-end-row").hidden = trip.mode !== "point";
      trip.route = null;
      renderBuilder();
    }));

  document.getElementById("pmw-trace").addEventListener("click", traceRoute);
  document.getElementById("pmw-gpx").addEventListener("click", downloadGPX);
  document.getElementById("pmw-open-maps").addEventListener("click", openInGoogleMaps);
  document.getElementById("pmw-clear-route").addEventListener("click", () => {
    trip.start = trip.end = trip.route = null;
    trip.via = []; trip.cols = [];
    renderBuilder();
  });

  renderBuilder();
}

function setPickMode(m) {
  pickMode = m;
  const hint = document.getElementById("pmw-map-hint");
  const labels = {
    start: "Clique sur la carte pour placer le départ",
    end:   "Clique sur la carte pour placer l'arrivée",
    via:   "Clique sur la carte pour ajouter un point de passage"
  };
  hint.hidden = !m;
  if (m) hint.textContent = labels[m];
  document.getElementById("pmw-builder-map").style.cursor = m ? "crosshair" : "";
  document.querySelectorAll("[data-pick]").forEach(b =>
    b.classList.toggle("picking", b.dataset.pick === m));
}

/** Nom lisible d'un point cliqué (Nominatim, sans clé). Best effort. */
async function reverseGeocode(pt) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&zoom=12&lat=${pt.lat}&lon=${pt.lon}`,
      { headers: { "Accept-Language": "fr" } });
    if (!r.ok) return;
    const d = await r.json();
    const a = d.address || {};
    const nom = a.village || a.town || a.city || a.municipality || a.county;
    if (nom) { pt.label = nom; renderBuilder(); }
  } catch { /* on garde les coordonnées */ }
}

function toggleCol(nom) {
  const i = trip.cols.indexOf(nom);
  if (i === -1) trip.cols.push(nom); else trip.cols.splice(i, 1);
  trip.route = null;
  renderBuilder();
}

/** Points du parcours, dans l'ordre, prêts pour OSRM. */
function waypoints() {
  const pts = [];
  if (trip.start) pts.push(trip.start);
  trip.via.forEach(v => pts.push(v));
  trip.cols.forEach(n => {
    const c = COLS.find(x => x.nom === n);
    if (c) pts.push({ lat: c.lat, lon: c.lon, label: c.nom });
  });

  if (trip.mode === "boucle" && trip.start) {
    pts.push(trip.start);
  } else if (trip.mode === "aller-retour") {
    const retour = pts.slice(0, -1).reverse();
    pts.push(...retour);
  } else if (trip.mode === "point" && trip.end) {
    pts.push(trip.end);
  }
  return pts;
}

async function traceRoute() {
  const pts = waypoints();
  const btn = document.getElementById("pmw-trace");
  if (pts.length < 2) return;

  btn.disabled = true;
  btn.textContent = "Calcul de l'itinéraire…";

  try {
    const coords = pts.map(p => `${p.lon},${p.lat}`).join(";");
    const res = await fetch(`${OSRM}${coords}?overview=full&geometries=geojson&steps=false`);
    if (!res.ok) throw new Error("OSRM " + res.status);
    const data = await res.json();
    if (!data.routes || !data.routes.length) throw new Error("aucun itinéraire");

    const r = data.routes[0];
    trip.route = {
      coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distance: r.distance,     // mètres
      duration: r.duration      // secondes
    };

    btn.textContent = "Calcul du dénivelé…";
    trip.route.denivele = await computeElevation(trip.route.coords);
  } catch (err) {
    console.error(err);
    trip.route = null;
    document.getElementById("pmw-result").hidden = false;
    document.getElementById("pmw-result-stats").innerHTML =
      `<div class="pmw-route-error">Impossible de calculer l'itinéraire.
       Le service est peut-être momentanément indisponible, ou aucun trajet
       routier ne relie ces points.</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🏍️ Tracer l'itinéraire";
    renderBuilder();
  }
}

/** Dénivelé positif cumulé, par échantillonnage du tracé (Open-Meteo). */
async function computeElevation(coords) {
  try {
    const N = Math.min(100, coords.length);
    const step = Math.max(1, Math.floor(coords.length / N));
    const sample = coords.filter((_, i) => i % step === 0).slice(0, 100);

    const lats = sample.map(c => c[0].toFixed(4)).join(",");
    const lons = sample.map(c => c[1].toFixed(4)).join(",");
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
    if (!res.ok) throw new Error("elevation " + res.status);
    const { elevation } = await res.json();
    if (!Array.isArray(elevation)) throw new Error("pas de données");

    let dplus = 0;
    for (let i = 1; i < elevation.length; i++) {
      const d = elevation[i] - elevation[i - 1];
      if (d > 0) dplus += d;
    }
    return { dplus: Math.round(dplus), max: Math.round(Math.max(...elevation)) };
  } catch (err) {
    console.warn("Dénivelé indisponible :", err);
    return null;
  }
}

function renderBuilder() {
  if (!builderMap) return;

  // --- cols sélectionnés ---
  COLS.forEach(c => {
    const m = builderMarkers[c.nom];
    if (!m) return;
    const on = trip.cols.includes(c.nom);
    m.setStyle({
      fillColor: on ? "#c98a55" : (STATE_COLOR[c.etat] || STATE_COLOR.bon),
      color: on ? "#f2ead9" : "#14161a",
      radius: on ? 12 : 9, weight: on ? 3 : 2
    });
  });

  const chips = document.getElementById("pmw-col-chips");
  chips.innerHTML = trip.cols.length
    ? trip.cols.map((n, i) => `
        <span class="pmw-chip-item">
          <b>${i + 1}</b>${n}
          <button data-rmcol="${i}" aria-label="Retirer">✕</button>
        </span>`).join("")
    : `<span class="pmw-chips-empty">Aucun col — clique sur la carte ou utilise la liste</span>`;
  chips.querySelectorAll("[data-rmcol]").forEach(b =>
    b.addEventListener("click", () => { trip.cols.splice(+b.dataset.rmcol, 1); trip.route = null; renderBuilder(); }));

  // --- points de passage ---
  const via = document.getElementById("pmw-via-chips");
  via.innerHTML = trip.via.length
    ? trip.via.map((p, i) => `
        <span class="pmw-chip-item">
          ${p.label}<button data-rmvia="${i}" aria-label="Retirer">✕</button>
        </span>`).join("")
    : `<span class="pmw-chips-empty">Aucun</span>`;
  via.querySelectorAll("[data-rmvia]").forEach(b =>
    b.addEventListener("click", () => { trip.via.splice(+b.dataset.rmvia, 1); trip.route = null; renderBuilder(); }));

  // --- libellés départ / arrivée ---
  document.getElementById("pmw-start-label").textContent = trip.start ? trip.start.label : "Non défini";
  document.getElementById("pmw-start-label").classList.toggle("set", !!trip.start);
  document.getElementById("pmw-end-label").textContent = trip.end ? trip.end.label : "Non défini";
  document.getElementById("pmw-end-label").classList.toggle("set", !!trip.end);

  // --- marqueurs départ / arrivée / passages ---
  const pin = (cls, txt) => L.divIcon({
    className: "", html: `<span class="pmw-mk ${cls}">${txt}</span>`,
    iconSize: [24, 24], iconAnchor: [12, 12]
  });
  if (startMarker) { builderMap.removeLayer(startMarker); startMarker = null; }
  if (endMarker)   { builderMap.removeLayer(endMarker);   endMarker = null; }
  viaMarkers.forEach(m => builderMap.removeLayer(m)); viaMarkers = [];

  if (trip.start) startMarker = L.marker([trip.start.lat, trip.start.lon], { icon: pin("d", "D") }).addTo(builderMap);
  if (trip.end && trip.mode === "point")
    endMarker = L.marker([trip.end.lat, trip.end.lon], { icon: pin("a", "A") }).addTo(builderMap);
  trip.via.forEach(p =>
    viaMarkers.push(L.marker([p.lat, p.lon], { icon: pin("p", "P") }).addTo(builderMap)));

  // --- tracé ---
  if (routeLayer) { builderMap.removeLayer(routeLayer); routeLayer = null; }
  if (trip.route) {
    routeLayer = L.polyline(trip.route.coords, {
      color: "#c98a55", weight: 5, opacity: .9
    }).addTo(builderMap);
    builderMap.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
  }

  // --- résultat ---
  const resBox = document.getElementById("pmw-result");
  const stats = document.getElementById("pmw-result-stats");
  if (trip.route) {
    const km = (trip.route.distance / 1000).toFixed(0);
    const h = Math.floor(trip.route.duration / 3600);
    const min = Math.round((trip.route.duration % 3600) / 60);
    const d = trip.route.denivele;
    resBox.hidden = false;
    stats.innerHTML = `
      <div><b>${km} km</b><span>distance</span></div>
      <div><b>${h ? h + " h " : ""}${min} min</b><span>temps de route</span></div>
      ${d ? `<div><b>${d.dplus} m</b><span>dénivelé +</span></div>
             <div><b>${d.max} m</b><span>point haut</span></div>` : ""}`;
  } else if (!stats.querySelector(".pmw-route-error")) {
    resBox.hidden = true;
  }

  // --- bouton ---
  const ready = waypoints().length >= 2;
  document.getElementById("pmw-trace").disabled = !ready;
}

/* ---------- Export GPX ---------- */

function downloadGPX() {
  if (!trip.route) return;
  const nom = `Pyrolos - ${trip.cols.join(" + ") || "itineraire"}`;
  const pts = trip.route.coords
    .map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`)
    .join("\n");

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Pyrolos" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(nom)}</name></metadata>
  <trk>
    <name>${escapeXml(nom)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nom.replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").toLowerCase() + ".gpx";
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

/** Ouvre le même parcours dans Google Maps (URL sans clé d'API). */
function openInGoogleMaps() {
  const pts = waypoints();
  if (pts.length < 2) return;
  const f = p => `${p.lat},${p.lon}`;
  const params = new URLSearchParams({
    api: "1", travelmode: "driving",
    origin: f(pts[0]),
    destination: f(pts[pts.length - 1])
  });
  const mid = pts.slice(1, -1).slice(0, 9);
  if (mid.length) params.set("waypoints", mid.map(f).join("|"));
  window.open(`https://www.google.com/maps/dir/?${params}`, "_blank", "noopener");
}

/* ---------- Onglets ---------- */

function initTabs() {
  const tabs = document.querySelectorAll(".pmw-tab");
  const views = {
    carte: document.getElementById("view-carte"),
    itineraires: document.getElementById("view-itineraires"),
    classement: document.getElementById("view-classement"),
    succes: document.getElementById("view-succes")
  };

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      Object.entries(views).forEach(([key, el]) => {
        el.hidden = key !== tab.dataset.view;
      });
      if (tab.dataset.view === "carte" && map) {
        setTimeout(() => map.invalidateSize(), 50);
      }
      if (tab.dataset.view === "itineraires" && builderMap) {
        setTimeout(() => builderMap.invalidateSize(), 50);
      }
    });
  });
}

searchEl.addEventListener("input", e => {
  currentQuery = e.target.value;
  render();
});
