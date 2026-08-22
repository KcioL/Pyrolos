// =============================================================
//  Pyrolos — interface d'authentification et de notation
//  Fait le lien entre pyrolos-firebase.js et le DOM.
// =============================================================

import { Auth, Ratings, Ridden, Trips, Riders, Messages, Stats, Account, RouteRatings, RoutesFaites, colId, authErrorMessage, validatePseudo, displayNameOf } from "./pyrolos-firebase.js";

const $ = id => document.getElementById(id);

/* =============================================================
   MESSAGE "MOT DE PASSE OUBLIÉ"
   Aucune récupération n'est possible (aucun e-mail n'est collecté).
   Modifie librement le texte ci-dessous — c'est le seul endroit à
   toucher si tu veux un ton plus doux ou plus salé.
   ============================================================= */
const LOST_PASSWORD = {
  titre: "T'es un énorme clown !!",

  // aucune adresse saisie dans le champ identifiant
  texteSansMail:
    "Saisis d'abord ton adresse e-mail dans le champ « Identifiant », " +
    "puis reclique ici : Firebase t'enverra un lien pour choisir un " +
    "nouveau mot de passe.",

  // le pseudo correspond à un compte doté d'une adresse
  texteAvecMail:
    "Ton compte est bien rattaché à une adresse e-mail. Saisis-la dans le " +
    "champ « Identifiant » à la place de ton pseudo, puis reclique sur " +
    "« Mot de passe oublié » : tu recevras un lien pour en choisir un nouveau.",

  // compte créé sans adresse : rien à faire
  texteLegacy:
    "Ton compte a été créé sans adresse e-mail, donc aucun lien de " +
    "réinitialisation ne peut t'être envoyé. Je t'avais dit de noter " +
    "ton mot de passe quelque part. Tocard.<br><br>" +
    "Plus qu'à recréer un compte — avec une adresse e-mail cette fois, " +
    "pour ne plus jamais te retrouver ici."
};

/* ---------------- Barre de compte ---------------- */

const stateEl  = $("pmw-account-state");
const loginBtn = $("pmw-login-btn");
const logoutBtn= $("pmw-logout-btn");
const delAccountBtn = $("pmw-delete-account-btn");

Auth.onChange(async user => {
  if (user) {
    stateEl.textContent = displayNameOf(user);
    stateEl.classList.add("connected");
    loginBtn.hidden = true;
    logoutBtn.hidden = false;
    delAccountBtn.hidden = false;
  } else {
    stateEl.textContent = "Non connecté";
    stateEl.classList.remove("connected");
    loginBtn.hidden = false;
    logoutBtn.hidden = true;
    delAccountBtn.hidden = true;
  }
  Ratings.clearCache();

  // recharger les cols roulés depuis le compte (ou le stockage local)
  Ridden.reset();
  await Ridden.load();
  RoutesFaites.reset();
  await RoutesFaites.load();
  RouteRatings.clearCache();
  if (window.pyrolosRefreshRoutes) window.pyrolosRefreshRoutes();

  const scope = $("pmw-ridden-scope");
  if (scope) {
    scope.textContent = user
      ? "Progression enregistrée sur ton compte : tu la retrouveras sur n'importe quel appareil."
      : "Sauvegardé sur cet appareil uniquement — connecte-toi pour retrouver ta progression partout.";
    scope.classList.toggle("synced", !!user);
  }
  if (window.pyrolosRefreshRidden) window.pyrolosRefreshRidden();

  // recharger les itinéraires personnels
  if (window.pyrolosRefreshTrips) await window.pyrolosRefreshTrips();
  if (window.pyrolosRefreshRiders) await window.pyrolosRefreshRiders();
  if (window.pyrolosRefreshMessages) window.pyrolosRefreshMessages();

  // présence : on signale son arrivée, ou on cesse de battre
  if (user) {
    await Stats.ensureAccount();      // rattrape les comptes anciens
    await Stats.startHeartbeat();     // attend le premier signal
  } else {
    Stats.stopHeartbeat();
  }
  refreshStats();

  // rafraîchir le widget de notation si une fiche est ouverte
  const open = document.querySelector("[data-rating-col]");
  if (open) mountRating(open, JSON.parse(open.dataset.ratingCol));
});

loginBtn.addEventListener("click", () => openModal("login"));
logoutBtn.addEventListener("click", async () => {
  // on coupe d'abord les écoutes Firestore, sinon elles survivent une
  // fraction de seconde à la déconnexion et déclenchent une erreur de
  // permission (sans gravité, mais polluante en console)
  if (window.pyrolosStopListeners) window.pyrolosStopListeners();
  Stats.stopHeartbeat();
  await Stats.clearPresence();     // avant la déconnexion, tant qu'on a le droit d'écrire
  await Auth.logout();
});

