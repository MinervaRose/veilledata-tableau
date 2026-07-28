# Sécurité — VeilleData Tableau

## 1. Objet du document

Ce document décrit les mesures de sécurité appliquées au démonstrateur **VeilleData Tableau**.

L’architecture du projet est la suivante :

```text
Flux GitHub Releases
        ↓
Google Apps Script
        ↓
Google Sheets
        ↓
Tableau Public
```

Le projet est conçu comme un exemple pédagogique de veille technologique automatisée. Il ne doit pas être utilisé pour traiter des données personnelles, confidentielles ou sensibles.

---

# 2. Périmètre de sécurité

Les principaux risques pris en compte sont :

- l’accès excessif aux fichiers Google Drive 
- la récupération de contenus depuis une source non autorisée 
- les redirections vers un domaine inattendu 
- l’injection de formules dans Google Sheets 
- l’ajout de doublons 
- les exécutions concurrentes 
- les réponses trop volumineuses 
- les flux invalides ou malformés 
- la publication accidentelle d’informations privées dans Tableau Public 
- l’exposition de secrets dans GitHub.

---

# 3. Principes appliqués

## 3.1 Principe du moindre privilège

Le script utilise uniquement les autorisations nécessaires à son fonctionnement.

Le fichier `Code.gs` contient :

```javascript
/**
 * @OnlyCurrentDoc
 */
```

Cette annotation limite l’accès du script au classeur Google Sheets auquel il est rattaché.

Le manifeste `appsscript.json` déclare explicitement les autorisations OAuth nécessaires, au lieu d’utiliser des permissions plus larges que nécessaire.

Le script n’a pas besoin d’accéder à l’ensemble de Google Drive.

---

## 3.2 Sources explicitement autorisées

Le script ne récupère pas une URL arbitraire fournie par un utilisateur.

Les flux autorisés sont définis dans une liste blanche dans le code et dans le manifeste Apps Script.

Les trois flux utilisés dans la démonstration sont :

```text
https://github.com/unionai-oss/pandera/releases.atom
https://github.com/fivetran/great_expectations/releases.atom
https://github.com/scikit-learn/scikit-learn/releases.atom
```

Une URL absente de cette liste doit être rejetée.

Cette mesure limite les risques de requêtes vers :

- un domaine inconnu 
- une ressource interne 
- une URL malveillante 
- une destination modifiée dans l’onglet `sources`.

---

## 3.3 HTTPS obligatoire

Les flux doivent utiliser le protocole HTTPS.

Le script vérifie que chaque URL commence par :

```text
https://
```

Les URLs non chiffrées en HTTP doivent être refusées.

---

## 3.4 Redirections désactivées

Les redirections automatiques sont désactivées lors des requêtes HTTP.

Cette mesure évite qu’une URL autorisée redirige silencieusement le script vers une destination différente.

Les URLs canoniques des dépôts sont utilisées directement.

---

# 4. Validation des données entrantes

## 4.1 Validation du format Atom

Avant le traitement, le script vérifie que la réponse reçue correspond à un document XML Atom exploitable.

Une réponse HTML, une page d’erreur ou un contenu vide ne doit pas être interprété comme un flux valide.

Le script doit signaler une erreur si une source ne renvoie aucun élément exploitable alors qu’un flux est attendu.

---

## 4.2 Limites de taille

Le script applique des limites pour éviter un traitement excessif :

- nombre maximal de sources 
- nombre maximal d’éléments par source 
- taille maximale de la réponse HTTP 
- longueur maximale des champs textuels.

Ces limites réduisent les risques de :

- dépassement des quotas Apps Script 
- consommation excessive de mémoire 
- blocage du classeur 
- import d’un contenu anormalement volumineux.

---

## 4.3 Nettoyage des champs textuels

Les titres, résumés et autres contenus externes sont nettoyés avant leur écriture dans Google Sheets.

Le script limite notamment :

- les balises HTML 
- les espaces superflus 
- les textes trop longs 
- les valeurs susceptibles d’être interprétées comme une formule.

---

## 4.4 Protection contre l’injection de formules

Une cellule Google Sheets peut exécuter une formule lorsqu’une valeur commence par certains caractères, par exemple :

```text
=
+
-
@
```

Les contenus récupérés depuis les flux sont donc neutralisés avant écriture lorsqu’ils commencent par un caractère susceptible de déclencher une formule.

Cette protection réduit le risque qu’un titre ou un résumé externe soit interprété comme une instruction dans le classeur.

---

# 5. Intégrité des données

## 5.1 Identifiants stables

