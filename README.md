# model-release-watch

Un Cloudflare Worker qui surveille les nouveaux modèles publiés sur [ai-tldr.dev](https://ai-tldr.dev/releases/model/) et envoie une notification [ntfy](https://ntfy.sh) pour chacun.

```
Cron Cloudflare (toutes les 2 h, minute 17 UTC)
  └─ Worker
       1. GET https://ai-tldr.dev/releases/model/ (requête conditionnelle par ETag)
          → lit le bloc <script id="feed-boot"> : les 30 derniers modèles, avec leur niveau d'importance
          ↳ en cas d'échec : flux Atom https://ai-tldr.dev/feed.xml filtré sur la catégorie « model »
       2. normalise : slug, nom, éditeur, date, importance, résumé
       3. compare avec les slugs déjà vus (KV)
       4. pour chaque nouveau modèle → POST ntfy (au maximum 10 par passage, synthèse au-delà)
       5. alertes techniques (au plus une par 24 h) : source injoignable, format inattendu, source muette depuis 72 h
```

| Niveau de la release | Priorité ntfy |
|---|---|
| seismic | 5 (urgente) |
| major | 4 (haute) |
| notable / inconnu | 3 (normale) |
| alerte technique | 2 (basse) |

Astuce : dans l'app ntfy, réglez les notifications de priorité 3 en silencieux pour n'être alerté que des sorties majeures.

## Points d'accès

- `GET /health` : état du Worker en JSON (200 si une lecture a réussi dans les 12 dernières heures, 503 sinon). Peut servir à un moniteur externe.
- `POST /run` avec l'en-tête `Authorization: Bearer <RUN_TOKEN>` : lance une vérification tout de suite. Avec `?dry=1`, renvoie les notifications qui seraient envoyées, sans rien envoyer ni écrire.

## Déploiement (GitHub Actions)

Chaque push sur `main` lance les tests, puis le job `deploy` :

1. **`scripts/ensure-kv.sh`** prépare le compte. Il vérifie le sous-domaine workers.dev (et le crée si la variable `WORKERS_SUBDOMAIN` est définie), cherche le namespace KV `model-release-watch-state`, le **crée s'il n'existe pas**, puis injecte son ID dans `wrangler.jsonc`.
2. **`wrangler deploy`** **crée le Worker s'il n'existe pas**, ou le met à jour sinon.
3. **`wrangler secret bulk`** pousse les secrets `NTFY_TOPIC` et `RUN_TOKEN`.
4. **Test de fumée** : appel de `/health`, puis `/run?dry=1`. Le job échoue si la source est injoignable ou si son format est inattendu.
5. **Premier déploiement** (KV tout juste créé) : un vrai `/run` est lancé. Il mémorise les modèles existants sans les notifier et envoie un message « model-release-watch activé ».

Les PR (y compris depuis des forks) ne lancent que le workflow `CI` : typecheck, tests et bundle à blanc. Aucun secret n'y est exposé.

### Mise en place (une seule fois)

1. **Token Cloudflare.** Dans le dashboard : *My Profile → API Tokens → Create Token*, modèle « Edit Cloudflare Workers », limité à votre compte. Au strict minimum, il faut :
   - Account › Workers Scripts : Edit ;
   - Account › Workers KV Storage : Edit ;
   - Account › Account Settings : Read.
2. **Account ID** : visible dans le dashboard, sur la page *Workers & Pages* (colonne de droite).
3. **Topic ntfy et token d'accès** (n'importe qui peut publier sur un topic ntfy.sh qu'il connaît, d'où un nom aléatoire) :
   ```bash
   echo "mrw-$(openssl rand -hex 12)"   # NTFY_TOPIC
   openssl rand -hex 32                 # RUN_TOKEN
   ```
4. **Secrets GitHub** (*Settings → Secrets and variables → Actions → Secrets*) :

   | Secret | Valeur |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | le token de l'étape 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | l'Account ID |
   | `NTFY_TOPIC` | le topic généré |
   | `RUN_TOKEN` | le token généré |

5. **Variable GitHub** (onglet *Variables*, facultatif) : `WORKERS_SUBDOMAIN` est utilisée uniquement si le compte n'a encore jamais eu de sous-domaine workers.dev. Elle donne une URL du type `model-release-watch.<WORKERS_SUBDOMAIN>.workers.dev`.
6. **App ntfy** (iOS, Android ou web) : abonnez-vous au topic sur le serveur `ntfy.sh`.
7. **Push sur `main`**, ou *Actions → Deploy → Run workflow*.

### Relancer à la main

*Actions → Deploy → Run workflow*, en cochant « Lancer une vérification réelle ». Ou :

```bash
curl -X POST "https://model-release-watch.<sous-domaine>.workers.dev/run?dry=1" \
  -H "Authorization: Bearer $RUN_TOKEN" | jq
```

### Repartir de zéro

Supprimez la clé `seen` du namespace KV (dashboard ou `wrangler kv key delete seen --namespace-id …`). Le prochain passage refera un seed.

## Développement local

```bash
npm ci
cp .dev.vars.example .dev.vars   # mettez un topic de test
npm test                         # tests unitaires (Vitest)
npm run dev                      # puis : curl "http://localhost:8787/__scheduled?cron=17+*/2+*+*+*"
```

## Configuration (`wrangler.jsonc` → `vars`)

| Variable | Défaut | Rôle |
|---|---|---|
| `SOURCE_URL` | `https://ai-tldr.dev/releases/model/` | Page dont le HTML embarque le bloc `feed-boot` |
| `FALLBACK_FEED_URL` | `https://ai-tldr.dev/feed.xml` | Flux Atom de secours (sans niveau d'importance) |
| `MAX_NOTIFICATIONS_PER_RUN` | 10 | Au-delà, un seul message de synthèse |
| `STALE_AFTER_HOURS` | 72 | Délai sans nouveau modèle avant l'alerte « source muette » |
| `FAILURES_BEFORE_ALERT` | 3 | Nombre d'échecs de lecture consécutifs avant alerte |

## Limites connues

- **Une seule source**, maintenue par un tiers et alimentée par un agent LLM : erreurs ou doublons possibles, et elle peut s'arrêter. L'alerte « source muette » couvre ce cas.
- **Ni le bloc `feed-boot` ni son format ne sont une API officielle.** Si la page change, le Worker bascule sur le flux Atom et vous prévient (alerte « source principale en échec »). Si les deux échouent, vous recevez une alerte « format » et la CI échoue au test de fumée. Les tests utilisent des extraits réels du 19/10/2026 (`test/fixtures/`).
- Le dépôt GitHub cité par le site (`blackpc/ai-tldr`) n'est pas accessible publiquement : on lit donc le site lui-même.
- Si le site filtre un jour les requêtes venant de Cloudflare Workers (protection anti-bot), le test de fumée de la CI échouera avec `fetch-error`.
- **Quota gratuit Cloudflare** : environ 12 exécutions par jour et 1 à 3 écritures KV par exécution, très loin des limites (100 000 requêtes et 1 000 écritures KV par jour).
