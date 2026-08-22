// =============================================================
//  Pyrolos — authentification + notation communautaire
//  Firebase v10 (modules ES, chargés depuis le CDN Google)
// =============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile, sendPasswordResetEmail,
  deleteUser, reauthenticateWithCredential, EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, deleteDoc, getDoc, addDoc, updateDoc,
  collection, getDocs, query, orderBy, where, limit,
  onSnapshot, serverTimestamp, getCountFromServer, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

/* ------------------------------------------------------------
   Identifiant stable pour un col.
   On dérive l'id du nom : "Col du Tourmalet" -> "col-du-tourmalet".
   Important : si tu renommes un col dans cols.json, ses notes
   seront orphelines. Pour éviter ça, tu peux ajouter un champ "id"
   fixe dans cols.json et l'utiliser à la place.
------------------------------------------------------------ */
export function colId(col) {
  if (col.id) return col.id;
  return col.nom
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // enlève les accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/* ============================================================
   AUTHENTIFICATION
   Firebase gère le hachage des mots de passe côté serveur.
   Le mot de passe ne transite jamais vers Firestore et n'est
   jamais stocké par nous.
   ============================================================ */

/* ------------------------------------------------------------
   PSEUDO AU LIEU D'E-MAIL

   Firebase Authentication attend techniquement une adresse e-mail.
   On fabrique donc une adresse interne à partir du pseudo :
      "Motard64"  ->  "motard64@pyrolos.local"

   L'utilisateur ne voit jamais cette adresse : il saisit seulement
   son pseudo et son mot de passe.

   Avantage : l'unicité du pseudo est garantie par Firebase lui-même,
   de façon atomique. Deux personnes ne peuvent pas prendre le même
   pseudo, même en s'inscrivant exactement en même temps — la seconde
   reçoit l'erreur "email-already-in-use".

   ATTENTION : aucune adresse e-mail n'étant collectée, la
   réinitialisation de mot de passe est IMPOSSIBLE par conception.
   Un mot de passe oublié = un compte définitivement perdu.
   C'est un choix assumé : pas de collecte de données personnelles,
   pas de serveur d'envoi d'e-mails à maintenir. L'utilisateur en est
   averti clairement au moment de l'inscription.
------------------------------------------------------------ */

const PSEUDO_DOMAIN = "pyrolos.local";

/** Normalise un pseudo : minuscules, sans accent ni caractère exotique. */
export function normalizePseudo(pseudo) {
  return (pseudo || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Vérifie la forme du pseudo. Renvoie null si valide, sinon un message. */
export function validatePseudo(pseudo) {
  const p = normalizePseudo(pseudo);
  if (p.length < 3)  return "Le pseudo doit faire au moins 3 caractères.";
  if (p.length > 20) return "Le pseudo ne doit pas dépasser 20 caractères.";
  if (!/^[a-z0-9._-]+$/.test(p)) {
    return "Lettres, chiffres, point, tiret et underscore uniquement.";
  }
  return null;
}

function pseudoToEmail(pseudo) {
  return `${normalizePseudo(pseudo)}@${PSEUDO_DOMAIN}`;
}

/**
 * Nom à afficher pour un utilisateur.
 * Repli sur l'adresse interne privée de son domaine, au cas où
 * displayName ne serait pas encore disponible.
 */
export function displayNameOf(user) {
  if (!user) return "";
  if (user.displayName) return user.displayName;
  const mail = user.email || "";
  return mail.endsWith("@" + PSEUDO_DOMAIN)
    ? mail.slice(0, -(PSEUDO_DOMAIN.length + 1))
    : mail;
}

export const Auth = {
  current: null,

  onChange(callback) {
    onAuthStateChanged(auth, user => {
      Auth.current = user;
      callback(user);
    });
  },

  /**
   * Crée un compte : e-mail réel comme identifiant, pseudo comme nom
   * affiché. L'e-mail sert UNIQUEMENT à se connecter et à récupérer son
   * mot de passe ; il n'apparaît jamais sur le site.
   */
  async register(pseudo, email, password) {
    const probleme = validatePseudo(pseudo);
    if (probleme) { const e = new Error(probleme); e.code = "pyrolos/bad-pseudo"; throw e; }

    const p = normalizePseudo(pseudo);

    // Le pseudo n'est plus garanti unique par l'adresse interne : on le
    // réserve explicitement. La création échoue si le document existe
    // déjà, ce qui rend la réservation atomique.
    try {
      await setDoc(doc(db, "pseudos", p), { reserve: true }, { merge: false });
    } catch {
      const e = new Error("Ce pseudo est déjà pris.");
      e.code = "pyrolos/pseudo-taken"; throw e;
    }

    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      // l'inscription a échoué : on libère le pseudo réservé
      try { await deleteDoc(doc(db, "pseudos", p)); } catch {}
      throw err;
    }

    await updateProfile(cred.user, { displayName: pseudo.trim() });
    // on rattache le pseudo au compte créé
    try { await setDoc(doc(db, "pseudos", p), { uid: cred.user.uid }, { merge: true }); } catch {}

    await cred.user.reload();
    return auth.currentUser;
  },

  /**
   * Connexion. Accepte une adresse e-mail, ou un pseudo pour les comptes
   * créés avant ce changement (leur identifiant interne était
   * `pseudo@pyrolos.local`).
   */
  async login(identifiant, password) {
    const id = (identifiant || "").trim();
    const email = id.includes("@") ? id : pseudoToEmail(id);
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },

  async logout() {
    await signOut(auth);
  },

  /**
   * Envoie le lien de réinitialisation. C'est Firebase qui expédie le
   * message depuis ses propres serveurs : le site n'envoie rien.
   */
  async resetPassword(email) {
    const e = (email || "").trim();
    if (!e.includes("@")) {
      const err = new Error("Saisis ton adresse e-mail.");
      err.code = "pyrolos/need-email"; throw err;
    }
    if (e.endsWith("@" + PSEUDO_DOMAIN)) {
      const err = new Error("legacy");
      err.code = "pyrolos/legacy-account"; throw err;
    }
    await sendPasswordResetEmail(auth, e);
  },

  /** Le compte utilise-t-il encore l'ancienne adresse interne ? */
  isLegacy() {
    return !!Auth.current?.email?.endsWith("@" + PSEUDO_DOMAIN);
  }
};

/** Messages d'erreur Firebase traduits en français lisible. */
export function authErrorMessage(err) {
  const map = {
    "auth/invalid-email":          "Adresse e-mail invalide.",
    "auth/missing-password":       "Mot de passe manquant.",
    "auth/weak-password":          "Mot de passe trop court (6 caractères minimum).",
    "auth/email-already-in-use":   "Un compte existe déjà avec cette adresse e-mail.",
    "auth/invalid-credential":     "Identifiant ou mot de passe incorrect.",
    "auth/wrong-password":         "Identifiant ou mot de passe incorrect.",
    "auth/user-not-found":         "Identifiant ou mot de passe incorrect.",
    "auth/too-many-requests":      "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/network-request-failed": "Problème de connexion réseau.",
    "auth/operation-not-allowed":  "La méthode E-mail/Mot de passe n'est pas activée dans la console Firebase."
  };
  if (err?.code === "pyrolos/bad-pseudo") return err.message;
  if (err?.code === "pyrolos/pseudo-taken") return err.message;
  if (err?.code === "pyrolos/need-email") return err.message;
  return map[err?.code] || "Une erreur est survenue. Réessaie.";
}

/* ============================================================
   NOTES
   Modèle de données :
     cols/{colId}/ratings/{uid}  ->  { value: 1..5, updatedAt }

   Chaque utilisateur possède UN document de note par col, dont
   l'identifiant est son propre uid. Les règles Firestore
   garantissent qu'il ne peut écrire que dans le sien : impossible
   de voter deux fois ou de modifier la note d'un autre.

   La moyenne est recalculée en lisant la sous-collection.
   C'est simple et inviolable (aucun total n'est stocké, donc
   personne ne peut le falsifier). Voir la note de fin de fichier
   sur le passage à l'échelle.
   ============================================================ */

const cache = new Map();   // colId -> { avg, count, mine }

export const Ratings = {
  /** Moyenne + nombre de votes + note de l'utilisateur courant. */
  async get(id, { force = false } = {}) {
    if (!force && cache.has(id)) return cache.get(id);

    const snap = await getDocs(collection(db, "cols", id, "ratings"));
    let sum = 0, count = 0, mine = null;
    const uid = Auth.current?.uid;

    snap.forEach(d => {
      const v = d.data().value;
      if (typeof v !== "number") return;
      sum += v; count++;
      if (uid && d.id === uid) mine = v;
    });

    const result = { avg: count ? sum / count : null, count, mine };
    cache.set(id, result);
    return result;
  },

  /** Enregistre (ou met à jour) la note de l'utilisateur connecté. */
  async set(id, value) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error("invalid-value");
    }
    await setDoc(doc(db, "cols", id, "ratings", user.uid), {
      value,
      updatedAt: serverTimestamp()
    });
    cache.delete(id);
    return this.get(id, { force: true });
  },

  /** Retire la note de l'utilisateur connecté. */
  async remove(id) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    await deleteDoc(doc(db, "cols", id, "ratings", user.uid));
    cache.delete(id);
    return this.get(id, { force: true });
  },

  clearCache() { cache.clear(); }
};

