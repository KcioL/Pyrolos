# Pyrolos — mise en place de Firebase

> **Où en es-tu ?**
> - [x] Projet Firebase créé (`pyrolos`)
> - [x] Clés intégrées dans `firebase-config.js`
> - [ ] Authentication → activer **E-mail/Mot de passe** (§1)
> - [ ] Firestore Database → créer la base (§1)
> - [ ] Coller `firestore.rules` dans la console (§3) ← **indispensable**
> - [ ] Ajouter ton domaine aux domaines autorisés (§4)

## 1. Créer le projet  ✅ DÉJÀ FAIT (projet "pyrolos")

Si ce n'est pas encore configuré côté console, voici les étapes :

1. https://console.firebase.google.com → **Ajouter un projet**
2. **Authentication** → *Commencer* → **E-mail/Mot de passe** → activer
   (oui, même si les visiteurs saisiront un pseudo : voir "Connexion par
   pseudo" plus bas — c'est ce fournisseur qui est utilisé en coulisses)
3. **Firestore Database** → *Créer une base* → mode **production** → région `eur3` (Europe)

## 2. Configuration  ✅ DÉJÀ FAIT

`firebase-config.js` contient déjà les clés du projet **pyrolos**.
Rien à faire ici.

Ces clés sont publiques par conception. Elles identifient ton projet, elles
n'ouvrent aucun accès en elles-mêmes. Ne jamais mettre ici une clé de
*compte de service* (celles du menu "Comptes de service") : celle-là est un
vrai secret et donne un accès total.

## 3. Publier les règles de sécurité

**Firestore Database → onglet Règles** → coller le contenu de
`firestore.rules` → **Publier**.

Étape non facultative. Sans elle, ta base est ouverte à tous en écriture.
C'est ici, et pas dans le JavaScript, que la sécurité est réellement appliquée :
le code client peut être modifié par n'importe qui depuis les outils de
développement du navigateur.

## 4. Autoriser ton domaine

*Authentication → Settings → Domaines autorisés* → ajouter ton domaine
(`localhost` y est déjà pour les tests).

## 5. Tester

Les modules ES et Firebase ne fonctionnent pas en `file://`. Il faut un serveur :

```bash
cd site
python3 -m http.server 8000
```

puis http://localhost:8000

---

## Connexion par pseudo (sans e-mail)

Firebase Authentication réclame techniquement une adresse e-mail. Le site
en fabrique donc une, invisible pour l'utilisateur, à partir du pseudo :

    "Motard64"  →  motard64@pyrolos.local

Le visiteur ne saisit jamais qu'un pseudo et un mot de passe. Le domaine
`pyrolos.local` n'existe pas et ne reçoit rien : c'est volontaire.

Bon effet de bord : **l'unicité du pseudo est garantie par Firebase lui-même**,
de manière atomique. Deux personnes qui s'inscrivent au même instant avec le
même pseudo ne peuvent pas réussir toutes les deux — la seconde reçoit
"ce pseudo est déjà pris". Pas besoin d'une collection de pseudos réservés,
ni de vérification côté client (qui aurait été sujette aux courses critiques).

Les pseudos sont comparés en minuscules et sans accents : `Motard64`,
`motard64` et `MOTARD64` sont le même compte. La casse d'origine est
conservée pour l'affichage.

## Comment c'est sécurisé

**Mots de passe** — jamais stockés par nous, jamais écrits dans Firestore.
Le passage par le pseudo ne change rien à ce point : c'est toujours
Firebase Authentication qui gère.
Firebase Authentication les hache côté serveur (scrypt) et ne les rend
jamais lisibles, même à toi dans la console. Un hachage n'est pas un
chiffrement : il est irréversible, il n'existe pas de clé pour "déchiffrer"
un mot de passe.

**Données** — Firestore chiffre tout au repos (AES-256) et en transit (TLS),
automatiquement, sans configuration.

**Aucune donnée personnelle** — le site ne stocke ni e-mail, ni nom, ni
adresse IP. Seuls existent un pseudo, un mot de passe haché par Firebase, des
notes de 1 à 5, et la liste des cols roulés.

**Itinéraires personnels** — rangés dans `users/{uid}/trips/`, strictement
privés : les règles n'autorisent l'accès qu'au propriétaire du compte. Seuls
les points du parcours sont enregistrés (départ, cols, passages, mode), pas le
tracé complet — quelques centaines d'octets par itinéraire, recalculés par
OSRM au chargement.

**Cols roulés (succès)** — rangés dans `users/{uid}`, lisibles et modifiables
par leur seul propriétaire. Personne ne peut consulter la progression d'un
autre. Sans compte, la liste reste en `localStorage`, sur l'appareil ; à la
première connexion elle est absorbée dans le compte, rien n'est perdu.

**Notes** — chaque utilisateur possède un unique document nommé avec son `uid`
dans `cols/{col}/ratings/{uid}`. Les règles imposent trois choses :
on ne peut écrire que dans le document portant son propre uid (pas de vote à
la place d'autrui, pas de double vote), la valeur doit être un entier de 1 à 5
(pas de note à 999 pour gonfler la moyenne), et aucun champ supplémentaire
n'est accepté.

**Moyenne** — recalculée en lisant les notes individuelles, jamais stockée.
Un total stocké et modifiable par le client serait falsifiable ; ici il n'y a
rien à falsifier.

## Limites connues

**Coût de lecture** — la moyenne lit toutes les notes du col. Confortable
jusqu'à quelques centaines de votes par col. Au-delà, il faudra une
Cloud Function qui maintient un agrégat `{sum, count}` (plan Blaze requis,
quota gratuit généreux), en gardant l'écriture de cet agrégat interdite aux
clients.

**Identifiants de col** — dérivés du nom (`Col du Tourmalet` →
`col-du-tourmalet`). Si tu renommes un col dans `cols.json`, ses notes
deviennent orphelines. Pour l'éviter, ajoute un champ `"id"` fixe à chaque col
dans `cols.json` : le code l'utilisera en priorité.

**Mot de passe oublié = compte perdu.** Assumé, et annoncé clairement à
l'inscription. Aucune adresse e-mail n'étant collectée, il n'existe aucun
canal pour envoyer un lien de réinitialisation — un site statique ne peut pas
envoyer d'e-mail sans serveur dédié.

Contrepartie positive : aucune donnée personnelle n'est stockée. Pas de base
d'adresses à protéger, rien à déclarer côté RGPD, pas de service d'envoi à
maintenir ni à payer.

Si un jour tu veux vraiment la récupération, il faudra une Cloud Function
(plan Blaze) et un compte SMTP. Le dossier `users/` et la règle associée
devront alors être réintroduits.

**Anti-spam** — aucune limite de création de comptes. Si le site devient
visible, active App Check et la protection contre les abus d'authentification.

**Le champ `note` de `cols.json`** est désormais inutilisé pour l'affichage
des fiches : les valeurs que j'avais inventées sont remplacées par les vraies
notes des utilisateurs. Le classement, lui, s'appuie encore dessus — à faire
évoluer si tu veux qu'il reflète les votes.
