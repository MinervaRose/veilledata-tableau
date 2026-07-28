# Dictionnaire de données — VeilleData Tableau

## 1. Objet du jeu de données

Le projet **VeilleData Tableau** automatise la collecte de publications techniques depuis des flux GitHub Releases, les stocke dans Google Sheets, puis les restitue dans Tableau Public.

Le classeur Google Sheets contient trois onglets :

- `sources` : configuration des flux suivis ;
- `items` : publications collectées et enrichies ;
- `run_log` : journal des exécutions du script.

Les colonnes techniques sont alimentées automatiquement par Google Apps Script. Les colonnes d’interprétation restent sous contrôle humain.

---

# 2. Onglet `sources`

Cet onglet contient la liste des flux autorisés.

| Champ | Type attendu | Obligatoire | Alimentation | Description | Exemple |
|---|---|---:|---|---|---|
| `source_id` | Texte | Oui | Manuelle | Identifiant court, stable et unique de la source. Utiliser uniquement des lettres minuscules, chiffres, tirets et underscores. | `pandera` |
| `source_name` | Texte | Oui | Manuelle | Nom lisible affiché dans Google Sheets et Tableau. | `Pandera Releases` |
| `feed_url` | URL HTTPS | Oui | Manuelle | Adresse du flux Atom GitHub Releases. L’URL doit également figurer dans la liste blanche du script et du manifeste Apps Script. | `https://github.com/unionai-oss/pandera/releases.atom` |
| `source_type` | Texte contrôlé | Oui | Manuelle | Nature de la source suivie. | `GitHub Release` |
| `theme_hint` | Texte contrôlé | Recommandé | Manuelle | Thème principal attribué aux éléments de cette source. | `Data Quality` |
| `active` | Booléen | Oui | Manuelle | Active ou désactive la collecte de la source. Représenté par une case à cocher. | `TRUE` |

## Sources de démonstration

| `source_id` | `source_name` | `theme_hint` |
|---|---|---|
| `pandera` | `Pandera Releases` | `Data Quality` |
| `great_expectations` | `Great Expectations Releases` | `Data Quality` |
| `scikit_learn` | `scikit-learn Releases` | `Anomaly Detection` |

---

# 3. Onglet `items`

Cet onglet constitue la source principale utilisée par Tableau.

## 3.1 Colonnes automatiques

Les colonnes `A:I` sont alimentées par le script. Elles ne doivent pas être modifiées manuellement.

| Champ | Type attendu | Obligatoire | Alimentation | Description | Exemple |
|---|---|---:|---|---|---|
| `item_id` | Texte | Oui | Automatique | Identifiant unique de la publication. Il combine `source_id` et une empreinte SHA-256 utilisée pour la déduplication. | `pandera_8b3c92...` |
| `fetched_at` | Date et heure | Oui | Automatique | Date et heure auxquelles le script a récupéré l’élément. | `2026-07-28 13:56:41` |
| `published_at` | Date et heure | Recommandé | Automatique | Date de publication ou de mise à jour fournie par le flux Atom. Champ utilisé pour la chronologie Tableau. | `2026-06-29 18:01:03` |
| `source_name` | Texte | Oui | Automatique | Nom lisible de la source, repris depuis l’onglet `sources`. | `Pandera Releases` |
| `source_type` | Texte | Oui | Automatique | Type de la source, repris depuis l’onglet `sources`. | `GitHub Release` |
| `title` | Texte | Oui | Automatique | Titre de la publication ou numéro de version. | `v0.32.1` |
| `url` | URL HTTPS | Oui | Automatique | Lien vers la publication d’origine sur GitHub. | `https://github.com/unionai-oss/pandera/releases/tag/v0.32.1` |
| `summary` | Texte | Non | Automatique | Résumé nettoyé du contenu du flux. La longueur est limitée par le script. | `What's Changed fix: isolate config context...` |
| `theme` | Texte | Recommandé | Automatique | Thème repris depuis `theme_hint`. | `Data Quality` |

## 3.2 Colonnes manuelles

Les colonnes `J:M` servent à l’analyse humaine. Le script les laisse intactes lors des exécutions suivantes.

| Champ | Type attendu | Obligatoire | Alimentation | Description | Valeurs ou exemple |
|---|---|---:|---|---|---|
| `status` | Texte contrôlé | Non | Manuelle | Décision de traitement attribuée après lecture. | `À lire`, `À tester`, `Retenu`, `Écarté` |
| `relevance` | Texte contrôlé | Non | Manuelle | Niveau de pertinence pour le projet ou la veille. | `Faible`, `Moyenne`, `Forte` |
| `project_impact` | Texte court | Non | Manuelle | Conséquence potentielle de l’information sur un projet, un POC ou une décision. | `Comparer les règles de validation avec Pandera.` |
| `reviewed` | Booléen | Oui | Manuelle | Indique si l’élément a été revu par une personne. Représenté par une case à cocher. | `TRUE` ou `FALSE` |

## 3.3 Règles de qualité

