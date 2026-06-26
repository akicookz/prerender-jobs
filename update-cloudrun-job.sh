#! /bin/bash

set -e

PROJECT="seotools01"
REGION="${REGION:-us-east1}"

# cloudrun-job.yaml references ${REGION}; expand it (only that var) before applying.
TMP_SPEC="$(mktemp)"
trap 'rm -f "$TMP_SPEC"' EXIT
REGION="$REGION" envsubst '${REGION}' < cloudrun-job.yaml > "$TMP_SPEC"

gcloud run jobs replace "$TMP_SPEC" --project $PROJECT --region $REGION