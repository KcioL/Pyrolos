/* =========================================================================
   Pyrolos — script.js
   Charge cols.json puis construit : carte, filtres, classement, succès,
   météo en direct (Open-Meteo, sans clé), suivi "cols roulés" (localStorage).
   Pour ajouter / modifier un col : éditer uniquement cols.json.
   ========================================================================= */

const STATE_COLOR = { bon: "#7fa96f", vigilance: "#c98a3c" };
const RIDDEN_KEY = "pyrolos_cols_roules";

const BADGES = [
  { id: "premier",   icon: "🏁", nom: "Premier virage",        desc: "Coche ton premier col roulé.",              test: (r, cols) => r.size >= 1 },
  { id: "cinq",       icon: "🛣️", nom: "Chasseur de cols",      desc: "5 cols roulés ou plus.",                    test: (r, cols) => r.size >= 5 },
  { id: "sommet",     icon: "⛰️", nom: "Grand sommet",          desc: "Un col roulé au-dessus de 2000 m.",         test: (r, cols) => cols.some(c => r.has(c.nom) && c.alt >= 2000) },
  { id: "massifs",    icon: "🗺️", nom: "Multi-massifs",         desc: "Des cols roulés dans 3 massifs différents.", test: (r, cols) => new Set(cols.filter(c => r.has(c.nom)).map(c => c.massif)).size >= 3 },
  { id: "complet",    icon: "🏆", nom: "Collection complète",   desc: "Tous les cols de la liste, roulés.",        test: (r, cols) => cols.every(c => r.has(c.nom)) }
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

  buildStats();
  buildMassifChips();
  buildMap();
  render();
  renderRanking();
  renderBadges();
  initTabs();
  initSort();
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

  badgesEl.innerHTML = BADGES.map(b => {
    const unlocked = b.test(ridden, COLS);
    return `
      <div class="pmw-badge ${unlocked ? "unlocked" : ""}">
        <div class="pmw-badge-icon">${b.icon}</div>
        <div class="pmw-badge-text"><b>${b.nom}</b><span>${b.desc}</span></div>
      </div>
    `;
  }).join("");

  progressTextEl.textContent = `${ridden.size} / ${COLS.length} cols roulés`;
  progressFillEl.style.width = `${COLS.length ? (ridden.size / COLS.length) * 100 : 0}%`;
}

/* ---------- Onglets ---------- */

function initTabs() {
  const tabs = document.querySelectorAll(".pmw-tab");
  const views = {
    carte: document.getElementById("view-carte"),
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
    });
  });
}

searchEl.addEventListener("input", e => {
  currentQuery = e.target.value;
  render();
});