/* ------------------------------------------------------------
   PASSAGE À L'ÉCHELLE
   Cette approche lit toutes les notes d'un col pour calculer sa
   moyenne : parfait jusqu'à quelques centaines de votes par col.
   Au-delà, ça consomme beaucoup de lectures Firestore.

   La suite logique serait une Cloud Function déclenchée à chaque
   écriture de note, qui maintient un document d'agrégat
   { sum, count } dans cols/{colId}. Il faut alors garder l'écriture
   de cet agrégat interdite aux clients (règles ci-dessous), sinon
   n'importe qui pourrait s'inventer une moyenne de 5/5.
   Les Cloud Functions nécessitent le plan Blaze (avec un quota
   gratuit généreux).
------------------------------------------------------------ */

/* ============================================================
   COLS ROULÉS (succès)
   Modèle : users/{uid}  ->  { ridden: ["Col du Tourmalet", ...] }

   Un seul document par utilisateur, contenant la liste. C'est
   suffisant ici (quelques dizaines de cols maximum) et ça permet
   de tout lire en une seule requête.

   Tant que personne n'est connecté, on retombe sur localStorage :
   le site reste utilisable sans compte, et rien n'est perdu.
   ============================================================ */

const RIDDEN_KEY = "pyrolos_cols_roules";

