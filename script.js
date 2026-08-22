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
    test: (r) => r.has("Col du Tourmalet") },

  // --- kilomètres, via les itinéraires marqués « faits » ---
  { id: "km100", icon: "🛞", nom: "Première mise en jambes",
    desc: "100 km d'itinéraires parcourus.",
    test: (r, cols, ctx) => ctx.km >= 100 },

  { id: "km250", icon: "🏍️", nom: "250 bornes au compteur",
    desc: "250 km d'itinéraires parcourus.",
    test: (r, cols, ctx) => ctx.km >= 250 },

  { id: "km500", icon: "🔥", nom: "Grand rouleur",
    desc: "500 km d'itinéraires parcourus.",
    test: (r, cols, ctx) => ctx.km >= 500 },

  { id: "km1000", icon: "🌟", nom: "Le millier",
    desc: "1 000 km cumulés, itinéraires du site et parcours personnels.",
    test: (r, cols, ctx) => ctx.km >= 1000 },

  { id: "km2500", icon: "💫", nom: "Grand voyageur",
    desc: "2 500 km cumulés au guidon.",
    test: (r, cols, ctx) => ctx.km >= 2500 },

  { id: "tousItis", icon: "🗺️", nom: "Tous les parcours",
    desc: "Chaque itinéraire du site, roulé au moins une fois.",
    test: (r, cols, ctx) => ctx.routes > 0 && ctx.faits === ctx.routes }
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
  await loadVilles();
  if (window.PyrolosRoutesFaites) await window.PyrolosRoutesFaites.load();
  buildStats();
  buildMassifChips();
  buildMap();
  render();
  renderRanking();
  renderRouteRanking();
  renderBadges();
  initTabs();
  initSort();
  initRouteSort();
  initRankTabs();
  initBuilder();
  initRiders();
  initMessages();
  initMeteo();
  initHourly();
  initRouteMeteo();
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

let colNotes = {};      // id de col -> { avg, count }

/** Classement des cols, alimenté par les VRAIES notes des utilisateurs. */
async function renderRanking() {
  if (!rankingEl) return;
  rankingEl.innerHTML = `<div class="pmw-empty">Chargement des notes…</div>`;

  // une lecture par col, mise en cache par le module
  if (window.PyrolosColRatings && window.PyrolosColId) {
    await Promise.all(COLS.map(async c => {
      const id = window.PyrolosColId(c);
      colNotes[c.nom] = await window.PyrolosColRatings.get(id);
    }));
  }

  const noteDe = c => {
    const n = colNotes[c.nom];
    return n && n.avg !== null && n.avg !== undefined ? n.avg : null;
  };

  const sorted = [...COLS].sort((a, b) => {
    if (currentSort === "alt") return b.alt - a.alt;
    if (currentSort === "nom") return a.nom.localeCompare(b.nom);
    // par note : les cols sans vote sont renvoyés en fin de liste
    const na = noteDe(a), nb = noteDe(b);
    if (na === null) return nb === null ? 0 : 1;
    if (nb === null) return -1;
    return nb - na;
  });

  rankingEl.innerHTML = sorted.map((c, idx) => {
    const n = colNotes[c.nom] || { avg: null, count: 0 };
    const note = n.avg !== null && n.avg !== undefined
      ? `<div class="pmw-rank-note">★ ${n.avg.toFixed(1)}<span>/5</span></div>
         <div class="pmw-rank-votes">${n.count} vote${n.count > 1 ? "s" : ""}</div>`
      : `<div class="pmw-rank-nonote">pas encore noté</div>`;

    return `
      <div class="pmw-rank-row">
        <div class="pmw-rank-num">${idx + 1}</div>
        <div class="pmw-rank-name"><b>${escapeHtml(c.nom)}</b><span>${escapeHtml(c.massif)}</span></div>
        ${note}
        <div class="pmw-rank-alt">${c.alt} m</div>
      </div>`;
  }).join("");
}

// appelé après chaque vote depuis une fiche de col
window.pyrolosRefreshRanking = renderRanking;

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

/* ---------- Classement des itinéraires ----------
   Alimenté uniquement par les notes réelles enregistrées dans Firestore.
   Un parcours sans vote affiche « pas encore noté » plutôt qu'une valeur
   par défaut : mieux vaut une case vide qu'un chiffre trompeur.        */

let routeSort = "note";
let routeNotes = {};      // id -> { avg, count }

async function renderRouteRanking() {
  const host = document.getElementById("pmw-ranking-routes");
  if (!host) return;

  // sortir en silence rendait le bloc invisible sans expliquer pourquoi
  if (!ROUTES.length) {
    host.innerHTML = `<div class="pmw-empty">
      Aucun itinéraire chargé. Vérifie que <code>itineraires.json</code> est
      bien présent à côté de <code>index.html</code>.
    </div>`;
    return;
  }

  host.innerHTML = `<div class="pmw-empty">Chargement des notes…</div>`;

  // une lecture par itinéraire, mise en cache par le module
  if (window.PyrolosRouteRatings) {
    await Promise.all(ROUTES.map(async r => {
      routeNotes[r.id] = await window.PyrolosRouteRatings.get(r.id);
    }));
  }

  const tri = [...ROUTES].sort((a, b) => {
    if (routeSort === "km") return (b.km || 0) - (a.km || 0);
    if (routeSort === "nom") return a.nom.localeCompare(b.nom);
    // par note : les parcours non notés vont en fin de liste
    const na = routeNotes[a.id]?.avg, nb = routeNotes[b.id]?.avg;
    if (na === null || na === undefined) return (nb === null || nb === undefined) ? 0 : 1;
    if (nb === null || nb === undefined) return -1;
    return nb - na;
  });

  host.innerHTML = tri.map((r, i) => {
    const n = routeNotes[r.id] || { avg: null, count: 0 };
    const noteAff = n.avg !== null && n.avg !== undefined
      ? `<div class="pmw-rank-note">★ ${n.avg.toFixed(1)}<span>/5</span></div>
         <div class="pmw-rank-votes">${n.count} vote${n.count > 1 ? "s" : ""}</div>`
      : `<div class="pmw-rank-nonote">pas encore noté</div>`;

    return `
      <div class="pmw-rank-row ${r.dev ? "is-dev" : ""}">
        <div class="pmw-rank-num">${i + 1}</div>
        <div class="pmw-rank-name">
          <b>${r.dev ? "⭐ " : ""}${escapeHtml(r.nom)}</b>
          <span>${escapeHtml(r.depart || "")}${r.difficulte ? " · " + escapeHtml(r.difficulte) : ""}</span>
        </div>
        ${noteAff}
        <div class="pmw-rank-alt">${r.km ? r.km + " km" : "–"}</div>
      </div>`;
  }).join("");
}

/** Sous-onglets du classement : cols / itinéraires. */
function initRankTabs() {
  const tabs = document.querySelectorAll(".pmw-subtab");
  if (!tabs.length) return;
  const panneaux = {
    cols: document.getElementById("rank-cols"),
    routes: document.getElementById("rank-routes")
  };
  tabs.forEach(t =>
    t.addEventListener("click", () => {
      tabs.forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      Object.entries(panneaux).forEach(([cle, el]) => {
        if (el) el.hidden = cle !== t.dataset.rank;
      });
      // on ne recharge que ce qui devient visible
      if (t.dataset.rank === "routes") renderRouteRanking();
      else renderRanking();
    }));
}

function initRouteSort() {
  const bar = document.getElementById("pmw-sort-routes");
  if (!bar) return;
  bar.querySelectorAll("[data-rsort]").forEach(b =>
    b.addEventListener("click", () => {
      bar.querySelectorAll(".pmw-chip").forEach(c => c.classList.remove("active"));
      b.classList.add("active");
      routeSort = b.dataset.rsort;
      renderRouteRanking();
    }));
}

/* ---------- Succès (vue Succès) ---------- */

