// =============================================================
//  Pyrolos — interface d'authentification et de notation
//  Fait le lien entre pyrolos-firebase.js et le DOM.
// =============================================================

import { Auth, Ratings, Ridden, colId, authErrorMessage, validatePseudo } from "./pyrolos-firebase.js";

const $ = id => document.getElementById(id);

/* =============================================================
   MESSAGE "MOT DE PASSE OUBLIÉ"
   Aucune récupération n'est possible (aucun e-mail n'est collecté).
   Modifie librement le texte ci-dessous — c'est le seul endroit à
   toucher si tu veux un ton plus doux ou plus salé.
   ============================================================= */
const LOST_PASSWORD = {
  titre: "T'es un énorme troller !!",
  texte: "Je t'avais dit d'enregistrer ton mot de passe quelque part. " +
         "Maintenant ton compte est perdu. Tocard.<br><br>" +
         "Plus qu'à recréer un compte avec un autre pseudo… et à le noter, cette fois."
};

/* ---------------- Barre de compte ---------------- */

const stateEl  = $("pmw-account-state");
const loginBtn = $("pmw-login-btn");
const logoutBtn= $("pmw-logout-btn");

Auth.onChange(async user => {
  if (user) {
    stateEl.textContent = user.displayName || user.email;
    stateEl.classList.add("connected");
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
  } else {
    stateEl.textContent = "Non connecté";
    stateEl.classList.remove("connected");
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
  }
  Ratings.clearCache();

  // recharger les cols roulés depuis le compte (ou le stockage local)
  Ridden.reset();
  await Ridden.load();

  const scope = $("pmw-ridden-scope");
  if (scope) {
    scope.textContent = user
      ? "Progression enregistrée sur ton compte : tu la retrouveras sur n'importe quel appareil."
      : "Sauvegardé sur cet appareil uniquement — connecte-toi pour retrouver ta progression partout.";
    scope.classList.toggle("synced", !!user);
  }
  if (window.pyrolosRefreshRidden) window.pyrolosRefreshRidden();

  // rafraîchir le widget de notation si une fiche est ouverte
  const open = document.querySelector("[data-rating-col]");
  if (open) mountRating(open, JSON.parse(open.dataset.ratingCol));
});

loginBtn.addEventListener("click", () => openModal("login"));
logoutBtn.addEventListener("click", () => Auth.logout());

/* ---------------- Modale ---------------- */

const modal    = $("pmw-modal");
const titleEl  = $("pmw-modal-title");
const subEl    = $("pmw-modal-sub");
const errorEl  = $("pmw-modal-error");
const passEl   = $("pmw-password");
const pseudoEl = $("pmw-pseudo");
const hintEl   = $("pmw-pseudo-hint");
const warnEl   = $("pmw-warn");
const submitBtn= $("pmw-submit");
const toggleBtn= $("pmw-toggle-mode");
const forgotBtn= $("pmw-forgot");
const lostModal= $("pmw-lost");

let mode = "login";

function openModal(m) {
  mode = m;
  applyMode();
  showError(null);
  modal.hidden = false;
  setTimeout(() => pseudoEl.focus(), 40);
}

function closeModal() {
  modal.hidden = true;
  passEl.value = "";
}

function applyMode() {
  const signup = mode === "signup";
  titleEl.textContent = signup ? "Créer un compte" : "Connexion";
  subEl.textContent   = signup
    ? "Choisis un pseudo unique. Aucune adresse e-mail n'est demandée."
    : "Connecte-toi avec ton pseudo pour noter les cols.";
  submitBtn.textContent = signup ? "Créer mon compte" : "Se connecter";
  toggleBtn.textContent = signup
    ? "Déjà un compte ? Se connecter"
    : "Pas encore de compte ? S'inscrire";
  hintEl.hidden = !signup;
  warnEl.hidden = !signup;
  forgotBtn.hidden = signup;
  passEl.autocomplete = signup ? "new-password" : "current-password";
}

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

modal.addEventListener("click", e => {
  if (e.target.hasAttribute("data-close")) closeModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

toggleBtn.addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";
  applyMode();
  showError(null);
});