function localRidden() {
  try {
    const raw = localStorage.getItem(RIDDEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveLocalRidden(set) {
  try { localStorage.setItem(RIDDEN_KEY, JSON.stringify([...set])); } catch {}
}

let riddenCache = null;   // Set en mémoire, source de vérité pour l'affichage

export const Ridden = {
  /** Liste des cols roulés (Firestore si connecté, sinon localStorage). */
  async load() {
    const user = Auth.current;
    if (!user) {
      riddenCache = localRidden();
      return riddenCache;
    }
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      const remote = new Set(snap.exists() ? (snap.data().ridden || []) : []);

      // Première connexion : on récupère ce qui avait été coché hors compte
      const local = localRidden();
      if (local.size) {
        const before = remote.size;
        local.forEach(n => remote.add(n));
        if (remote.size !== before || !snap.exists()) {
          await setDoc(doc(db, "users", user.uid),
                       { ridden: [...remote], updatedAt: serverTimestamp() },
                       { merge: true });
        }
        saveLocalRidden(new Set());   // la copie locale a été absorbée
      }
      riddenCache = remote;
      return riddenCache;
    } catch (err) {
      console.error("Chargement des succès impossible :", err);
      riddenCache = localRidden();
      return riddenCache;
    }
  },

  /** Version synchrone pour l'affichage (déjà chargée). */
  get() {
    return riddenCache || localRidden();
  },

  /** Coche / décoche un col et enregistre. */
  async toggle(nom) {
    const set = new Set(this.get());
    if (set.has(nom)) set.delete(nom); else set.add(nom);
    riddenCache = set;

    const user = Auth.current;
    if (!user) { saveLocalRidden(set); return set; }

    try {
      await setDoc(doc(db, "users", user.uid),
                   { ridden: [...set], updatedAt: serverTimestamp() },
                   { merge: true });
    } catch (err) {
      console.error("Sauvegarde des succès impossible :", err);
      saveLocalRidden(set);   // filet de sécurité
    }
    return set;
  },

  reset() { riddenCache = null; }
};


/* ============================================================
   ITINÉRAIRES DU SITE : notes et parcours réalisés

   routes/{routeId}/ratings/{uid}  -> note de 1 à 5, un doc par personne
   users/{uid}.routesFaites        -> liste des itinéraires cochés « fait »

   Même principe que pour les cols : la moyenne n'est jamais stockée,
   elle se recalcule à partir des notes individuelles. Rien à falsifier.
   ============================================================ */

const routeCache = new Map();

export const RouteRatings = {
  async get(id, { force = false } = {}) {
    if (!force && routeCache.has(id)) return routeCache.get(id);
    try {
      const snap = await getDocs(collection(db, "routes", id, "ratings"));
      let sum = 0, count = 0, mine = null;
      const uid = Auth.current?.uid;
      snap.forEach(doc_ => {
        const v = doc_.data().value;
        if (typeof v !== "number") return;
        sum += v; count++;
        if (uid && doc_.id === uid) mine = v;
      });
      const res = { avg: count ? sum / count : null, count, mine };
      routeCache.set(id, res);
      return res;
    } catch (err) {
      console.warn("Notes d'itinéraire :", err.code || err);
      return { avg: null, count: 0, mine: null };
    }
  },

  async set(id, value) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("invalid-value");
    await setDoc(doc(db, "routes", id, "ratings", user.uid), {
      value, updatedAt: serverTimestamp()
    });
    routeCache.delete(id);
    return this.get(id, { force: true });
  },

  async remove(id) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    await deleteDoc(doc(db, "routes", id, "ratings", user.uid));
    routeCache.delete(id);
    return this.get(id, { force: true });
  },

  clearCache() { routeCache.clear(); }
};