function renderBadges() {
  if (!badgesEl) return;
  const ridden = getRidden();

  // succès débloqués en premier, pour valoriser la progression
  // contexte enrichi : kilomètres et itinéraires réalisés
  const faitsSet = window.PyrolosRoutesFaites ? window.PyrolosRoutesFaites.get() : new Set();
  const ctx = {
    km: kmParcourus(),
    faits: ROUTES.filter(r => faitsSet.has(r.id)).length,
    routes: ROUTES.length
  };
  const evalues = BADGES.map(b => ({ b, unlocked: b.test(ridden, COLS, ctx) }));
  evalues.sort((x, y) => Number(y.unlocked) - Number(x.unlocked));

  badgesEl.innerHTML = evalues.map(({ b, unlocked }) => `
      <div class="pmw-badge ${unlocked ? "unlocked" : ""}">
        <div class="pmw-badge-icon">${unlocked ? b.icon : "🔒"}</div>
        <div class="pmw-badge-text"><b>${b.nom}</b><span>${b.desc}</span></div>
      </div>
    `).join("");

  const done = evalues.filter(e => e.unlocked).length;
  progressTextEl.textContent =
    `${ridden.size} / ${COLS.length} cols · ${ctx.km} km parcourus · ${done} / ${BADGES.length} succès`;
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

/** Gabarit d'une carte d'itinéraire, avec note et suivi « fait ». */
function routeCard(r) {
  const fait = window.PyrolosRoutesFaites
             ? window.PyrolosRoutesFaites.get().has(r.id) : false;
  return `
    <div class="pmw-route-wrap ${r.dev ? "is-dev" : ""} ${fait ? "is-done" : ""}" data-route="${r.id}">
      <a class="pmw-route" href="${r.url}" target="_blank" rel="noopener noreferrer">
        <div class="pmw-route-head">
          <h3>${escapeHtml(r.nom)}</h3>
          <span class="pmw-route-diff diff-${(r.difficulte || "").toLowerCase()}">${r.difficulte || ""}</span>
        </div>
        <div class="pmw-route-meta">
          ${r.distance ? `<span>📏 ${escapeHtml(r.distance)}</span>` : ""}
          ${r.duree ? `<span>🕒 ${escapeHtml(r.duree)}</span>` : ""}
          ${r.depart ? `<span>📍 ${escapeHtml(r.depart)}</span>` : ""}
        </div>
        <p class="pmw-route-desc">${escapeHtml(r.desc || "")}</p>
        ${(r.cols || []).length
          ? `<div class="pmw-route-cols">${r.cols.map(c => `<span>${escapeHtml(c)}</span>`).join("")}</div>`
          : ""}
        <span class="pmw-route-cta">Ouvrir dans Google Maps →</span>
        ${r.gpx ? `<span class="pmw-route-gpx" data-gpx="${r.gpx}">⬇ GPX</span>` : ""}
      </a>

      <div class="pmw-route-foot">
        <div class="pmw-route-rating" data-rt="${r.id}">
          <span class="pmw-rt-load">…</span>
        </div>
        <button class="pmw-route-done ${fait ? "on" : ""}" data-done="${r.id}">
          ${fait ? "✅ Parcours fait" : "☐ Marquer comme fait"}
        </button>
      </div>
    </div>`;
}

function renderRoutes() {
  const host = document.getElementById("pmw-routes");
  const devHost = document.getElementById("pmw-dev-routes");
  const devHead = document.getElementById("pmw-dev-head");
  if (!host) return;

  if (!ROUTES.length) {
    host.innerHTML = `<div class="pmw-empty">Aucun itinéraire pour le moment.</div>`;
    return;
  }

  const dev = ROUTES.filter(r => r.dev);
  const autres = ROUTES.filter(r => !r.dev);

  devHead.hidden = dev.length === 0;
  devHost.hidden = dev.length === 0;
  devHost.innerHTML = dev.map(routeCard).join("");
  host.innerHTML = autres.map(routeCard).join("");

  // téléchargement GPX sans suivre le lien de la carte
  document.querySelectorAll("[data-gpx]").forEach(el =>
    el.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const a = document.createElement("a");
      a.href = el.dataset.gpx; a.download = ""; a.click();
    }));

  // case « parcours fait » : alimente les succès kilométriques
  document.querySelectorAll("[data-done]").forEach(b =>
    b.addEventListener("click", async e => {
      e.preventDefault();
      b.disabled = true;
      await window.PyrolosRoutesFaites.toggle(b.dataset.done);
      renderRoutes();
      renderBadges();
    }));

  // notes, chargées ensuite pour ne pas retarder l'affichage
  ROUTES.forEach(r => montrerNoteItineraire(r.id));
}

/** Bloc d'étoiles d'un itinéraire. */
async function montrerNoteItineraire(id) {
  const host = document.querySelector(`[data-rt="${id}"]`);
  if (!host || !window.PyrolosRouteRatings) return;

  const d = await window.PyrolosRouteRatings.get(id);
  const connecte = window.PyrolosRouteRatings.isSignedIn();
  const votes = d.count === 0 ? "aucun vote"
              : d.count === 1 ? "1 vote" : `${d.count} votes`;

  host.innerHTML = `
    <span class="pmw-rt-avg">${d.avg ? d.avg.toFixed(1) : "–"}<em>/5</em></span>
    <span class="pmw-rt-stars">
      ${[1,2,3,4,5].map(n =>
        `<button class="pmw-star ${d.mine >= n ? "on" : ""}" data-rtstar="${n}"
                 ${connecte ? "" : "disabled"}
                 title="${d.mine === n ? "Cliquer pour retirer ta note" : "Noter " + n + "/5"}"
                 aria-label="Noter ${n} sur 5">★</button>`).join("")}
    </span>
    <span class="pmw-rt-count">${votes}</span>
    ${d.mine ? `<button class="pmw-rt-clear" data-rtclear="${id}"
                        title="Retirer ma note">✕ ma note (${d.mine}/5)</button>` : ""}`;

  host.querySelectorAll("[data-rtstar]").forEach(b =>
    b.addEventListener("click", async e => {
      e.preventDefault();
      const valeur = +b.dataset.rtstar;
      // recliquer sur l'étoile déjà choisie retire la note : c'est le
      // geste naturel quand on s'est trompé
      if (d.mine === valeur) {
        await window.PyrolosRouteRatings.remove(id);
      } else {
        await window.PyrolosRouteRatings.set(id, valeur);
      }
      montrerNoteItineraire(id);
      renderRouteRanking();
    }));

  const clr = host.querySelector("[data-rtclear]");
  if (clr) clr.addEventListener("click", async e => {
    e.preventDefault();
    await window.PyrolosRouteRatings.remove(id);
    montrerNoteItineraire(id);
    renderRouteRanking();
  });
}

/** Kilomètres cumulés des itinéraires marqués « faits ». */
window.pyrolosRefreshRoutes = function () {
  if (typeof renderRoutes === "function") renderRoutes();
  if (typeof renderBadges === "function") renderBadges();
};

function kmParcourus() {
  // itinéraires du site cochés « faits »
  let km = 0;
  if (window.PyrolosRoutesFaites) {
    const faits = window.PyrolosRoutesFaites.get();
    km += ROUTES.filter(r => faits.has(r.id))
                .reduce((s, r) => s + (r.km || 0), 0);
  }
  // itinéraires composés par l'utilisateur, dont la distance est mesurée
  // par OSRM et stockée en mètres
  km += MY_TRIPS.filter(t => t.fait)
                .reduce((s, t) => s + Math.round((t.distance || 0) / 1000), 0);
  return km;
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

  document.getElementById("pmw-start-clear").addEventListener("click", () => {
    trip.start = null; trip.route = null; setPickMode(null); renderBuilder();
  });
  document.getElementById("pmw-end-clear").addEventListener("click", () => {
    trip.end = null; trip.route = null; setPickMode(null); renderBuilder();
  });

  document.querySelectorAll(".pmw-mode").forEach(b =>
    b.addEventListener("click", () => {
      trip.mode = b.dataset.mode;
      document.querySelectorAll(".pmw-mode").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      majArrivee();
      trip.route = null;
      renderBuilder();
    }));

  document.getElementById("pmw-trace").addEventListener("click", traceRoute);

  // recherche de lieu : permet de composer un parcours n'importe où,
  // pas seulement dans les Pyrénées
  const geoInput = document.getElementById("pmw-geo");
  const geoGo = document.getElementById("pmw-geo-go");
  geoGo.addEventListener("click", () => chercherLieu(geoInput.value));
  geoInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); chercherLieu(geoInput.value); }
  });
  document.getElementById("pmw-save-trip").addEventListener("click", saveTrip);
  document.getElementById("pmw-fuel-toggle").addEventListener("click", toggleFuel);
  document.getElementById("pmw-gpx").addEventListener("click", downloadGPX);
  document.getElementById("pmw-open-maps").addEventListener("click", openInGoogleMaps);
  document.getElementById("pmw-clear-route").addEventListener("click", () => {
    trip.start = trip.end = trip.route = null;
    trip.via = []; trip.cols = [];
    renderBuilder();
  });

  majArrivee();
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

  // les marqueurs existants ne doivent pas intercepter le clic quand on
  // est en train de désigner un nouveau point sur la carte
  [startMarker, endMarker, ...viaMarkers].forEach(mk => {
    if (!mk || !mk._icon) return;
    mk._icon.style.pointerEvents = m ? "none" : "";
  });
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

/** Affiche le bloc Arrivée uniquement quand elle diffère du départ,
    et rappelle en clair ce que fait le mode choisi. */