submitBtn.addEventListener("click", async () => {
  const pseudo = pseudoEl.value.trim();
  const pass   = passEl.value;
  if (!pseudo || !pass) return showError("Remplis le pseudo et le mot de passe.");

  if (mode === "signup") {
    const problem = validatePseudo(pseudo);
    if (problem) return showError(problem);
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "…";
  try {
    if (mode === "signup") {
      await Auth.register(pseudo, pass);
    } else {
      await Auth.login(pseudo, pass);
    }
    closeModal();
  } catch (err) {
    showError(authErrorMessage(err));
  } finally {
    submitBtn.disabled = false;
    applyMode();
  }
});

[passEl, pseudoEl].forEach(el =>
  el.addEventListener("keydown", e => { if (e.key === "Enter") submitBtn.click(); })
);

/* ---------------- Popup "mot de passe oublié" ---------------- */

forgotBtn.addEventListener("click", () => {
  $("pmw-lost-title").textContent = LOST_PASSWORD.titre;
  $("pmw-lost-text").innerHTML   = LOST_PASSWORD.texte;
  lostModal.hidden = false;
});

lostModal.addEventListener("click", e => {
  if (e.target.hasAttribute("data-lost-close")) lostModal.hidden = true;
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !lostModal.hidden) lostModal.hidden = true;
});

/* ---------------- Widget de notation ---------------- */

/**
 * Construit le bloc d'étoiles dans un conteneur donné.
 * @param {HTMLElement} host conteneur
 * @param {object} col objet col issu de cols.json
 */
export async function mountRating(host, col) {
  const id = colId(col);
  host.dataset.ratingCol = JSON.stringify(col);
  host.innerHTML = `<div class="pmw-rating-loading">Chargement des notes…</div>`;

  let data;
  try {
    data = await Ratings.get(id);
  } catch (err) {
    console.error(err);
    host.innerHTML = `<div class="pmw-rating-loading">Notes indisponibles.</div>`;
    return;
  }

  const avgTxt = data.avg ? data.avg.toFixed(1) : "–";
  const votes  = data.count === 0 ? "aucun vote"
               : data.count === 1 ? "1 vote"
               : `${data.count} votes`;

  const stars = [1,2,3,4,5].map(n => `
    <button class="pmw-star ${data.mine >= n ? 'on' : ''}"
            data-star="${n}" aria-label="Noter ${n} sur 5"
            ${Auth.current ? '' : 'disabled'}>★</button>`).join("");

  host.innerHTML = `
    <div class="pmw-rating">
      <div class="pmw-rating-avg">
        <b>${avgTxt}</b><span>/5</span>
        <em>${votes}</em>
      </div>
      <div class="pmw-rating-stars">${stars}</div>
      <div class="pmw-rating-msg">
        ${Auth.current
          ? (data.mine ? `Ta note : ${data.mine}/5` : "Clique une étoile pour noter")
          : `<button class="pmw-link" data-need-login>Connecte-toi pour noter</button>`}
      </div>
      ${data.mine ? `<button class="pmw-link pmw-rating-remove">Retirer ma note</button>` : ""}
    </div>`;

  host.querySelectorAll("[data-star]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const value = Number(btn.dataset.star);
      host.querySelector(".pmw-rating-msg").textContent = "Enregistrement…";
      try {
        await Ratings.set(id, value);
        await mountRating(host, col);
      } catch (err) {
        console.error(err);
        host.querySelector(".pmw-rating-msg").textContent =
          err.message === "not-signed-in"
            ? "Connecte-toi pour noter."
            : "Impossible d'enregistrer la note.";
      }
    });
  });

  const removeBtn = host.querySelector(".pmw-rating-remove");
  if (removeBtn) removeBtn.addEventListener("click", async () => {
    await Ratings.remove(id);
    await mountRating(host, col);
  });

  const needLogin = host.querySelector("[data-need-login]");
  if (needLogin) needLogin.addEventListener("click", () => openModal("login"));
}

// exposés pour script.js, qui n'est pas un module
window.PyrolosRating = { mount: mountRating, openLogin: () => openModal("login") };
window.PyrolosRidden = Ridden;

// premier chargement (utilisateur non connecté : stockage local)
Ridden.load().then(() => {
  if (window.pyrolosRefreshRidden) window.pyrolosRefreshRidden();
});