/* ---- Itinéraires réalisés (compteur de kilomètres) ---- */

const ROUTES_KEY = "pyrolos_routes_faites";
let routesCache = null;

function localRoutes() {
  try {
    const raw = localStorage.getItem(ROUTES_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

export const RoutesFaites = {
  async load() {
    const user = Auth.current;
    if (!user) { routesCache = localRoutes(); return routesCache; }
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      const remote = new Set(snap.exists() ? (snap.data().routesFaites || []) : []);
      // reprise de ce qui avait été coché hors compte
      const local = localRoutes();
      if (local.size) {
        local.forEach(x => remote.add(x));
        await setDoc(doc(db, "users", user.uid),
                     { routesFaites: [...remote], updatedAt: serverTimestamp() },
                     { merge: true });
        try { localStorage.removeItem(ROUTES_KEY); } catch {}
      }
      routesCache = remote;
      return routesCache;
    } catch (err) {
      console.warn("Itinéraires réalisés :", err.code || err);
      routesCache = localRoutes();
      return routesCache;
    }
  },

  get() { return routesCache || localRoutes(); },

  async toggle(id) {
    const set = new Set(this.get());
    if (set.has(id)) set.delete(id); else set.add(id);
    routesCache = set;

    const user = Auth.current;
    if (!user) {
      try { localStorage.setItem(ROUTES_KEY, JSON.stringify([...set])); } catch {}
      return set;
    }
    try {
      await setDoc(doc(db, "users", user.uid),
                   { routesFaites: [...set], updatedAt: serverTimestamp() },
                   { merge: true });
    } catch (err) {
      console.warn("Sauvegarde des itinéraires réalisés :", err.code || err);
    }
    return set;
  },

  reset() { routesCache = null; }
};


/* ============================================================
   ITINÉRAIRES PERSONNELS
   Modèle : users/{uid}/trips/{tripId}

   Sous-collection privée : les règles Firestore n'autorisent la
   lecture et l'écriture qu'au propriétaire du document parent.
   Personne d'autre ne voit ces parcours.

   On enregistre les POINTS du parcours (départ, cols, passages,
   mode) et non le tracé complet : quelques centaines d'octets au
   lieu de dizaines de Ko. Le tracé est recalculé par OSRM au
   moment du chargement.
   ============================================================ */

export const Trips = {
  /** Itinéraires de l'utilisateur connecté, du plus récent au plus ancien. */
  async list() {
    const user = Auth.current;
    if (!user) return [];
    try {
      const q = query(collection(db, "users", user.uid, "trips"),
                      orderBy("createdAt", "desc"));
      const snap = await getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error("Lecture des itinéraires impossible :", err);
      return [];
    }
  },

  /** Enregistre un nouvel itinéraire. `data` doit rester léger. */
  async save(data) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");

    const nom = (data.nom || "").trim().slice(0, 80);
    if (!nom) throw new Error("no-name");

    const payload = {
      nom,
      desc: (data.desc || "").trim().slice(0, 500),
      mode: data.mode || "boucle",
      start: data.start || null,
      end: data.end || null,
      via: (data.via || []).slice(0, 20),
      cols: (data.cols || []).slice(0, 20),
      distance: Math.round(data.distance || 0),   // mètres
      duration: Math.round(data.duration || 0),   // secondes
      dplus: Math.round(data.dplus || 0),         // mètres
      createdAt: serverTimestamp()
    };

    const ref = await addDoc(collection(db, "users", user.uid, "trips"), payload);
    return ref.id;
  },

  async remove(id) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    await deleteDoc(doc(db, "users", user.uid, "trips", id));
  },

  /**
   * Marque (ou démarque) un itinéraire personnel comme parcouru.
   * Le drapeau vit dans le document lui-même : il est déjà privé,
   * inutile de tenir une liste séparée.
   */
  async toggleDone(id, valeur) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    await setDoc(doc(db, "users", user.uid, "trips", id),
                 { fait: !!valeur }, { merge: true });
  }
};


