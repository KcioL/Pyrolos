/* =========================================================================
   Les cols des Pyrénées à moto — script.js
   Charge les données depuis cols.json (fetch), puis construit :
   - la carte Leaflet avec un marqueur par col
   - la liste de fiches filtrable
   - le panneau de détail au clic
   Pour ajouter / modifier un col : éditer uniquement cols.json.
   ========================================================================= */

const STATE_COLOR = { bon: "#5fa777", vigilance: "#c98a2c" };

let COLS = [];
let map = null;
let markers = {};
let currentMassif = "tous";
let currentQuery = "";
let selectedIndex = null;

const listEl = document.getElementById("pmw-list");
const detailEl = document.getElementById("pmw-detail");
const countEl = document.getElementById("pmw-count");
const highestEl = document.getElementById("pmw-highest");
const massifsCountEl = document.getElementById("pmw-massifs-count");
const chipsEl = document.getElementById("pmw-chips");
const searchEl = document.getElementById("pmw-search");

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
}

function buildStats() {
  const massifs = [...new Set(COLS.map(c => c.massif))];
  const highest = Math.max(...COLS.map(c => c.alt));
  countEl.textContent = COLS.length;
  highestEl.textContent = highest + " m";
  massifsCountEl.textContent = massifs.length;
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
      radius: 8,
      weight: 2,
      color: "#14161a",
      fillColor: STATE_COLOR[c.etat] || STATE_COLOR.bon,
      fillOpacity: 1
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
    if (markers[i]) {
      markers[i].setStyle({ opacity: visible ? 1 : 0.15, fillOpacity: visible ? 1 : 0.1 });
    }
    if (!visible) return;
    shown++;

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
          <h3>${c.nom}</h3>
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

  detailEl.classList.add("open");
  detailEl.innerHTML = `
    <div class="pmw-detail-head">
      <div>
        <h2>${c.nom}</h2>
        <div class="pmw-detail-sub">${c.massif} · ${c.alt} m d'altitude</div>
      </div>
      <button class="pmw-close" id="pmw-close">Fermer</button>
    </div>
    <div class="pmw-detail-grid">
      <div class="pmw-metric"><b>${c.alt} m</b><span>Altitude sommet</span></div>
      <div class="pmw-metric"><b>${c.etat === "bon" ? "Bon" : "Vigilance"}</b><span>État revêtement</span></div>
      <div class="pmw-metric"><b>${c.massif.split(" / ")[0]}</b><span>Massif</span></div>
    </div>
    <div class="pmw-detail-text">
      <p>${c.desc}</p>
      <p><strong>Virages :</strong> ${c.virages}</p>
      <p><strong>Revêtement :</strong> ${c.revetement}</p>
    </div>
    <div class="pmw-note">⚠️ ${c.conseil} — vérifie toujours l'état de la route et la météo avant de partir.</div>
  `;

  document.getElementById("pmw-close").addEventListener("click", () => {
    detailEl.classList.remove("open");
    selectedIndex = null;
    render();
  });

  render();
  detailEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

searchEl.addEventListener("input", e => {
  currentQuery = e.target.value;
  render();
});