function majArrivee() {
  const bl = document.getElementById("pmw-end-bl");
  const hint = document.getElementById("pmw-mode-hint");
  if (bl) bl.hidden = trip.mode !== "point";
  if (hint) {
    hint.textContent =
      trip.mode === "boucle" ? "Le tracé revient au point de départ."
      : trip.mode === "aller-retour" ? "Même route parcourue dans les deux sens."
      : "Choisis un point d'arrivée différent du départ.";
  }
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
    const base = `${OSRM}${coords}?overview=full&geometries=geojson&steps=false`;

    // On demande d'abord un tracé SANS autoroute ni péage : c'est tout
    // l'intérêt d'une sortie moto. Si le serveur refuse ce paramètre ou
    // ne trouve aucun trajet dans ces conditions, on retombe sur le
    // calcul normal plutôt que d'échouer.
    let data = null, avoided = true;
    try {
      const r1 = await fetch(base + "&exclude=motorway,toll");
      if (r1.ok) {
        const d1 = await r1.json();
        if (d1.routes && d1.routes.length) data = d1;
      }
    } catch { /* on tentera sans exclusion */ }

    if (!data) {
      avoided = false;
      const r2 = await fetch(base);
      if (!r2.ok) throw new Error("OSRM " + r2.status);
      data = await r2.json();
      if (!data.routes || !data.routes.length) throw new Error("aucun itinéraire");
    }

    const r = data.routes[0];
    trip.route = {
      coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
      distance: r.distance,     // mètres
      duration: r.duration,     // secondes
      avoided                   // autoroutes et péages évités ?
    };

    btn.textContent = "Calcul du dénivelé…";
    trip.route.denivele = await computeElevation(trip.route.coords);
    fuelCache = null;   // l'emprise a changé : les stations seront rechargées
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

  /* Marqueur déplaçable : on peut corriger un point sans tout refaire.
     En mode « choisir sur la carte », il devient transparent aux clics,
     sinon il intercepterait le clic destiné à la carte — ce qui donnait
     l'impression qu'un point posé ne pouvait plus être déplacé. */
  const poser = (pt, cls, txt, cible) => {
    const m = L.marker([pt.lat, pt.lon], {
      icon: pin(cls, txt),
      draggable: true,
      interactive: !pickMode,
      autoPan: true
    }).addTo(builderMap);

    const libelle = txt === "D" ? "Départ"
                  : txt === "D/A" ? "Départ et arrivée"
                  : txt === "A" ? "Arrivée" : "Passage";
    m.bindTooltip(`${libelle} — glisser pour déplacer`,
                  { direction: "top", offset: [0, -12] });

    m.on("dragend", e => {
      const ll = e.target.getLatLng();
      cible.lat = +ll.lat.toFixed(5);
      cible.lon = +ll.lng.toFixed(5);
      cible.label = `${cible.lat}, ${cible.lon}`;
      trip.route = null;              // le tracé n'est plus valable
      renderBuilder();
      reverseGeocode(cible);
    });
    return m;
  };
  if (startMarker) { builderMap.removeLayer(startMarker); startMarker = null; }
  if (endMarker)   { builderMap.removeLayer(endMarker);   endMarker = null; }
  viaMarkers.forEach(m => builderMap.removeLayer(m)); viaMarkers = [];

  // En boucle et en aller-retour, l'arrivée EST le départ : le marqueur
  // porte alors « D/A » pour que la carte le dise clairement, plutôt que
  // de laisser croire qu'aucune arrivée n'est définie.
  const boucle = trip.mode === "boucle" || trip.mode === "aller-retour";
  if (trip.start) {
    startMarker = poser(trip.start, boucle ? "da" : "d", boucle ? "D/A" : "D", trip.start);
  }
  if (trip.end && trip.mode === "point") endMarker = poser(trip.end, "a", "A", trip.end);
  trip.via.forEach(p => viaMarkers.push(poser(p, "p", "P", p)));

  // boutons d'effacement, visibles seulement si le point existe
  const sc = document.getElementById("pmw-start-clear");
  const ec = document.getElementById("pmw-end-clear");
  if (sc) sc.hidden = !trip.start;
  if (ec) ec.hidden = !(trip.end && trip.mode === "point");
  majArrivee();

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
             <div><b>${d.max} m</b><span>point haut</span></div>` : ""}
      <em class="${trip.route.avoided ? "pmw-ok-inline" : "pmw-warn-inline"}">
        ${trip.route.avoided
          ? "✓ Sans autoroute ni péage"
          : "⚠️ Tracé standard : aucun trajet trouvé en évitant totalement autoroutes et péages"}
      </em>`;
  } else if (!stats.querySelector(".pmw-route-error")) {
    resBox.hidden = true;
  }

  // --- bouton ---
  const ready = waypoints().length >= 2;
  document.getElementById("pmw-trace").disabled = !ready;
}

/* ---------- Météo le long du parcours ----------
   On échantillonne le tracé, on estime l'heure de passage à chaque point
   à partir de la durée calculée par OSRM, puis on récupère la prévision
   HORAIRE correspondante. Fonctionne partout dans le monde : les fuseaux
   sont gérés via l'offset renvoyé par Open-Meteo pour chaque point.      */

function initRouteMeteo() {
  const btn = document.getElementById("pmw-rm-go");
  if (!btn) return;
  btn.addEventListener("click", meteoParcours);

  // heure de départ par défaut : maintenant, arrondi au quart d'heure
  const input = document.getElementById("pmw-rm-depart");
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
                  .toISOString().slice(0, 16);
}

/** Points répartis régulièrement le long du tracé, avec leur avancement. */
function echantillonner(coords, n) {
  if (coords.length <= n) {
    return coords.map((c, i) => ({ lat: c[0], lon: c[1], frac: i / (coords.length - 1 || 1) }));
  }
  const pas = (coords.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * pas);
    out.push({ lat: coords[idx][0], lon: coords[idx][1], frac: i / (n - 1) });
  }
  return out;
}

