#!/usr/bin/env bash
# Prépare le compte Cloudflare avant `wrangler deploy` (idempotent) :
#   1. vérifie (ou crée) le sous-domaine workers.dev du compte
#   2. trouve le namespace KV par son nom, le crée s'il n'existe pas
#   3. injecte son ID dans wrangler.jsonc
# Le Worker lui-même est créé ou mis à jour par `wrangler deploy`.
#
# Variables requises : CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# Optionnelles      : KV_TITLE (défaut model-release-watch-state),
#                     WORKERS_SUBDOMAIN (utilisé seulement si le compte n'a pas encore de sous-domaine)
# Sorties (GITHUB_OUTPUT) : kv_id, kv_created, workers_subdomain
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN manquant}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID manquant}"
KV_TITLE="${KV_TITLE:-model-release-watch-state}"
CONFIG="${CONFIG:-wrangler.jsonc}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}"
OUT="${GITHUB_OUTPUT:-/dev/null}"

cf() { # cf METHOD PATH [JSON]
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" "${API}${path}" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")
  [[ -n "$body" ]] && args+=(--data "$body")
  curl "${args[@]}"
}

fail() { echo "::error::$*" >&2; exit 1; }

# --- 1. Sous-domaine workers.dev (nécessaire pour /health et /run) ---
sub_json=$(cf GET /workers/subdomain)
subdomain=$(jq -r '.result.subdomain // empty' <<<"$sub_json")
if [[ -z "$subdomain" ]]; then
  if [[ -n "${WORKERS_SUBDOMAIN:-}" ]]; then
    echo "Aucun sous-domaine workers.dev : création de « ${WORKERS_SUBDOMAIN} »"
    res=$(cf PUT /workers/subdomain "$(jq -nc --arg s "$WORKERS_SUBDOMAIN" '{subdomain:$s}')")
    [[ $(jq -r '.success' <<<"$res") == "true" ]] || fail "Création du sous-domaine impossible : $(jq -c '.errors' <<<"$res")"
    subdomain="$WORKERS_SUBDOMAIN"
  else
    fail "Le compte n'a pas de sous-domaine workers.dev. Définissez la variable GitHub WORKERS_SUBDOMAIN ou choisissez-en un dans le dashboard (Workers & Pages). Réponse API : $(jq -c '.errors' <<<"$sub_json")"
  fi
fi
echo "Sous-domaine workers.dev : ${subdomain}"

# --- 2. Namespace KV ---
kv_id=""
page=1
while :; do
  res=$(cf GET "/storage/kv/namespaces?per_page=100&page=${page}")
  [[ $(jq -r '.success' <<<"$res") == "true" ]] || fail "Liste des namespaces KV impossible : $(jq -c '.errors' <<<"$res")"
  kv_id=$(jq -r --arg t "$KV_TITLE" '.result[] | select(.title == $t) | .id' <<<"$res" | head -n1)
  [[ -n "$kv_id" ]] && break
  total_pages=$(jq -r '.result_info.total_pages // 1' <<<"$res")
  (( page >= total_pages )) && break
  page=$((page + 1))
done

kv_created=false
if [[ -z "$kv_id" ]]; then
  echo "Namespace KV « ${KV_TITLE} » absent : création"
  res=$(cf POST /storage/kv/namespaces "$(jq -nc --arg t "$KV_TITLE" '{title:$t}')")
  [[ $(jq -r '.success' <<<"$res") == "true" ]] || fail "Création du namespace KV impossible : $(jq -c '.errors' <<<"$res")"
  kv_id=$(jq -r '.result.id' <<<"$res")
  kv_created=true
else
  echo "Namespace KV « ${KV_TITLE} » existant : ${kv_id}"
fi

# --- 3. Injection dans la config ---
grep -q '__KV_NAMESPACE_ID__' "$CONFIG" || fail "Placeholder __KV_NAMESPACE_ID__ introuvable dans ${CONFIG}"
sed -i "s/__KV_NAMESPACE_ID__/${kv_id}/" "$CONFIG"

{
  echo "kv_id=${kv_id}"
  echo "kv_created=${kv_created}"
  echo "workers_subdomain=${subdomain}"
} >>"$OUT"