Chaque publication reçoit un identifiant stable construit à partir de la source et d’une empreinte SHA-256.

Cet identifiant permet de reconnaître une publication déjà importée.

---

## 5.2 Déduplication

Avant l’ajout d’une ligne, le script vérifie si son `item_id` est déjà présent dans l’onglet `items`.

Exemple attendu :

```text
Première exécution : 30 éléments trouvés, 30 ajoutés
Deuxième exécution : 30 éléments trouvés, 0 ajouté
```

Cette règle empêche la duplication des mêmes releases lors des exécutions suivantes.

---

## 5.3 Préservation des colonnes manuelles

Le script ajoute uniquement de nouvelles lignes et ne remplace pas les décisions humaines déjà renseignées.

Les colonnes suivantes restent manuelles :

```text
status
relevance
project_impact
reviewed
```

Une nouvelle exécution ne doit pas effacer ni modifier ces valeurs.

---

## 5.4 Protection des colonnes automatiques

Dans Google Sheets, les colonnes alimentées par le script doivent être protégées contre les modifications accidentelles.

Les colonnes automatiques sont :

```text
item_id
fetched_at
published_at
source_name
source_type
title
url
summary
theme
```

---

# 6. Sécurité des exécutions

## 6.1 Verrou contre les exécutions concurrentes

Le script utilise un verrou Apps Script.

Ce verrou empêche deux exécutions de modifier simultanément le classeur, par exemple lorsqu’un lancement manuel se produit au même moment que le déclencheur quotidien.

Sans verrou, deux exécutions parallèles pourraient :

- créer des doublons 
- provoquer des écritures incohérentes 
- produire un journal incorrect.

---

## 6.2 Écriture par lot

Les nouvelles lignes sont écrites en une seule opération par lot lorsque cela est possible.

Cette méthode :

- réduit le nombre d’appels à Google Sheets 
- diminue le risque d’écriture partielle 
- améliore les performances 
- limite les dépassements de quotas.

---

## 6.3 Gestion des erreurs par source

Une erreur sur un flux ne doit pas empêcher automatiquement le traitement des autres flux.

Le script traite les sources séparément et conserve une trace des erreurs rencontrées.

Les statuts du journal sont :

| Statut | Signification |
|---|---|
| `SUCCESS` | Toutes les sources ont été traitées. |
| `PARTIAL` | Certaines sources ont échoué, mais les autres ont été traitées. |
| `ERROR` | L’exécution globale a échoué. |

---

## 6.4 Journalisation

Chaque exécution ajoute une ligne dans l’onglet `run_log`.

Les informations enregistrées comprennent :

```text
run_at
status
sources_checked
items_found
items_added
message
```

Le journal permet de vérifier :

- que le déclencheur fonctionne 
- qu’aucun doublon n’est ajouté 
- qu’une source a échoué 
- que le nombre d’éléments collectés reste cohérent.

Le journal ne doit pas contenir de secret, jeton, mot de passe ou donnée personnelle.

---

# 7. Gestion des secrets

Le projet ne nécessite pas de clé API.

Aucun secret ne doit être stocké dans :

- `Code.gs` 
- `appsscript.json` 
- Google Sheets 
- le dépôt GitHub 
- les captures d’écran 
- Tableau Public.

Si une version future utilise une clé API, elle devra être stockée dans un mécanisme approprié, par exemple les propriétés du script, et ne jamais être commitée dans GitHub.

---

# 8. Risques liés à Google Sheets

Le classeur Google Sheets constitue la base de données opérationnelle du démonstrateur.

Il doit rester dans Google Drive.

Recommandations :

- ne pas partager le classeur publiquement 
- limiter les droits d’édition 
- protéger les colonnes automatiques 
- vérifier régulièrement l’onglet `run_log` 
- ne pas y ajouter de données confidentielles 
- ne pas rendre le lien accessible à toute personne disposant de l’URL.

Le dépôt GitHub contient uniquement le code, la documentation et des exemples anonymes. Il ne contient pas le classeur vivant.

---

# 9. Risques liés à Tableau Public

Tableau Public est un service public.

Le classeur publié, les visualisations et l’extrait de données associé peuvent être accessibles à d’autres personnes.

Avant chaque publication, vérifier que la source ne contient pas :

- de donnée personnelle 
- d’adresse électronique 
- de token 
- de clé API 
- de chemin local 
- de nom confidentiel 
- d’information interne 
- de contenu protégé ou non destiné à être diffusé.

Dans ce projet, seules des informations publiques issues de GitHub Releases sont publiées.