async function meteoParcours() {
  const body = document.getElementById("pmw-rm-body");
  const btn = document.getElementById("pmw-rm-go");
  if (!trip.route) return;

  const depInput = document.getElementById("pmw-rm-depart").value;
  const depart = depInput ? new Date(depInput) : new Date();
  if (isNaN(depart.getTime())) {
    body.innerHTML = `<div class="pmw-rm-msg">Heure de départ invalide.</div>`;
    return;
  }

  btn.disabled = true;
  body.innerHTML = `<div class="pmw-rm-msg">Analyse du parcours…</div>`;

  try {
    const pts = echantillonner(trip.route.coords, 6);
    const lats = pts.map(p => p.lat.toFixed(4)).join(",");
    const lons = pts.map(p => p.lon.toFixed(4)).join(",");

    const url = "https://api.open-meteo.com/v1/forecast"
      + `?latitude=${lats}&longitude=${lons}`
      + "&hourly=temperature_2m,weather_code,precipitation,wind_speed_10m"
      + "&forecast_days=3&timezone=auto";

    const res = await fetch(url);
    if (!res.ok) throw new Error("Open-Meteo " + res.status);
    const brut = await res.json();
    const liste = Array.isArray(brut) ? brut : [brut];

    const dureeMs = trip.route.duration * 1000;
    let alertes = 0;

    const lignes = pts.map((p, i) => {
      const m = liste[i];
      if (!m || !m.hourly) return "";

      // heure de passage estimée à ce point du parcours
      const eta = new Date(depart.getTime() + p.frac * dureeMs);

      // les horaires renvoyés sont en heure LOCALE du point : on ramène
      // l'ETA dans ce même repère avant de comparer
      // Open-Meteo renvoie les horaires en heure locale du point ; on
      // décale donc l'ETA du même offset avant de comparer. Cela rend le
      // calcul correct que le parcours soit dans les Pyrénées ou aux
      // antipodes, quel que soit le fuseau de celui qui consulte.
      const offset = (m.utc_offset_seconds || 0) * 1000;
      const cible = eta.getTime() + offset;

      let idx = 0, meilleur = Infinity;
      m.hourly.time.forEach((t, j) => {
        const tms = Date.parse(t + "Z");        // chaîne locale lue comme UTC
        const ecart = Math.abs(tms - cible);
        if (ecart < meilleur) { meilleur = ecart; idx = j; }
      });

      const t = Math.round(m.hourly.temperature_2m[idx]);
      const code = m.hourly.weather_code[idx];
      const vent = Math.round(m.hourly.wind_speed_10m[idx]);
      const pluie = m.hourly.precipitation[idx];
      const al = alerteMoto(code, vent, t);
      if (al) alertes++;

      const heureLocale = m.hourly.time[idx].slice(11, 16);
      const km = Math.round((trip.route.distance / 1000) * p.frac);
      const etiquette = i === 0 ? "Départ"
                      : i === pts.length - 1 ? "Arrivée"
                      : `km ${km}`;

      return `
        <div class="pmw-rm-row ${al ? "a-" + al.niv : ""}">
          <span class="k">${etiquette}</span>
          <span class="h">${heureLocale}</span>
          <span class="i">${WEATHER_ICONS[code] || "🌡️"}</span>
          <span class="t">${t}°</span>
          <span class="w">${vent} km/h</span>
          <span class="p">${pluie > 0.05 ? pluie.toFixed(1) + " mm" : "–"}</span>
          <span class="a">${al ? `<em class="${al.niv}">${al.txt}</em>` : ""}</span>
        </div>`;
    }).join("");

    const verdict = alertes === 0
      ? `<div class="pmw-rm-verdict ok">✓ Conditions favorables sur l'ensemble du parcours</div>`
      : `<div class="pmw-rm-verdict ko">⚠️ ${alertes} point${alertes > 1 ? "s" : ""} de vigilance sur le parcours</div>`;

    body.innerHTML = verdict + `<div class="pmw-rm-list">${lignes}</div>`
      + `<p class="pmw-rm-note">Heures locales de chaque point, estimées d'après
         la durée de route (sans les pauses). Prévision à 3 jours maximum.</p>`;
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="pmw-rm-msg">Météo du parcours indisponible pour le moment.</div>`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Recherche de lieu (monde entier) ----------
   Géocodage par Nominatim (OpenStreetMap), sans clé d'API.
   Sert à déplacer la carte hors des Pyrénées : le calcul d'itinéraire
   OSRM et l'export Google Maps fonctionnent partout dans le monde.   */

async function chercherLieu(texte) {
  const q = (texte || "").trim();
  const box = document.getElementById("pmw-geo-results");
  const btn = document.getElementById("pmw-geo-go");
  if (!q) return;

  btn.disabled = true;
  btn.textContent = "…";
  box.hidden = false;
  box.innerHTML = `<div class="pmw-geo-msg">Recherche…</div>`;

  try {
    const url = "https://nominatim.openstreetmap.org/search"
      + `?format=json&limit=5&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "fr" } });
    if (!res.ok) throw new Error(res.status);
    const lieux = await res.json();

    if (!lieux.length) {
      box.innerHTML = `<div class="pmw-geo-msg">Aucun lieu trouvé.</div>`;
      return;
    }

    box.innerHTML = lieux.map((l, i) => `
      <button class="pmw-geo-item" data-geo="${i}"
              data-lat="${l.lat}" data-lon="${l.lon}">
        ${escapeHtml(l.display_name)}
      </button>`).join("");

    box.querySelectorAll("[data-geo]").forEach(b =>
      b.addEventListener("click", () => {
        builderMap.setView([+b.dataset.lat, +b.dataset.lon], 11);
        box.hidden = true;
        document.getElementById("pmw-geo").value = "";
      }));
  } catch (err) {
    console.error(err);
    box.innerHTML = `<div class="pmw-geo-msg">Recherche indisponible pour le moment.</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Chercher";
  }
}

/* ---------- Stations-service ----------
   Données OpenStreetMap via Overpass (gratuit, sans clé).
   Chargement à la demande, sur l'emprise visible ou celle du tracé.  */

// Plusieurs instances Overpass : l'API publique principale est souvent
// saturée (504). On essaie les serveurs miroirs l'un après l'autre.
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
let fuelLayer = null;
let fuelShown = false;
let fuelCache = null;      // { bbox, stations }

function fuelIcon() {
  return L.divIcon({
    className: "",
    html: '<span class="pmw-fuel-mk">⛽</span>',
    iconSize: [22, 22], iconAnchor: [11, 11]
  });
}

/**
 * Interroge Overpass en essayant les serveurs successivement.
 * Les instances publiques renvoient fréquemment 504 (saturation) ou
 * 429 (trop de requêtes) : on bascule alors sur le miroir suivant.
 */
async function queryOverpass(q, label) {
  let lastErr;
  for (let i = 0; i < OVERPASS_SERVERS.length; i++) {
    if (label) label.textContent = i === 0 ? "Chargement…" : `Serveur ${i + 1}…`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(OVERPASS_SERVERS[i], {
        method: "POST",
        body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: ctrl.signal
      });
      clearTimeout(timer);

      // serveur saturé ou quota atteint : on tente le suivant
      if (res.status === 504 || res.status === 429 || res.status === 503) {
        lastErr = new Error("serveur occupé (" + res.status + ")");
        continue;
      }
      if (!res.ok) { lastErr = new Error("HTTP " + res.status); continue; }
      return await res.json();
    } catch (err) {
      lastErr = err;   // délai dépassé ou réseau : serveur suivant
    }
  }
  throw lastErr || new Error("aucun serveur disponible");
}

async function toggleFuel() {
  const btn = document.getElementById("pmw-fuel-toggle");
  const label = document.getElementById("pmw-fuel-label");

  if (fuelShown) {
    if (fuelLayer) { builderMap.removeLayer(fuelLayer); fuelLayer = null; }
    fuelShown = false;
    btn.classList.remove("on");
    label.textContent = "Stations";
    return;
  }

  // emprise : celle du tracé si présent, sinon la vue courante
  let b;
  if (routeLayer) {
    b = routeLayer.getBounds().pad(0.12);
  } else {
    b = builderMap.getBounds();
  }
  const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
                 .map(v => v.toFixed(4)).join(",");

  btn.disabled = true;
  label.textContent = "Chargement…";

  try {
    let stations;
    if (fuelCache && fuelCache.bbox === bbox) {
      stations = fuelCache.stations;
    } else {
      const q = `[out:json][timeout:20];
        (node["amenity"="fuel"](${bbox});
         way["amenity"="fuel"](${bbox}););
        out center 200;`;

      const data = await queryOverpass(q, label);
      stations = (data.elements || []).map(el => ({
        lat: el.lat ?? el.center?.lat,
        lon: el.lon ?? el.center?.lon,
        nom: el.tags?.name || el.tags?.brand || "Station-service",
        h24: el.tags?.opening_hours === "24/7",
        cb: el.tags?.["payment:credit_cards"] === "yes"
      })).filter(s => s.lat && s.lon);
      fuelCache = { bbox, stations };
    }

    if (!stations.length) {
      label.textContent = "Aucune station";
      setTimeout(() => { label.textContent = "Stations"; }, 2200);
      return;
    }

    fuelLayer = L.layerGroup(
      stations.map(s =>
        L.marker([s.lat, s.lon], { icon: fuelIcon() })
         .bindTooltip(
           `<b>${s.nom}</b>${s.h24 ? "<br>Ouvert 24h/24" : ""}${s.cb ? "<br>Carte bancaire" : ""}`,
           { direction: "top", offset: [0, -8] })
      )
    ).addTo(builderMap);

    fuelShown = true;
    btn.classList.add("on");
    label.textContent = `${stations.length} stations`;
  } catch (err) {
    console.warn("Stations indisponibles :", err);
    label.textContent = "Serveurs occupés";
    btn.title = "Le service OpenStreetMap est momentanément saturé. Réessaie dans un instant.";
    setTimeout(() => {
      label.textContent = "Réessayer";
      btn.title = "Afficher les stations-service";
    }, 2500);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Itinéraires personnels ---------- */

async function saveTrip() {
  const hint = document.getElementById("pmw-save-hint");
  const nameEl = document.getElementById("pmw-save-name");
  const descEl = document.getElementById("pmw-save-desc");
  const btn = document.getElementById("pmw-save-trip");

  if (!window.PyrolosTrips) return;
  if (!window.PyrolosTrips.isSignedIn()) {
    hint.textContent = "Connecte-toi pour enregistrer un itinéraire.";
    hint.className = "pmw-save-hint ko";
    return;
  }
  if (!trip.route) {
    hint.textContent = "Trace d'abord l'itinéraire.";
    hint.className = "pmw-save-hint ko";
    return;
  }
  const nom = nameEl.value.trim();
  if (!nom) {
    hint.textContent = "Donne un nom à ton itinéraire.";
    hint.className = "pmw-save-hint ko";
    nameEl.focus();
    return;
  }

  btn.disabled = true;
  hint.textContent = "Enregistrement…";
  hint.className = "pmw-save-hint";
  try {
    await window.PyrolosTrips.save({
      nom,
      desc: descEl.value.trim(),
      mode: trip.mode,
      start: trip.start,
      end: trip.end,
      via: trip.via,
      cols: trip.cols,
      distance: trip.route.distance,
      duration: trip.route.duration,
      dplus: trip.route.denivele ? trip.route.denivele.dplus : 0
    });
    nameEl.value = ""; descEl.value = "";
    hint.textContent = "✓ Itinéraire enregistré.";
    hint.className = "pmw-save-hint ok";
    await renderMyTrips();
  } catch (err) {
    console.error(err);
    hint.textContent = "Enregistrement impossible.";
    hint.className = "pmw-save-hint ko";
  } finally {
    btn.disabled = false;
  }
}

/** Affiche la liste des itinéraires personnels (rien si non connecté). */
async function renderMyTrips() {
  const head = document.getElementById("pmw-mine-head");
  const host = document.getElementById("pmw-my-routes");
  if (!host || !window.PyrolosTrips) return;

  if (!window.PyrolosTrips.isSignedIn()) {
    head.hidden = true; host.hidden = true; host.innerHTML = "";
    return;
  }

  const trips = await window.PyrolosTrips.list();
  MY_TRIPS = trips;                 // mémorisé pour le cumul kilométrique
  head.hidden = false;
  host.hidden = false;

  if (!trips.length) {
    host.innerHTML = `<div class="pmw-empty">Aucun itinéraire enregistré. Compose ton parcours plus bas, puis clique sur « Enregistrer ».</div>`;
    return;
  }

  host.innerHTML = trips.map(t => `
    <div class="pmw-route pmw-route-mine ${t.fait ? "is-done" : ""}">
      <div class="pmw-route-head">
        <h3>${escapeHtml(t.nom)}</h3>
        <span class="pmw-route-diff">${t.mode || ""}</span>
      </div>
      <div class="pmw-route-meta">
        ${t.distance ? `<span>📏 ${Math.round(t.distance / 1000)} km</span>` : ""}
        ${t.duration ? `<span>🕒 ${formatDuration(t.duration)}</span>` : ""}
        ${t.dplus ? `<span>⛰️ ${t.dplus} m D+</span>` : ""}
      </div>
      ${t.desc ? `<p class="pmw-route-desc">${escapeHtml(t.desc)}</p>` : ""}
      ${(t.cols || []).length
        ? `<div class="pmw-route-cols">${t.cols.map(c => `<span>${escapeHtml(c)}</span>`).join("")}</div>` : ""}
      <div class="pmw-route-mine-actions">
        <button class="pmw-route-done ${t.fait ? "on" : ""}" data-trip-done="${t.id}">
          ${t.fait ? "✅ Parcours fait" : "☐ Marquer comme fait"}
        </button>
        <button class="pmw-btn pmw-btn-ghost pmw-btn-sm" data-load="${t.id}">↺ Recharger</button>
        <button class="pmw-link" data-del-trip="${t.id}">Supprimer</button>
      </div>
    </div>
  `).join("");

  host.querySelectorAll("[data-trip-done]").forEach(b =>
    b.addEventListener("click", async () => {
      const t = trips.find(x => x.id === b.dataset.tripDone);
      b.disabled = true;
      await window.PyrolosTrips.toggleDone(t.id, !t.fait);
      await renderMyTrips();
      renderBadges();
    }));

  host.querySelectorAll("[data-load]").forEach(b =>
    b.addEventListener("click", () => loadTrip(trips.find(t => t.id === b.dataset.load))));

  host.querySelectorAll("[data-del-trip]").forEach(b =>
    b.addEventListener("click", async () => {
      b.textContent = "…";
      await window.PyrolosTrips.remove(b.dataset.delTrip);
      await renderMyTrips();
    }));
}

/** Recharge un itinéraire enregistré dans le créateur et le retrace. */
function loadTrip(t) {
  if (!t) return;
  trip.start = t.start || null;
  trip.end   = t.end || null;
  trip.via   = t.via || [];
  trip.cols  = t.cols || [];
  trip.mode  = t.mode || "boucle";
  trip.route = null;

  document.querySelectorAll(".pmw-mode").forEach(x =>
    x.classList.toggle("active", x.dataset.mode === trip.mode));
  majArrivee();

  renderBuilder();
  document.querySelector(".pmw-builder").scrollIntoView({ behavior: "smooth", block: "start" });
  traceRoute();
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

// appelé par le module Firebase à chaque connexion / déconnexion
window.pyrolosRefreshTrips = renderMyTrips;

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

  /* On utilise le format HÉRITÉ de Google Maps (saddr / daddr / dirflg)
     et non le format `api=1`. Raison : `dirflg` est la seule option
     d'URL qui permette réellement d'éviter autoroutes et péages.
       h = éviter les autoroutes
       t = éviter les péages
     Le paramètre `avoid` du format api=1 appartient à l'API Directions
     (payante, côté serveur) : dans une URL, Google l'ignore purement et
     simplement — le trajet repassait donc par l'autoroute. */
  const etapes = pts.slice(1).slice(0, 9).map(f);
  const url = "https://www.google.com/maps"
            + `?saddr=${f(pts[0])}`
            + `&daddr=${etapes.join("+to:")}`
            + "&dirflg=ht";

  window.open(url, "_blank", "noopener");
}

/* =========================================================================
   ROULER ENSEMBLE
   ========================================================================= */

const STYLE_LABELS = {
  tranquille: "Tranquille",
  normal:     "Normal",
  sportif:    "Sportif",
  arsouille:  "Arsouille"
};

let RIDERS = [];
let filterMassif = "", filterStyle = "";
let cardStyles = ["normal"];          // styles cochés dans le formulaire
const MAX_STYLES = 3;

/** Styles d'une fiche, en gérant les anciennes fiches à style unique. */
function stylesOf(r) {
  if (Array.isArray(r.styles) && r.styles.length) return r.styles;
  return r.style ? [r.style] : [];
}

function initRiders() {
  const btn = document.getElementById("pmw-my-card-btn");
  if (!btn) return;

  // secteurs : les massifs des cols + une option générale
  const massifs = [...new Set(COLS.map(c => c.massif))];
  const selFilter = document.getElementById("pmw-filter-massif");
  const selForm = document.getElementById("pmw-card-massif");
  massifs.forEach(m => {
    selFilter.appendChild(new Option(m, m));
    selForm.appendChild(new Option(m, m));
  });
  selForm.appendChild(new Option("Toutes les Pyrénées", "Toutes les Pyrénées"));
  selForm.appendChild(new Option("Ailleurs dans le monde", "Ailleurs dans le monde"));
  selFilter.appendChild(new Option("Ailleurs dans le monde", "Ailleurs dans le monde"));

  selFilter.addEventListener("change", e => { filterMassif = e.target.value; renderRiders(); });
  document.getElementById("pmw-filter-style")
    .addEventListener("change", e => { filterStyle = e.target.value; renderRiders(); });

  btn.addEventListener("click", openCardModal);

  document.querySelectorAll(".pmw-style-opt").forEach(b =>
    b.addEventListener("click", () => toggleCardStyle(b.dataset.style)));
  document.getElementById("pmw-card-save").addEventListener("click", saveCard);
  document.getElementById("pmw-card-delete").addEventListener("click", deleteCard);

  const modal = document.getElementById("pmw-card-modal");
  modal.addEventListener("click", e => {
    if (e.target.hasAttribute("data-card-close")) modal.hidden = true;
  });
  // Échap ferme aussi la fenêtre : on ne doit jamais s'y sentir coincé
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
  });

  loadRiders();
}

async function loadRiders() {
  if (!window.PyrolosRiders) return;
  RIDERS = await window.PyrolosRiders.list();
  renderRiders();
}

/** Gabarit d'une fiche. `mine` ajoute les commandes de modification. */
function riderCard(r, mine = false) {
  return `
    <div class="pmw-rider style-${stylesOf(r)[0] || "normal"} ${mine ? "is-mine" : ""}">
      ${mine ? `<button class="pmw-rider-del" id="pmw-del-card" title="Supprimer ma fiche" aria-label="Supprimer ma fiche">✕</button>` : ""}
      <div class="pmw-rider-head">
        <h3>${escapeHtml(r.pseudo || "Motard")}</h3>
      </div>
      <div class="pmw-rider-styles">
        ${stylesOf(r).map(s =>
          `<span class="pmw-rider-style s-${s}">${STYLE_LABELS[s] || s}</span>`).join("")}
      </div>
      <div class="pmw-rider-meta">
        ${r.massif ? `<span>📍 ${escapeHtml(r.massif)}</span>` : ""}
        ${r.moto ? `<span>🏍️ ${escapeHtml(r.moto)}</span>` : ""}
        ${r.dispo ? `<span>🗓️ ${escapeHtml(r.dispo)}</span>` : ""}
        ${r.cols ? `<span>⛰️ ${r.cols} cols roulés</span>` : ""}
      </div>
      ${r.desc ? `<p class="pmw-rider-desc">${escapeHtml(r.desc)}</p>` : ""}
      <div class="pmw-rider-actions">
        ${mine
          ? `<button class="pmw-rider-msg" id="pmw-edit-card">✏️ Modifier</button>`
          : `<button class="pmw-rider-msg" data-msg-uid="${r.id}" data-msg-nom="${escapeHtml(r.pseudo || "Motard")}">✉️ Message</button>`}
        ${r.instagram
          ? `<a class="pmw-rider-insta" href="https://instagram.com/${encodeURIComponent(r.instagram)}"
                target="_blank" rel="noopener noreferrer">📷 @${escapeHtml(r.instagram)}</a>`
          : (mine ? "" : "")}
      </div>
    </div>`;
}

function renderRiders() {
  const host = document.getElementById("pmw-riders");
  const countEl = document.getElementById("pmw-riders-count");
  const mineWrap = document.getElementById("pmw-my-card-wrap");
  const mineHost = document.getElementById("pmw-my-card");
  const othersTitle = document.getElementById("pmw-others-title");
  if (!host) return;

  const me = window.PyrolosRiders && window.PyrolosRiders.isSignedIn()
             ? window.PyrolosRiders.myUid() : null;

  // --- ma fiche, isolée en haut ---
  const mine = me ? RIDERS.find(r => r.id === me) : null;
  if (mine) {
    mineWrap.hidden = false;
    mineHost.innerHTML = riderCard(mine, true);
    document.getElementById("pmw-edit-card").addEventListener("click", openCardModal);
    document.getElementById("pmw-del-card").addEventListener("click", confirmDeleteCard);
  } else {
    mineWrap.hidden = true;
    mineHost.innerHTML = "";
  }

  // le bouton principal s'adapte à l'existence d'une fiche
  const btn = document.getElementById("pmw-my-card-btn");
  if (btn) btn.textContent = mine ? "✏️ Modifier ma fiche" : "🤝 Créer ma fiche";

  // --- les autres ---
  const list = RIDERS.filter(r =>
    r.id !== me &&
    (!filterMassif || r.massif === filterMassif) &&
    (!filterStyle || stylesOf(r).includes(filterStyle)));

  othersTitle.hidden = !mine;

  if (!list.length) {
    host.innerHTML = `<div class="pmw-empty">
      ${RIDERS.filter(r => r.id !== me).length
        ? "Aucune fiche ne correspond à ces filtres."
        : "Personne d'autre pour le moment. Reviens bientôt !"}
    </div>`;
    countEl.textContent = "";
    return;
  }

  host.innerHTML = list.map(r => riderCard(r, false)).join("");

  host.querySelectorAll("[data-msg-uid]").forEach(b =>
    b.addEventListener("click", () => messageRider(b.dataset.msgUid, b.dataset.msgNom)));

  const n = list.length;
  countEl.textContent = n === 1
    ? "1 autre motard sur la ligne de départ."
    : `${n} autres motards sur la ligne de départ.`;
}

/** Coche / décoche un style, dans la limite de MAX_STYLES. */
function toggleCardStyle(id) {
  const hint = document.getElementById("pmw-style-hint");
  const i = cardStyles.indexOf(id);

  if (i !== -1) {
    cardStyles.splice(i, 1);
  } else if (cardStyles.length >= MAX_STYLES) {
    hint.textContent = `3 styles maximum — décoche-en un avant d'en ajouter un autre.`;
    hint.classList.add("ko");
    setTimeout(() => {
      hint.textContent = "Sélectionne 1 à 3 styles.";
      hint.classList.remove("ko");
    }, 2200);
    return;
  } else {
    cardStyles.push(id);
  }
  renderStylePicker();
}

