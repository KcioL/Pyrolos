// =============================================================
//  CONFIGURATION FIREBASE
// =============================================================
// 1. Va sur https://console.firebase.google.com et crée un projet.
// 2. Dans "Authentication" > "Sign-in method", active "E-mail/Mot de passe".
// 3. Dans "Firestore Database", crée une base (mode production).
// 4. Dans "Paramètres du projet" > "Vos applications" > Web,
//    copie l'objet firebaseConfig et colle-le ci-dessous.
//
// NOTE IMPORTANTE SUR LA SÉCURITÉ
// Ces clés ne sont PAS des secrets : elles sont visibles par tous
// dans le code de la page, et c'est normal / prévu par Google.
// Elles identifient ton projet, elles n'autorisent rien par elles-mêmes.
// La vraie sécurité vient des RÈGLES FIRESTORE (fichier firestore.rules).
// Ne mets JAMAIS de clé de compte de service (service account) ici.
// =============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDsIVnuV_vUDaIQdb034c4pbj9f0uULvqM",
  authDomain: "pyrolos.firebaseapp.com",
  projectId: "pyrolos",
  storageBucket: "pyrolos.firebasestorage.app",
  messagingSenderId: "749622876676",
  appId: "1:749622876676:web:044f7c2bbc325374f07351",
  measurementId: "G-7NDZJHHZVM"
};
