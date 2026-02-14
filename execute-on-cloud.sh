#!/bin/bash

set -e

JOB_NAME="prerender-jobs"
REGION="us-east1"
PROJECT="seotools01"

# Read ../.env.production and prepare env overload
ENV_PAIRS=()

while IFS= read -r line; do
  # Skip comments and empty lines
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue

  # Split on first '=' only
  key="${line%%=*}"
  value="${line#*=}"

  # Strip surrounding quotes (single or double)
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"

  ENV_PAIRS+=("$key=$value")
done < .env.production

# Join with | as delimiter
JOINED=$(IFS='|'; echo "${ENV_PAIRS[*]}")

echo "ENVS: $JOINED"

# Execute job with env overload
gcloud run jobs execute "$JOB_NAME" \
	--project="$PROJECT" \
  --region "$REGION" \
  --update-env-vars "^|^$JOINED"