function renderStylePicker() {
  document.querySelectorAll(".pmw-style-opt").forEach(b =>
    b.classList.toggle("on", cardStyles.includes(b.dataset.style)));
  const hint = document.getElementById("pmw-style-hint");
  if (!hint) return;
  if (!hint.classList.contains("ko")) {
    hint.textContent = cardStyles.length
      ? `${cardStyles.length} / ${MAX_STYLES} sélectionné${cardStyles.length > 1 ? "s" : ""}`
      : "Sélectionne 1 à 3 styles.";
  }
}

async function openCardModal() {
  const modal = document.getElementById("pmw-card-modal");
  const err = document.getElementById("pmw-card-error");
  err.hidden = true;

  if (!window.PyrolosRiders || !window.PyrolosRiders.isSignedIn()) {
    if (window.PyrolosRating) window.PyrolosRating.openLogin();
    return;
  }

  // pré-remplir si une fiche existe déjà
  const mine = await window.PyrolosRiders.mine();
  document.getElementById("pmw-card-title").textContent = mine ? "Modifier ma fiche" : "Ma fiche";
  document.getElementById("pmw-card-save").textContent = mine ? "Mettre à jour" : "Publier ma fiche";
  document.getElementById("pmw-card-delete").hidden = !mine;

  if (mine) {
    // compatibilité : les fiches créées avant avaient un seul style
    cardStyles = mine.styles || (mine.style ? [mine.style] : ["normal"]);
    document.getElementById("pmw-card-massif").value = mine.massif || "";
    document.getElementById("pmw-card-moto").value = mine.moto || "";
    document.getElementById("pmw-card-dispo").value = mine.dispo || "";
    document.getElementById("pmw-card-desc").value = mine.desc || "";
    document.getElementById("pmw-card-insta").value = mine.instagram || "";
  } else {
    cardStyles = ["normal"];
  }
  renderStylePicker();

  modal.hidden = false;
}