/* ---------------- Modale ---------------- */

const modal    = $("pmw-modal");
const titleEl  = $("pmw-modal-title");
const subEl    = $("pmw-modal-sub");
const errorEl  = $("pmw-modal-error");
const passEl   = $("pmw-password");
const confirmEl= $("pmw-confirm");
const confirmField = $("pmw-confirm-field");
const matchEl  = $("pmw-match");
const revealEl = $("pmw-reveal");
const pseudoEl = $("pmw-pseudo");
const hintEl   = $("pmw-pseudo-hint");
const emailEl  = $("pmw-email");
const emailField = $("pmw-email-field");
const pseudoTxt = $("pmw-pseudo-txt");
const pseudoTag = $("pmw-pseudo-tag");
const submitBtn= $("pmw-submit");
const toggleBtn= $("pmw-toggle-mode");
const forgotBtn= $("pmw-forgot");
const lostModal= $("pmw-lost");

if (!confirmField) {
  console.warn(
    "[Pyrolos] Le champ de confirmation du mot de passe est absent de index.html. " +
    "La connexion fonctionne, mais pense à reprendre la dernière version " +
    "d'index.html et de style.css."
  );
}

let mode = "login";
let revealed = false;

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
  if (confirmEl) confirmEl.value = "";
  if (matchEl)   matchEl.hidden = true;
  setRevealed(false);
}

/* Basculer l'affichage en clair des deux champs de mot de passe.
   Utile à l'inscription : permet de relire ce qu'on a tapé plutôt
   que de deviner sous les points. */
function setRevealed(on) {
  revealed = on;
  const type = on ? "text" : "password";
  if (passEl)    passEl.type = type;
  if (confirmEl) confirmEl.type = type;
  if (revealEl)  revealEl.textContent = on ? "Masquer le mot de passe"
                                           : "Afficher le mot de passe";
}

/* Retour visuel en direct sur la concordance des deux saisies. */
function checkMatch() {
  if (!confirmEl || !matchEl) return;
  if (mode !== "signup" || !confirmEl.value) {
    matchEl.hidden = true;
    return;
  }
  const same = passEl.value === confirmEl.value;
  matchEl.hidden = false;
  matchEl.textContent = same
    ? "✓ Les mots de passe correspondent"
    : "✗ Les mots de passe sont différents";
  matchEl.classList.toggle("ok", same);
  matchEl.classList.toggle("ko", !same);
}

function applyMode() {
  const signup = mode === "signup";
  titleEl.textContent = signup ? "Créer un compte" : "Connexion";
  subEl.textContent   = signup
    ? "Ton pseudo sera visible de tous ; ton e-mail restera privé."
    : "Connecte-toi pour noter les cols et échanger.";
  submitBtn.textContent = signup ? "Créer mon compte" : "Se connecter";
  toggleBtn.textContent = signup
    ? "Déjà un compte ? Se connecter"
    : "Pas encore de compte ? S'inscrire";
  // Éléments optionnels : le module doit rester fonctionnel même si
  // l'index.html n'a pas encore été mis à jour (sinon une seule balise
  // manquante ferait planter toute l'ouverture de la fenêtre).
  if (hintEl)      hintEl.hidden      = !signup;
  if (emailField)  emailField.hidden  = !signup;
  if (pseudoTag)   pseudoTag.hidden   = !signup;
  if (pseudoTxt)   pseudoTxt.textContent = signup ? "Pseudo affiché" : "Identifiant";
  pseudoEl.placeholder = signup ? "loick" : "Ton e-mail";
  if (forgotBtn)   forgotBtn.hidden   = signup;
  if (confirmField) confirmField.hidden = !signup;
  if (revealEl)    revealEl.hidden    = !signup;
  if (confirmEl)   confirmEl.value    = "";
  if (matchEl)     matchEl.hidden     = true;
  setRevealed(false);
  passEl.autocomplete = signup ? "new-password" : "current-password";
}

/** L'avertissement ne s'affiche qu'à l'inscription, et seulement tant
    qu'aucune adresse n'est saisie. */
