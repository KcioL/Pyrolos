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