async function saveCard() {
  const btn = document.getElementById("pmw-card-save");
  const err = document.getElementById("pmw-card-error");
  err.hidden = true;
  btn.disabled = true;

  try {
    await window.PyrolosRiders.save({
      styles: cardStyles,
      massif: document.getElementById("pmw-card-massif").value,
      moto:   document.getElementById("pmw-card-moto").value,
      dispo:  document.getElementById("pmw-card-dispo").value,
      desc:   document.getElementById("pmw-card-desc").value,
      instagram: document.getElementById("pmw-card-insta").value,
      cols: getRidden().size
    });
    document.getElementById("pmw-card-modal").hidden = true;
    await loadRiders();
  } catch (e) {
    console.error(e);
    err.hidden = false;
    err.textContent =
      e.code === "pyrolos/bad-insta"
        ? "Pseudo Instagram invalide (lettres, chiffres, point et underscore uniquement)."
      : e.code === "pyrolos/no-style"
        ? "Choisis au moins un style de conduite."
      : "Publication impossible. Réessaie.";
  } finally {
    btn.disabled = false;
  }
}

async function deleteCard() {
  await window.PyrolosRiders.remove();
  document.getElementById("pmw-card-modal").hidden = true;
  await loadRiders();
}

/** Suppression depuis la croix : deux clics, pour éviter l'accident. */
let delArmed = false, delTimer = null;
async function confirmDeleteCard(e) {
  const btn = e.currentTarget;

  if (!delArmed) {
    delArmed = true;
    btn.classList.add("armed");
    btn.textContent = "Confirmer ?";
    btn.title = "Cliquer à nouveau pour supprimer définitivement";
    delTimer = setTimeout(() => {
      delArmed = false;
      btn.classList.remove("armed");
      btn.textContent = "✕";
      btn.title = "Supprimer ma fiche";
    }, 4000);
    return;
  }

  clearTimeout(delTimer);
  delArmed = false;
  btn.textContent = "…";
  try {
    await window.PyrolosRiders.remove();
    await loadRiders();
  } catch (err) {
    console.error(err);
    btn.textContent = "✕";
  }
}

// rechargement à la connexion / déconnexion
window.pyrolosRefreshRiders = loadRiders;

/** Identifiants de tous les cols — sert au nettoyage des notes
    lors d'une suppression de compte. */
/** Identifiants des itinéraires — sert au nettoyage des notes
    lors d'une suppression de compte. */
window.pyrolosRouteIds = function () {
  return ROUTES.map(r => r.id).filter(Boolean);
};

window.pyrolosColIds = function () {
  return COLS.map(c => (window.PyrolosColId ? window.PyrolosColId(c) : null))
             .filter(Boolean);
};

/* =========================================================================
   MESSAGERIE
   ========================================================================= */

let MY_TRIPS = [];      // itinéraires personnels, pour le cumul des km
let CONVS = [];
let activeConv = null;
let unsubConvs = null, unsubMsgs = null;

function initMessages() {
  const send = document.getElementById("pmw-msg-send");
  if (!send) return;

  send.addEventListener("click", sendMessage);

  const input = document.getElementById("pmw-msg-input");
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  // la zone de saisie grandit avec le texte
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  document.getElementById("pmw-thread-back")
    .addEventListener("click", () => closeThread());
}

/** (Re)démarre l'écoute des conversations. Appelé à chaque connexion. */
function watchConversations() {
  if (unsubConvs) { unsubConvs(); unsubConvs = null; }
  closeThread();

  if (!window.PyrolosMessages || !window.PyrolosMessages.isSignedIn()) {
    CONVS = [];
    renderConvList();
    return;
  }
  unsubConvs = window.PyrolosMessages.listenConversations(list => {
    CONVS = list;
    renderConvList();
    updateUnreadDot();
    detecterComptesSupprimes();
  });
}

/* Comptes disparus AVANT l'ajout du marqueur `deleted` : on vérifie une
   seule fois leur existence dans `accounts`, et on garde le résultat en
   mémoire pour ne pas relire à chaque affichage. */
const comptesConnus = new Map();

async function compteExiste(uid) {
  if (comptesConnus.has(uid)) return comptesConnus.get(uid);
  let existe = true;
  try {
    existe = await window.PyrolosMessages.accountExists(uid);
  } catch { existe = true; }   // en cas de doute, on n'invente pas
  comptesConnus.set(uid, existe);
  return existe;
}

/** Repère les interlocuteurs dont le compte n'existe plus, puis réaffiche. */
async function detecterComptesSupprimes() {
  if (!window.PyrolosMessages || !window.PyrolosMessages.isSignedIn()) return;
  const me = window.PyrolosMessages.myUid();
  let changement = false;

  for (const c of CONVS) {
    const other = c.participants.find(u => u !== me);
    if (!other || (c.deleted && c.deleted[other])) continue;
    if (!(await compteExiste(other))) {
      c.deleted = { ...(c.deleted || {}), [other]: true };
      changement = true;
    }
  }
  if (changement) renderConvList();
}

