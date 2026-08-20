// =============================================================
//  Pyrolos — authentification + notation communautaire
//  Firebase v10 (modules ES, chargés depuis le CDN Google)
// =============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, deleteDoc, getDoc,
  collection, getDocs, serverTimestamp
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

export const Auth = {
  current: null,

  onChange(callback) {
    onAuthStateChanged(auth, user => {
      Auth.current = user;
      callback(user);
    });
  },

  /** Crée un compte à partir d'un pseudo unique et d'un mot de passe. */
  async register(pseudo, password) {
    const problem = validatePseudo(pseudo);
    if (problem) { const e = new Error(problem); e.code = "pyrolos/bad-pseudo"; throw e; }

    const cred = await createUserWithEmailAndPassword(
      auth, pseudoToEmail(pseudo), password
    );
    // on conserve la casse choisie par l'utilisateur pour l'affichage
    await updateProfile(cred.user, { displayName: pseudo.trim() });
    return cred.user;
  },

  async login(pseudo, password) {
    const cred = await signInWithEmailAndPassword(
      auth, pseudoToEmail(pseudo), password
    );
    return cred.user;
  },

  async logout() {
    await signOut(auth);
  }
};

/** Messages d'erreur Firebase traduits en français lisible. */
export function authErrorMessage(err) {
  const map = {
    "auth/invalid-email":          "Pseudo invalide.",
    "auth/missing-password":       "Mot de passe manquant.",
    "auth/weak-password":          "Mot de passe trop court (6 caractères minimum).",
    "auth/email-already-in-use":   "Ce pseudo est déjà pris. Essaie-en un autre.",
    "auth/invalid-credential":     "Pseudo ou mot de passe incorrect.",
    "auth/wrong-password":         "Pseudo ou mot de passe incorrect.",
    "auth/user-not-found":         "Pseudo ou mot de passe incorrect.",
    "auth/too-many-requests":      "Trop de tentatives. Réessaie dans quelques minutes.",
    "auth/network-request-failed": "Problème de connexion réseau.",
    "auth/operation-not-allowed":  "La méthode E-mail/Mot de passe n'est pas activée dans la console Firebase."
  };
  if (err?.code === "pyrolos/bad-pseudo") return err.message;
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