/* ============================================================
   FICHES "ROULER ENSEMBLE"
   Modèle : riders/{uid}  ->  un document par utilisateur

   Collection PUBLIQUE en lecture : c'est le principe même de la
   fonctionnalité. En écriture, chacun ne peut toucher qu'au
   document portant son propre uid.

   L'utilisateur est prévenu avant publication que sa fiche est
   visible de tous, Instagram compris.
   ============================================================ */

export const STYLES = [
  { id: "tranquille", label: "Tranquille", desc: "Balade, photos, arrêts fréquents" },
  { id: "normal",     label: "Normal",     desc: "Rythme régulier, sans forcer" },
  { id: "sportif",    label: "Sportif",    desc: "Bon rythme, courbes enroulées" },
  { id: "arsouille",  label: "Arsouille",  desc: "Ça envoie dans les cols" }
];

export const Riders = {
  /** Toutes les fiches publiées. */
  async list() {
    try {
      const snap = await getDocs(collection(db, "riders"));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error("Lecture des fiches impossible :", err);
      return [];
    }
  },

  /** Fiche de l'utilisateur connecté, ou null. */
  async mine() {
    const user = Auth.current;
    if (!user) return null;
    try {
      const snap = await getDoc(doc(db, "riders", user.uid));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } catch { return null; }
  },

  /** Crée ou met à jour sa fiche. */
  async save(data) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");

    const insta = (data.instagram || "").trim().replace(/^@/, "").slice(0, 40);
    if (insta && !/^[A-Za-z0-9._]+$/.test(insta)) {
      const e = new Error("Pseudo Instagram invalide."); e.code = "pyrolos/bad-insta"; throw e;
    }

    // 1 à 3 styles, filtrés sur les valeurs connues pour éviter
    // qu'une valeur inattendue soit enregistrée
    const valides = STYLES.map(s => s.id);
    const styles = [...new Set(data.styles || [])]
                     .filter(s => valides.includes(s))
                     .slice(0, 3);
    if (!styles.length) {
      const e = new Error("Choisis au moins un style de conduite.");
      e.code = "pyrolos/no-style"; throw e;
    }

    await setDoc(doc(db, "riders", user.uid), {
      pseudo: displayNameOf(user).slice(0, 40),
      styles,
      massif: (data.massif || "").slice(0, 60),
      moto: (data.moto || "").trim().slice(0, 60),
      dispo: (data.dispo || "").trim().slice(0, 60),
      desc: (data.desc || "").trim().slice(0, 300),
      instagram: insta,
      cols: Number(data.cols) || 0,
      updatedAt: serverTimestamp()
    });
  },

  async remove() {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");
    await deleteDoc(doc(db, "riders", user.uid));
  }
};