function renderConvList() {
  const host = document.getElementById("pmw-conv-list");
  if (!host) return;

  if (!window.PyrolosMessages || !window.PyrolosMessages.isSignedIn()) {
    host.innerHTML = `<div class="pmw-empty">Connecte-toi pour accéder à tes messages.</div>`;
    return;
  }
  if (!CONVS.length) {
    host.innerHTML = `<div class="pmw-empty">Aucune conversation. Depuis « Rouler ensemble », clique sur ✉️ pour écrire à quelqu'un.</div>`;
    return;
  }

  const me = window.PyrolosMessages.myUid();
  host.innerHTML = CONVS.map(c => {
    const other = c.participants.find(u => u !== me);
    const supprime = !!(c.deleted && c.deleted[other]);
    const nom = supprime
      ? "Utilisateur introuvable"
      : ((c.pseudos && c.pseudos[other]) || "Motard");
    const nonLu = c.read && c.read[me] === false;
    return `
      <button class="pmw-conv ${activeConv === c.id ? "on" : ""} ${nonLu ? "unread" : ""} ${supprime ? "gone" : ""}"
              data-conv="${c.id}" data-nom="${escapeHtml(nom)}" data-gone="${supprime ? "1" : ""}">
        <span class="pmw-conv-name">${supprime ? "👤 " : ""}${escapeHtml(nom)}</span>
        <span class="pmw-conv-last">${escapeHtml(c.lastText || "Nouvelle conversation")}</span>
        ${nonLu ? '<span class="pmw-conv-dot"></span>' : ""}
      </button>`;
  }).join("");

  host.querySelectorAll("[data-conv]").forEach(b =>
    b.addEventListener("click", () =>
      openThread(b.dataset.conv, b.dataset.nom, b.dataset.gone === "1")));
}

function openThread(convId, nom, gone = false) {
  activeConv = convId;
  document.getElementById("pmw-thread-head").hidden = false;
  document.getElementById("pmw-thread-title").textContent = nom;

  // compte supprimé : on affiche l'historique mais on retire la saisie,
  // il n'y a plus personne pour lire
  const form = document.getElementById("pmw-thread-form");
  const avis = document.getElementById("pmw-thread-gone");
  form.hidden = gone;
  if (avis) avis.hidden = !gone;
  document.getElementById("pmw-msg").classList.add("thread-open");
  renderConvList();

  if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
  const body = document.getElementById("pmw-thread-body");
  body.innerHTML = `<div class="pmw-empty">Chargement…</div>`;

  unsubMsgs = window.PyrolosMessages.listenMessages(convId, msgs => {
    const me = window.PyrolosMessages.myUid();
    body.innerHTML = msgs.length
      ? msgs.map(m => `
          <div class="pmw-bubble ${m.from === me ? "mine" : ""}">
            <p>${escapeHtml(m.text)}</p>
            <time>${formatMsgDate(m.createdAt)}</time>
          </div>`).join("")
      : `<div class="pmw-empty">Aucun message. Lance la conversation !</div>`;
    body.scrollTop = body.scrollHeight;
  });

  window.PyrolosMessages.markRead(convId);
}

function closeThread() {
  activeConv = null;
  if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
  const head = document.getElementById("pmw-thread-head");
  if (!head) return;
  head.hidden = true;
  document.getElementById("pmw-thread-form").hidden = true;
  const avis = document.getElementById("pmw-thread-gone");
  if (avis) avis.hidden = true;
  document.getElementById("pmw-msg").classList.remove("thread-open");
  document.getElementById("pmw-thread-body").innerHTML =
    `<div class="pmw-empty">Sélectionne une conversation, ou écris à un motard depuis l'onglet « Rouler ensemble ».</div>`;
  renderConvList();
}

async function sendMessage() {
  const input = document.getElementById("pmw-msg-input");
  const text = input.value.trim();
  if (!text || !activeConv) return;

  input.value = "";
  input.style.height = "auto";
  try {
    await window.PyrolosMessages.send(activeConv, text);
  } catch (err) {
    console.error(err);
    input.value = text;   // on rend le texte à l'utilisateur

    // Un message qui disparaît sans explication est déroutant :
    // on affiche la raison dans le fil.
    const body = document.getElementById("pmw-thread-body");
    const msg = document.createElement("div");
    msg.className = "pmw-send-error";
    msg.textContent = err.code === "permission-denied"
      ? "Message non envoyé : les règles Firestore ne sont pas à jour."
      : "Message non envoyé. Vérifie ta connexion et réessaie.";
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
    setTimeout(() => msg.remove(), 6000);
  }
}

/** Ouvre (ou crée) une conversation avec un motard depuis sa fiche. */
async function messageRider(uid, pseudo) {
  if (!window.PyrolosMessages || !window.PyrolosMessages.isSignedIn()) {
    if (window.PyrolosRating) window.PyrolosRating.openLogin();
    return;
  }
  try {
    const id = await window.PyrolosMessages.open(uid, pseudo);
    document.querySelector('.pmw-tab[data-view="messages"]').click();
    setTimeout(() => openThread(id, pseudo), 120);
  } catch (err) {
    console.error("Ouverture de conversation impossible :", err);
  }
}

function updateUnreadDot() {
  const dot = document.getElementById("pmw-msg-dot");
  if (!dot || !window.PyrolosMessages) return;
  const me = window.PyrolosMessages.myUid();
  const n = CONVS.filter(c => c.read && c.read[me] === false).length;
  dot.hidden = n === 0;
  dot.textContent = n > 9 ? "9+" : String(n);
}

function formatMsgDate(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  const auj = new Date();
  const memeJour = d.toDateString() === auj.toDateString();
  return memeJour
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) + " " +
      d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

window.pyrolosRefreshMessages = watchConversations;

/**
 * Coupe les écoutes temps réel.
 * Appelé AVANT la déconnexion : sans cela, les listeners restent actifs
 * pendant que l'authentification disparaît, et Firestore refuse la
 * permission — d'où une erreur rouge en console, sans conséquence mais
 * trompeuse.
 */
window.pyrolosStopListeners = function () {
  if (unsubConvs) { unsubConvs(); unsubConvs = null; }
  if (unsubMsgs)  { unsubMsgs();  unsubMsgs = null; }
  CONVS = [];
  activeConv = null;
};

/* =========================================================================
   MÉTÉO
   Open-Meteo accepte plusieurs coordonnées dans une seule requête :
   tout l'onglet tient donc en un appel réseau, sans clé d'API.
   ========================================================================= */

let VILLES = [];
let meteoMode = "cols";
let meteoCache = {};        // { cols: [...], villes: [...] }

const METEO_TEXTE = {
  0:"Ciel dégagé", 1:"Peu nuageux", 2:"Partiellement nuageux", 3:"Couvert",
  45:"Brouillard", 48:"Brouillard givrant",
  51:"Bruine légère", 53:"Bruine", 55:"Bruine forte",
  56:"Bruine verglaçante", 57:"Bruine verglaçante",
  61:"Pluie faible", 63:"Pluie", 65:"Pluie forte",
  66:"Pluie verglaçante", 67:"Pluie verglaçante",
  71:"Neige faible", 73:"Neige", 75:"Neige forte", 77:"Grains de neige",
  80:"Averses", 81:"Averses", 82:"Fortes averses",
  85:"Averses de neige", 86:"Fortes averses de neige",
  95:"Orage", 96:"Orage et grêle", 99:"Orage et grêle"
};

/** Conditions défavorables à la moto : on le signale explicitement. */
function alerteMoto(code, vent, tmin) {
  if ([56,57,66,67].includes(code)) return { txt: "Verglas", niv: "danger" };
  if ([71,73,75,77,85,86].includes(code)) return { txt: "Neige", niv: "danger" };
  if ([95,96,99].includes(code)) return { txt: "Orage", niv: "danger" };
  if (vent >= 50) return { txt: "Vent fort", niv: "danger" };
  if (tmin !== null && tmin <= 2) return { txt: "Risque de gel", niv: "warn" };
  if ([63,65,81,82].includes(code)) return { txt: "Pluie", niv: "warn" };
  if (vent >= 35) return { txt: "Vent soutenu", niv: "warn" };
  return null;
}

async function loadVilles() {
  try {
    const res = await fetch("villes.json");
    if (!res.ok) throw new Error(res.status);
    VILLES = await res.json();
  } catch (err) {
    console.warn("villes.json introuvable :", err);
    VILLES = [];
  }
}

function initMeteo() {
  const grid = document.getElementById("pmw-meteo-grid");
  if (!grid) return;

  document.querySelectorAll("[data-meteo]").forEach(b =>
    b.addEventListener("click", () => {
      meteoMode = b.dataset.meteo;
      document.querySelectorAll("[data-meteo]").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      renderMeteo();
    }));

  document.getElementById("pmw-meteo-refresh")
    .addEventListener("click", () => { meteoCache = {}; renderMeteo(); });
}

/** Récupère la météo de plusieurs points en une seule requête. */
async function fetchMeteo(points) {
  const lats = points.map(p => p.lat.toFixed(4)).join(",");
  const lons = points.map(p => p.lon.toFixed(4)).join(",");
  const url = "https://api.open-meteo.com/v1/forecast"
    + `?latitude=${lats}&longitude=${lons}`
    + "&current=temperature_2m,weather_code,wind_speed_10m,apparent_temperature"
    + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
    + "&forecast_days=3&timezone=Europe%2FParis";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo " + res.status);
  const data = await res.json();

  // avec un seul point, l'API renvoie un objet ; avec plusieurs, un tableau
  const liste = Array.isArray(data) ? data : [data];
  return points.map((p, i) => ({ ...p, meteo: liste[i] }));
}