function majWarnMail() {
  if (!warnEl) return;
  const signup = mode === "signup";
  warnEl.hidden = !signup || (emailEl && emailEl.value.trim().length > 0);
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

    const mail = (emailEl ? emailEl.value : "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return showError("Saisis une adresse e-mail valide : elle te permettra de récupérer ton mot de passe.");
    }

    if (pass.length < 6) {
      return showError("Le mot de passe doit faire au moins 6 caractères.");
    }
    if (confirmEl && pass !== confirmEl.value) {
      return showError(
        "Les deux mots de passe ne correspondent pas. " +
        "Vérifie bien : sans e-mail, une faute de frappe rend le compte irrécupérable."
      );
    }
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "…";
  try {
    if (mode === "signup") {
      const u = await Auth.register(pseudo, emailEl.value, pass);
      stateEl.textContent = displayNameOf(u);
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

if (revealEl)  revealEl.addEventListener("click", () => setRevealed(!revealed));
if (confirmEl) confirmEl.addEventListener("input", checkMatch);
passEl.addEventListener("input", checkMatch);
if (emailEl) emailEl.addEventListener("input", majWarnMail);

[passEl, pseudoEl, confirmEl].filter(Boolean).forEach(el =>
  el.addEventListener("keydown", e => { if (e.key === "Enter") submitBtn.click(); })
);

/* ---------------- Popup "mot de passe oublié" ---------------- */

forgotBtn.addEventListener("click", async () => {
  const saisi = pseudoEl.value.trim();

  if (!saisi.includes("@")) {
    // Un pseudo a été saisi : le compte correspondant a-t-il un e-mail ?
    // Si oui, la récupération est possible, il suffit de saisir l'adresse
    // — inutile de lui annoncer que son compte est perdu.
    let rattache = false;
    if (saisi) {
      try { rattache = await Auth.pseudoHasEmail(saisi); } catch {}
    }
    $("pmw-lost-title").textContent = rattache
      ? "Presque !" : LOST_PASSWORD.titre;
    $("pmw-lost-text").innerHTML =
      rattache ? LOST_PASSWORD.texteAvecMail
      : saisi  ? LOST_PASSWORD.texteLegacy
               : LOST_PASSWORD.texteSansMail;
    lostModal.hidden = false;
    return;
  }

  forgotBtn.disabled = true;
  forgotBtn.textContent = "Envoi…";
  try {
    await Auth.resetPassword(saisi);
    showError(null);
    subEl.textContent = "Si un compte existe avec cette adresse, un lien de "
                      + "réinitialisation vient d'être envoyé. Pense à vérifier tes spams.";
  } catch (err) {
    if (err.code === "pyrolos/legacy-account") {
      $("pmw-lost-title").textContent = LOST_PASSWORD.titre;
      $("pmw-lost-text").innerHTML   = LOST_PASSWORD.texteLegacy;
      lostModal.hidden = false;
    } else {
      console.error(err);
      showError(authErrorMessage(err));
    }
  } finally {
    forgotBtn.disabled = false;
    forgotBtn.textContent = "Mot de passe oublié ?";
  }
});

lostModal.addEventListener("click", e => {
  if (e.target.hasAttribute("data-lost-close")) lostModal.hidden = true;
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !lostModal.hidden) lostModal.hidden = true;
});

/* ---------------- Suppression de compte ---------------- */

const delModal   = $("pmw-del-modal");
const delPass    = $("pmw-del-pass");
const delWord    = $("pmw-del-word");
const delConfirm = $("pmw-del-confirm");
const delError   = $("pmw-del-error");

delAccountBtn.addEventListener("click", () => {
  delPass.value = ""; delWord.value = "";
  delError.hidden = true;
  delConfirm.disabled = true;
  delConfirm.textContent = "Supprimer définitivement";
  delModal.hidden = false;
  setTimeout(() => delPass.focus(), 40);
});

delModal.addEventListener("click", e => {
  if (e.target.hasAttribute("data-del-close")) delModal.hidden = true;
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !delModal.hidden) delModal.hidden = true;
});

/* Le bouton ne s'active que si le mot de passe est saisi ET que
   "SUPPRIMER" est écrit : deux gestes volontaires, pour une action
   qu'on ne peut pas annuler. */
function majDelBtn() {
  delConfirm.disabled =
    delPass.value.length === 0 || delWord.value.trim().toUpperCase() !== "SUPPRIMER";
}
delPass.addEventListener("input", majDelBtn);
delWord.addEventListener("input", majDelBtn);

delConfirm.addEventListener("click", async () => {
  delConfirm.disabled = true;
  delConfirm.textContent = "Suppression…";
  delError.hidden = true;

  try {
    // on coupe les écoutes avant de perdre les droits d'accès
    if (window.pyrolosStopListeners) window.pyrolosStopListeners();
    Stats.stopHeartbeat();

    const colIds = (window.pyrolosColIds && window.pyrolosColIds()) || [];
    const { restant } = await Account.destroy(delPass.value, colIds);

    delModal.hidden = true;
    if (restant.length) {
      console.warn("Éléments non supprimés :", restant.join(", "));
    }
    // Firebase déclenche onAuthStateChanged(null) : l'interface se remet
    // d'elle-même à l'état déconnecté. On rafraîchit le compteur.
    setTimeout(refreshStats, 400);
  } catch (err) {
    console.error(err);
    delError.hidden = false;
    delError.textContent =
      err.code === "auth/invalid-credential" || err.code === "auth/wrong-password"
        ? "Mot de passe incorrect."
      : err.code === "auth/too-many-requests"
        ? "Trop de tentatives. Réessaie dans quelques minutes."
      : "Suppression impossible. Réessaie.";
    delConfirm.textContent = "Supprimer définitivement";
    majDelBtn();
  }
});

/* ---------------- Compteurs (inscrits / en ligne) ---------------- */

async function refreshStats() {
  const aEl = document.getElementById("pmw-stat-accounts");
  const oEl = document.getElementById("pmw-stat-online");
  if (!aEl || !oEl) return;

  const [comptes, presents] = await Promise.all([Stats.comptes(), Stats.enLigne()]);

  aEl.textContent = comptes === null
    ? "\u{1F465} \u2013"
    : `\u{1F465} ${comptes} inscrit${comptes > 1 ? "s" : ""}`;

  oEl.innerHTML = presents === null
    ? '<i class="pmw-live"></i> \u2013'
    : `<i class="pmw-live"></i> ${presents} en ligne`;
  oEl.classList.toggle("nobody", presents === 0);
}

// rafraîchissement périodique, uniquement quand l'onglet est visible
setInterval(() => {
  if (document.visibilityState === "visible") refreshStats();
}, 120000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshStats();
});