- `item_id` doit être unique.
- `url` doit commencer par `https://github.com/`.
- `published_at` et `fetched_at` doivent être reconnues comme des dates.
- `status` doit utiliser uniquement les valeurs prévues.
- `relevance` doit utiliser uniquement les valeurs prévues.
- `reviewed` doit être un booléen.
- Une ligne non revue peut conserver `status`, `relevance` et `project_impact` vides.
- Une publication atypique ou importante ne doit pas être automatiquement classée sans validation humaine.
- Les colonnes automatiques doivent rester protégées dans Google Sheets.

---

# 4. Onglet `run_log`

Cet onglet enregistre chaque exécution manuelle ou planifiée.

| Champ | Type attendu | Obligatoire | Alimentation | Description | Exemple |
|---|---|---:|---|---|---|
| `run_at` | Date et heure | Oui | Automatique | Date et heure de démarrage de l’exécution. | `2026-07-28 13:59:29` |
| `status` | Texte contrôlé | Oui | Automatique | Résultat global de l’exécution. | `SUCCESS`, `PARTIAL`, `ERROR` |
| `sources_checked` | Entier | Oui | Automatique | Nombre de sources actives contrôlées. | `3` |
| `items_found` | Entier | Oui | Automatique | Nombre total d’éléments détectés dans les flux. | `30` |
| `items_added` | Entier | Oui | Automatique | Nombre de nouvelles lignes ajoutées après déduplication. | `0` |
| `message` | Texte | Oui | Automatique | Message de synthèse ou détail concis des erreurs rencontrées. | `Collecte terminée sans erreur.` |

## Interprétation des statuts

| Statut | Signification |
|---|---|
| `SUCCESS` | Toutes les sources ont été traitées sans erreur. |
| `PARTIAL` | Au moins une source a échoué, mais les autres ont été traitées. |
| `ERROR` | L’exécution globale a échoué ou aucune source n’a pu être traitée. |

## Exemple de preuve de déduplication

| `status` | `sources_checked` | `items_found` | `items_added` |
|---|---:|---:|---:|
| `SUCCESS` | 3 | 30 | 30 |
| `SUCCESS` | 3 | 30 | 0 |

La seconde ligne montre que les mêmes publications ont été retrouvées, mais qu’aucun doublon n’a été inséré.

---

# 5. Champs calculés utilisés dans Tableau

Ces champs n’existent pas nécessairement dans Google Sheets. Ils sont créés dans Tableau pour faciliter l’affichage.

| Champ calculé | Type | Rôle |
|---|---|---|
| `Statut affiché` | Texte | Remplace un statut vide par `Non classé`. |
| `Pertinence affichée` | Texte | Remplace une pertinence vide par `Non évaluée`. |
| `Revue affichée` | Texte | Transforme le booléen `reviewed` en `Revu` ou `Non revu`. |
| `Nombre revu` | Entier | Vaut `1` si `reviewed = TRUE`, sinon `0`. |
| `Dernière collecte` | Date et heure agrégée | Affiche la valeur maximale de `fetched_at`. |
| `Source courte` | Texte | Simplifie les noms de sources pour les graphiques et filtres. |

## Formules Tableau

### `Statut affiché`

```tableau
IF ISNULL([status]) OR TRIM([status]) = "" THEN
    "Non classé"
ELSE
    [status]
END
```

### `Pertinence affichée`

```tableau
IF ISNULL([relevance]) OR TRIM([relevance]) = "" THEN
    "Non évaluée"
ELSE
    [relevance]
END
```

### `Revue affichée`

```tableau
IF [reviewed] THEN
    "Revu"
ELSE
    "Non revu"
END
```

### `Nombre revu`

```tableau
IF [reviewed] THEN
    1
ELSE
    0
END
```

### `Dernière collecte`

```tableau
MAX([fetched_at])
```

### `Source courte`

```tableau
CASE [source_name]
WHEN "Great Expectations Releases" THEN "Great Expectations"
WHEN "Pandera Releases" THEN "Pandera"
WHEN "scikit-learn Releases" THEN "scikit-learn"
ELSE [source_name]
END
```

---

# 6. Séparation entre automatisation et jugement humain

Le système automatise :

- la lecture des sources ;
- le parsing Atom ;
- la normalisation ;
- la déduplication ;
- l’écriture dans Google Sheets ;
- la journalisation ;
- l’actualisation quotidienne ;
- la visualisation dans Tableau Public.

Le système n’automatise pas la décision professionnelle finale.

Les champs suivants restent volontairement humains :

- `status` ;
- `relevance` ;
- `project_impact` ;
- `reviewed`.

Cette séparation permet d’éviter de présenter une classification automatique comme une conclusion fiable sans revue humaine.

---

# 7. Données publiques et sécurité

- Le Google Sheet reste dans Google Drive.
- Le dépôt GitHub contient le code et la documentation, pas le classeur vivant.
- Le dashboard Tableau Public et ses données publiées sont publics.
- Aucun mot de passe, jeton, clé API, adresse privée ou donnée confidentielle ne doit apparaître dans `items`.
- Les onglets `sources` et `run_log` ne sont pas nécessaires dans la source Tableau.
- Les URLs externes autorisées sont limitées dans `Code.gs` et `appsscript.json`.
- Les textes externes sont nettoyés avant écriture afin de limiter le risque d’injection de formule dans Google Sheets.