async function renderMeteo() {
  const grid = document.getElementById("pmw-meteo-grid");
  const note = document.getElementById("pmw-meteo-note");
  if (!grid) return;

  const points = meteoMode === "cols" ? COLS : VILLES;
  if (!points.length) {
    grid.innerHTML = `<div class="pmw-empty">Aucun lieu à afficher.</div>`;
    return;
  }

  if (meteoCache[meteoMode]) {
    afficherMeteo(meteoCache[meteoMode]);
    return;
  }

  grid.innerHTML = `<div class="pmw-empty">Chargement de la météo…</div>`;
  note.textContent = "";

  try {
    const resultats = await fetchMeteo(points);
    meteoCache[meteoMode] = resultats;
    afficherMeteo(resultats);
  } catch (err) {
    console.error(err);
    grid.innerHTML = `<div class="pmw-empty">
      Météo indisponible pour le moment. Le service est peut-être saturé,
      réessaie dans un instant.
    </div>`;
  }
}

function afficherMeteo(resultats) {
  const grid = document.getElementById("pmw-meteo-grid");
  const note = document.getElementById("pmw-meteo-note");

  grid.innerHTML = resultats.map(p => {
    const m = p.meteo;
    if (!m || !m.current) {
      return `<div class="pmw-meteo-card"><h3>${escapeHtml(p.nom)}</h3>
              <div class="pmw-meteo-ko">Données indisponibles</div></div>`;
    }

    const c = m.current;
    const d = m.daily || {};
    const code = c.weather_code;
    const vent = Math.round(c.wind_speed_10m);
    const tmin = d.temperature_2m_min ? Math.round(d.temperature_2m_min[0]) : null;
    const alerte = alerteMoto(code, vent, tmin);

    const jours = (d.time || []).slice(0, 3).map((iso, i) => {
      const dt = new Date(iso);
      const nom = i === 0 ? "Auj." :
        dt.toLocaleDateString("fr-FR", { weekday: "short" }).replace(".", "");
      return `
        <div class="pmw-meteo-day">
          <span class="d">${nom}</span>
          <span class="i">${WEATHER_ICONS[d.weather_code[i]] || "🌡️"}</span>
          <span class="t">${Math.round(d.temperature_2m_max[i])}° <em>${Math.round(d.temperature_2m_min[i])}°</em></span>
          ${d.precipitation_sum[i] > 0.2
            ? `<span class="p">${d.precipitation_sum[i].toFixed(1)} mm</span>`
            : `<span class="p">–</span>`}
        </div>`;
    }).join("");

    return `
      <div class="pmw-meteo-card clickable ${alerte ? "has-" + alerte.niv : ""}"
           data-hour="${escapeHtml(p.nom)}" data-lat="${p.lat}" data-lon="${p.lon}"
           data-alt="${p.alt}" role="button" tabindex="0"
           title="Voir le détail heure par heure">
        <div class="pmw-meteo-head">
          <div>
            <h3>${escapeHtml(p.nom)}</h3>
            <span class="pmw-meteo-alt">${p.alt} m${p.massif ? " · " + escapeHtml(p.massif) : ""}</span>
          </div>
          ${alerte ? `<span class="pmw-meteo-alert ${alerte.niv}">${alerte.txt}</span>` : ""}
        </div>

        <div class="pmw-meteo-now">
          <span class="pmw-meteo-icon">${WEATHER_ICONS[code] || "🌡️"}</span>
          <div>
            <b>${Math.round(c.temperature_2m)}°C</b>
            <span>${METEO_TEXTE[code] || "—"}</span>
          </div>
          <div class="pmw-meteo-side">
            <span>💨 ${vent} km/h</span>
            <span>ressenti ${Math.round(c.apparent_temperature)}°</span>
          </div>
        </div>

        <div class="pmw-meteo-days">${jours}</div>
      </div>`;
  }).join("");

  grid.querySelectorAll("[data-hour]").forEach(el => {
    const ouvrir = () => openHourly(el.dataset.hour, +el.dataset.lat, +el.dataset.lon, el.dataset.alt);
    el.addEventListener("click", ouvrir);
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ouvrir(); }
    });
  });

  const maj = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  note.textContent = `Relevé de ${maj} · données Open-Meteo · `
    + `la météo d'un col peut changer très vite, vérifie avant de partir.`;
}

/* ---------- Météo heure par heure ---------- */

const hourCache = new Map();     // clé "lat,lon" -> données horaires

async function openHourly(nom, lat, lon, alt) {
  const modal = document.getElementById("pmw-hour-modal");
  const body = document.getElementById("pmw-hour-body");
  document.getElementById("pmw-hour-title").textContent = nom;
  document.getElementById("pmw-hour-sub").textContent =
    `${alt} m · prévision des 24 prochaines heures`;
  body.innerHTML = `<div class="pmw-empty">Chargement…</div>`;
  modal.hidden = false;

  const cle = `${lat},${lon}`;
  try {
    let data = hourCache.get(cle);
    if (!data) {
      // requête ciblée sur ce seul point : bien plus léger que de charger
      // l'horaire de tous les lieux dès l'ouverture de l'onglet
      const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${lat}&longitude=${lon}`
        + "&hourly=temperature_2m,weather_code,precipitation,wind_speed_10m,apparent_temperature"
        + "&forecast_days=2&timezone=Europe%2FParis";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Open-Meteo " + res.status);
      data = await res.json();
      hourCache.set(cle, data);
    }
    afficherHoraire(data);
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="pmw-empty">Prévision horaire indisponible pour le moment.</div>`;
  }
}

function afficherHoraire(data) {
  const body = document.getElementById("pmw-hour-body");
  const h = data.hourly;
  if (!h || !h.time) {
    body.innerHTML = `<div class="pmw-empty">Aucune donnée horaire.</div>`;
    return;
  }

  // on démarre à l'heure courante, et on affiche 24 heures
  const maintenant = Date.now();
  let debut = h.time.findIndex(t => new Date(t).getTime() >= maintenant - 3600000);
  if (debut < 0) debut = 0;
  const fin = Math.min(debut + 24, h.time.length);

  const temps = h.temperature_2m.slice(debut, fin);
  const tmin = Math.min(...temps), tmax = Math.max(...temps);
  const ecart = Math.max(1, tmax - tmin);

  let lignes = "";
  for (let i = debut; i < fin; i++) {
    const dt = new Date(h.time[i]);
    const heure = dt.getHours();
    const t = h.temperature_2m[i];
    const code = h.weather_code[i];
    const pluie = h.precipitation[i];
    const vent = Math.round(h.wind_speed_10m[i]);
    const nuit = heure < 7 || heure > 20;

    // barre proportionnelle à la température, pour lire la courbe d'un coup d'œil
    const largeur = 12 + ((t - tmin) / ecart) * 76;
    const alerte = alerteMoto(code, vent, t);

    lignes += `
      <div class="pmw-hour-row ${nuit ? "nuit" : ""} ${i === debut ? "now" : ""}">
        <span class="hh">${i === debut ? "now" : String(heure).padStart(2, "0") + "h"}</span>
        <span class="ic">${WEATHER_ICONS[code] || "🌡️"}</span>
        <span class="bar"><i style="width:${largeur}%"></i></span>
        <span class="tt">${Math.round(t)}°</span>
        <span class="ww">${vent}</span>
        <span class="pp">${pluie > 0.05 ? pluie.toFixed(1) : "–"}</span>
        <span class="al">${alerte ? `<em class="${alerte.niv}">${alerte.txt}</em>` : ""}</span>
      </div>`;
  }

  body.innerHTML = `
    <div class="pmw-hour-head">
      <span class="hh"></span><span class="ic"></span><span class="bar">Température</span>
      <span class="tt">°C</span><span class="ww">km/h</span><span class="pp">mm</span><span class="al"></span>
    </div>
    <div class="pmw-hour-list">${lignes}</div>
    <p class="pmw-hour-note">
      Les valeurs en altitude sont modélisées : en montagne, l'écart avec la
      réalité au sommet peut être notable.
    </p>`;
}

function initHourly() {
  const modal = document.getElementById("pmw-hour-modal");
  if (!modal) return;
  modal.addEventListener("click", e => {
    if (e.target.hasAttribute("data-hour-close")) modal.hidden = true;
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

/* ---------- Onglets ---------- */

function initTabs() {
  const tabs = document.querySelectorAll(".pmw-tab");
  const views = {
    carte: document.getElementById("view-carte"),
    itineraires: document.getElementById("view-itineraires"),
    riders: document.getElementById("view-riders"),
    messages: document.getElementById("view-messages"),
    meteo: document.getElementById("view-meteo"),
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
      if (tab.dataset.view === "meteo") renderMeteo();
      if (tab.dataset.view === "classement") {
        const actif = document.querySelector(".pmw-subtab.active");
        if (actif && actif.dataset.rank === "routes") renderRouteRanking();
        else renderRanking();
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