/* ============================================================
   MESSAGERIE
   Modèle :
     conversations/{convId}            { participants, pseudos, lastText, lastAt, lastFrom, read }
     conversations/{convId}/messages/  { from, text, createdAt }

   L'identifiant de conversation est la concaténation des deux uid
   triés alphabétiquement : deux personnes ne peuvent donc jamais
   ouvrir deux fils parallèles, et l'id se recalcule sans requête.

   Les règles n'autorisent l'accès qu'aux deux participants.
   ============================================================ */

export const Messages = {

  /** Identifiant déterministe d'une conversation entre deux comptes. */
  convId(otherUid) {
    const me = Auth.current?.uid;
    if (!me) throw new Error("not-signed-in");
    return [me, otherUid].sort().join("__");
  },

  /** Crée la conversation si besoin, puis renvoie son identifiant. */
  async open(otherUid, otherPseudo) {
    const me = Auth.current;
    if (!me) throw new Error("not-signed-in");
    if (otherUid === me.uid) throw new Error("self");

    const id = this.convId(otherUid);
    const ref = doc(db, "conversations", id);

    // Aucune lecture préalable : on écrit directement en mode `merge`.
    // - si la conversation n'existe pas, elle est créée ;
    // - si elle existe, seuls ces champs sont mis à jour, l'historique
    //   et la date du dernier message restent intacts.
    // On évite ainsi une lecture Firestore ET le cas délicat de la
    // lecture d'un document inexistant, que les règles doivent
    // autoriser explicitement.
    await setDoc(ref, {
      participants: [me.uid, otherUid].sort(),
      pseudos: {
        [me.uid]: displayNameOf(me).slice(0, 40),
        [otherUid]: (otherPseudo || "Motard").slice(0, 40)
      }
    }, { merge: true });

    return id;
  },

  /** Envoie un message. */
  async send(convId, text) {
    const me = Auth.current;
    if (!me) throw new Error("not-signed-in");

    const body = (text || "").trim().slice(0, 1000);
    if (!body) return;

    // L'identifiant de conversation EST la liste des deux uid triés.
    // On en déduit les participants sans relire le document : cela
    // économise une lecture Firestore à chaque message envoyé.
    const participants = convId.split("__");
    if (participants.length !== 2 || !participants.includes(me.uid)) {
      throw new Error("bad-conversation");
    }
    const other = participants.find(u => u !== me.uid);
    const ref = doc(db, "conversations", convId);

    // Les participants sont recopiés dans chaque message : les règles
    // vérifient ainsi l'accès sans appeler get() sur la conversation
    // parente, or chaque get() d'une règle est facturé comme une lecture.
    await addDoc(collection(db, "conversations", convId, "messages"), {
      from: me.uid,
      participants,
      text: body,
      createdAt: serverTimestamp()
    });

    // setDoc + merge plutôt qu'updateDoc : ce dernier échoue si le
    // document n'existe pas encore, ce qui perdrait le message qui vient
    // d'être écrit. Avec merge, la conversation est créée au besoin.
    await setDoc(ref, {
      participants,
      lastText: body.slice(0, 120),
      lastFrom: me.uid,
      lastAt: serverTimestamp(),
      read: {
        [me.uid]: true,
        [other]: false             // marque non lu pour le destinataire
      }
    }, { merge: true });
  },

  /** Écoute la liste des conversations de l'utilisateur (temps réel). */
  listenConversations(callback) {
    const me = Auth.current;
    if (!me) { callback([]); return () => {}; }

    const q = query(
      collection(db, "conversations"),
      where("participants", "array-contains", me.uid),
      orderBy("lastAt", "desc"),
      limit(30)
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => {
        console.error("Conversations :", err);
        if (err.code === "failed-precondition") {
          console.error(
            "[Pyrolos] Index Firestore manquant : clique sur le lien ci-dessus " +
            "pour le créer (collection conversations, participants + lastAt)."
          );
        }
        callback([]);
      });
  },

  /** Écoute les messages d'une conversation (temps réel). */
  listenMessages(convId, callback) {
    const q = query(
      collection(db, "conversations", convId, "messages"),
      orderBy("createdAt", "asc"),
      limit(60)      // fenêtre volontairement courte : chaque message chargé
                     // compte comme une lecture Firestore
    );
    return onSnapshot(q,
      snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => {
        console.error("Messages :", err);
        if (err.code === "permission-denied") {
          console.error(
            "[Pyrolos] Règles Firestore non à jour : recolle firestore.rules " +
            "dans la console (Firestore Database > Règles > Publier)."
          );
        }
        callback([]);
      });
  },

  /** Marque la conversation comme lue pour l'utilisateur courant. */
  async markRead(convId) {
    const me = Auth.current;
    if (!me) return;
    try {
      await setDoc(doc(db, "conversations", convId), {
        read: { [me.uid]: true }
      }, { merge: true });
    } catch { /* sans gravité */ }
  },

  myUid() { return Auth.current?.uid || null; },

  /** Le compte existe-t-il encore ? (une lecture, mise en cache côté appelant) */
  async accountExists(uid) {
    const snap = await getDoc(doc(db, "accounts", uid));
    return snap.exists();
  }
};