Les onglets `sources` et `run_log` ne doivent pas être exposés inutilement dans le dashboard public.

Un compte Google dédié peut être utilisé pour la connexion Tableau afin d’éviter d’accorder au connecteur un accès large à un Drive personnel contenant d’autres documents.

---

# 10. Risques liés à GitHub

Avant chaque commit, vérifier l’absence de :

```text
clés API
tokens OAuth
mots de passe
identifiants
cookies
URLs privées
données personnelles
exports complets du Google Sheet
```

Le dépôt peut contenir :

```text
README.md
apps-script/Code.gs
apps-script/appsscript.json
docs/DATA_DICTIONARY.md
docs/SECURITY.md
screenshots/
samples/
```

Les captures doivent être vérifiées avant publication afin d’éviter d’afficher :

- l’adresse du compte Google 
- des noms de fichiers privés 
- des onglets confidentiels 
- des informations présentes dans la barre du navigateur 
- des identifiants techniques inutiles.

---

# 11. Dépendances et confiance dans les sources

Le démonstrateur dépend :

- de Google Apps Script 
- de Google Sheets 
- de Tableau Public 
- des flux GitHub Releases des projets suivis.

Une source peut :

- changer d’URL 
- modifier son format 
- devenir temporairement indisponible 
- supprimer d’anciennes releases 
- publier un contenu inattendu.

Le projet ne garantit donc pas une disponibilité continue.

Les erreurs doivent être visibles dans `run_log` et ne doivent pas être masquées.

---

# 12. Limites de sécurité

Les mesures décrites réduisent les risques, mais ne constituent pas un audit de sécurité complet.

Le projet ne comprend pas :

- d’authentification personnalisée 
- de chiffrement applicatif 
- de gestion de rôles avancée 
- de surveillance en temps réel 
- de système de sauvegarde automatisé 
- de validation humaine de chaque contenu avant collecte 
- de garantie contre une compromission d’une source externe.

Le démonstrateur est adapté à une veille sur des données publiques à faible sensibilité.

Il ne doit pas être utilisé tel quel pour :

- des données médicales 
- des données financières confidentielles 
- des données RH 
- des données clients 
- des secrets industriels 
- des informations soumises à des obligations réglementaires particulières.

---

# 13. Checklist avant publication

## Google Apps Script

- [ ] `@OnlyCurrentDoc` est présent.
- [ ] Les scopes OAuth sont explicitement déclarés.
- [ ] Les URLs sont limitées à une liste blanche.
- [ ] HTTPS est obligatoire.
- [ ] Les redirections sont désactivées.
- [ ] Les limites de taille sont actives.
- [ ] Les flux Atom sont validés.
- [ ] Les chaînes sont protégées contre l’injection de formules.
- [ ] Le verrou contre les exécutions concurrentes est actif.
- [ ] Les erreurs sont écrites dans `run_log`.

## Google Sheets

- [ ] Les colonnes automatiques sont protégées.
- [ ] Les colonnes manuelles sont préservées.
- [ ] Aucun secret n’est présent.
- [ ] Aucun doublon n’apparaît.
- [ ] Le journal montre une exécution récente réussie.

## Tableau Public

- [ ] Seules des données publiques sont utilisées.
- [ ] Aucun onglet confidentiel n’est publié.
- [ ] Aucun identifiant privé n’apparaît.
- [ ] Le dashboard public a été contrôlé après publication.
- [ ] La connexion Google utilisée ne donne pas accès à des documents sensibles.

## GitHub

- [ ] Aucun secret n’est commité.
- [ ] Le Google Sheet vivant n’est pas exporté dans le dépôt.
- [ ] Les captures d’écran ont été vérifiées.
- [ ] `Code.gs` et `appsscript.json` ne contiennent aucune information privée.
- [ ] La documentation distingue clairement données automatiques et jugement humain.

---

# 14. Réponse en cas d’incident

En cas de comportement inattendu :

1. désactiver le déclencheur Apps Script 
2. vérifier la dernière ligne de `run_log` 
3. identifier la source concernée 
4. désactiver cette source dans l’onglet `sources` 
5. vérifier les nouvelles lignes ajoutées dans `items` 
6. supprimer uniquement les lignes incorrectes après sauvegarde 
7. corriger le code ou l’URL autorisée 
8. relancer manuellement `runWatch` 
9. vérifier qu’aucun doublon ou contenu dangereux n’a été ajouté 
10. republier Tableau Public uniquement si les données publiques ont changé.

Si un secret a été publié accidentellement, le supprimer du dépôt ou du dashboard ne suffit pas. Il doit également être révoqué et remplacé.