refreshStats();

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
            title="${data.mine === n ? 'Cliquer pour retirer ta note' : 'Noter ' + n + '/5'}"
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
        // recliquer sur l'étoile déjà sélectionnée retire la note :
        // c'est le réflexe naturel après un clic malencontreux
        if (data.mine === value) {
          await Ratings.remove(id);
        } else {
          await Ratings.set(id, value);
        }
        await mountRating(host, col);
        if (window.pyrolosRefreshRanking) window.pyrolosRefreshRanking();
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
    if (window.pyrolosRefreshRanking) window.pyrolosRefreshRanking();
  });

  const needLogin = host.querySelector("[data-need-login]");
  if (needLogin) needLogin.addEventListener("click", () => openModal("login"));
}

// exposés pour script.js, qui n'est pas un module
window.PyrolosRating = { mount: mountRating, openLogin: () => openModal("login") };
window.PyrolosRidden = Ridden;
window.PyrolosColId = colId;
window.PyrolosColRatings = {
  isSignedIn: () => !!Auth.current,
  get: id => Ratings.get(id),
  set: (id, v) => Ratings.set(id, v),
  remove: id => Ratings.remove(id)
};
window.PyrolosRouteRatings = {
  isSignedIn: () => !!Auth.current,
  get: id => RouteRatings.get(id),
  set: (id, v) => RouteRatings.set(id, v),
  remove: id => RouteRatings.remove(id)
};
window.PyrolosRoutesFaites = RoutesFaites;
window.PyrolosMessages = {
  isSignedIn: () => !!Auth.current,
  myUid: () => Messages.myUid(),
  open:   (uid, pseudo) => Messages.open(uid, pseudo),
  send:   (id, txt) => Messages.send(id, txt),
  markRead: id => Messages.markRead(id),
  listenConversations: cb => Messages.listenConversations(cb),
  listenMessages: (id, cb) => Messages.listenMessages(id, cb),
  accountExists: uid => Messages.accountExists(uid)
};
window.PyrolosRiders = {
  isSignedIn: () => !!Auth.current,
  myUid: () => Auth.current?.uid || null,
  list:   () => Riders.list(),
  mine:   () => Riders.mine(),
  save:   d  => Riders.save(d),
  remove: () => Riders.remove()
};
window.PyrolosTrips = {
  isSignedIn: () => !!Auth.current,
  list:   () => Trips.list(),
  save:   d  => Trips.save(d),
  remove: id => Trips.remove(id),
  toggleDone: (id, v) => Trips.toggleDone(id, v)
};

// premier chargement (utilisateur non connecté : stockage local)
Ridden.load().then(() => {
  if (window.pyrolosRefreshRidden) window.pyrolosRefreshRidden();
});