/* ============================================================
   STATISTIQUES : inscrits et présents

   accounts/{uid}  { createdAt }   -> un document par compte
   presence/{uid}  { lastSeen }    -> battement de cœur

   Les deux comptages passent par getCountFromServer() : Firestore
   renvoie le total sans transférer les documents, et facture une
   seule lecture par millier d'éléments. Bien plus économique que
   de lire la collection entière.

   La "présence" est déduite d'un horodatage rafraîchi périodiquement :
   Firestore n'offre pas de détection de déconnexion (contrairement à
   Realtime Database). Quelqu'un qui ferme brutalement son navigateur
   reste donc compté pendant deux minutes au plus.
   ============================================================ */

// Fenêtre volontairement large et battement espacé : chaque battement est
// une écriture Firestore, et c'est le poste le plus coûteux de cette
// fonctionnalité. 5 min / 2 min divise la facture par deux sans que
// l'affichage en devienne trompeur.
const PRESENCE_FENETRE = 5 * 60 * 1000;   // considéré en ligne : 5 minutes
let heartbeat = null;

export const Stats = {

  /** Nombre total de comptes créés. */
  async comptes() {
    try {
      const snap = await getCountFromServer(collection(db, "accounts"));
      return snap.data().count;
    } catch (err) {
      console.warn("Comptage des inscrits :", err.code || err);
      return null;
    }
  },

  /** Nombre de personnes actives dans les deux dernières minutes. */
  async enLigne() {
    try {
      const seuil = Timestamp.fromMillis(Date.now() - PRESENCE_FENETRE);
      const q = query(collection(db, "presence"), where("lastSeen", ">", seuil));
      const snap = await getCountFromServer(q);
      return snap.data().count;
    } catch (err) {
      console.warn("Comptage des présents :", err.code || err);
      return null;
    }
  },

  /**
   * S'assure que le compte possède son document dans `accounts`.
   * Appelé à chaque connexion et pas seulement à l'inscription : cela
   * rattrape les comptes créés avant l'ajout de cette collection.
   * `merge` préserve la date de création d'origine.
   */
  async ensureAccount() {
    const user = Auth.current;
    if (!user) return;
    try {
      await setDoc(doc(db, "accounts", user.uid), {
        createdAt: serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.warn("Enregistrement du compte :", err.code || err);
    }
  },

  /** Signale que l'utilisateur est là. Sans effet si non connecté. */
  async ping() {
    const user = Auth.current;
    if (!user) return;
    try {
      await setDoc(doc(db, "presence", user.uid), {
        lastSeen: serverTimestamp()
      });
    } catch (err) {
      // cause la plus fréquente : les règles Firestore n'ont pas encore
      // été republiées avec les sections `accounts` et `presence`
      if (err.code === "permission-denied") {
        console.warn(
          "[Pyrolos] Présence non enregistrée : pense à republier " +
          "firestore.rules dans la console Firebase."
        );
      }
    }
  },

  /** Démarre le battement de cœur, uniquement quand l'onglet est visible. */
  async startHeartbeat() {
    this.stopHeartbeat();
    if (!Auth.current) return;

    const battre = () => {
      if (document.visibilityState === "visible") return this.ping();
    };
    // on ATTEND le premier signal : sinon le comptage qui suit
    // s'exécuterait avant que notre propre présence soit enregistrée,
    // et afficherait 0 alors qu'on vient de se connecter
    await battre();
    heartbeat = setInterval(battre, 120000);  // toutes les 2 minutes
  },

  stopHeartbeat() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  },

  /** Retire sa présence (à la déconnexion). */
  async clearPresence() {
    const user = Auth.current;
    if (!user) return;
    try { await deleteDoc(doc(db, "presence", user.uid)); } catch {}
  }
};


/* ============================================================
   SUPPRESSION DE COMPTE

   Firebase exige une authentification RÉCENTE pour supprimer un
   compte : on redemande donc le mot de passe et on ré-authentifie
   avant l'opération.

   L'ordre compte : on efface d'abord les données Firestore, tant
   qu'on est encore authentifié et donc autorisé à écrire, puis le
   compte lui-même. L'inverse laisserait des données orphelines
   impossibles à supprimer.
   ============================================================ */

export const Account = {

  /**
   * Supprime définitivement le compte et ses données.
   * @param {string} password mot de passe, pour la ré-authentification
   * @param {string[]} colIds identifiants des cols (pour retirer les notes)
   * @returns {Promise<{restant: string[]}>} ce qui n'a pas pu être supprimé
   */
  async destroy(password, colIds = []) {
    const user = Auth.current;
    if (!user) throw new Error("not-signed-in");

    // 1. ré-authentification
    const cred = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, cred);

    const uid = user.uid;
    const restant = [];
    const essayer = async (libelle, fn) => {
      try { await fn(); } catch (err) {
        console.warn("Suppression —", libelle, ":", err.code || err);
        restant.push(libelle);
      }
    };

    // 2. itinéraires personnels (sous-collection à vider avant le parent)
    await essayer("itinéraires", async () => {
      const snap = await getDocs(collection(db, "users", uid, "trips"));
      await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
    });

    // 3. profil (cols roulés)
    await essayer("progression", () => deleteDoc(doc(db, "users", uid)));

    // 4. fiche « rouler ensemble »
    await essayer("fiche motard", () => deleteDoc(doc(db, "riders", uid)));

    // 5. notes laissées sur les cols
    await essayer("notes", async () => {
      await Promise.all(colIds.map(id =>
        deleteDoc(doc(db, "cols", id, "ratings", uid)).catch(() => {})));
    });

    // 6. marquer les conversations : les messages restent (ils appartiennent
    //    aussi au destinataire) mais l'interlocuteur doit voir que le compte
    //    n'existe plus. Sans cela, quelqu'un recréant le même pseudo
    //    hériterait visuellement d'une conversation qui n'est pas la sienne.
    await essayer("conversations", async () => {
      const q = query(collection(db, "conversations"),
                      where("participants", "array-contains", uid));
      const snap = await getDocs(q);
      await Promise.all(snap.docs.map(d =>
        setDoc(d.ref, { deleted: { [uid]: true } }, { merge: true })
          .catch(() => {})));
    });

    // 7. présence et inscription
    await essayer("présence", () => deleteDoc(doc(db, "presence", uid)));
    await essayer("inscription", () => deleteDoc(doc(db, "accounts", uid)));

    // 8. le compte lui-même, en dernier
    await deleteUser(user);

    return { restant };
  }
};
