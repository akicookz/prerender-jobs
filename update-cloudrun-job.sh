#! /bin/bash

set -e

PROJECT="seotools01"
REGION="${REGION:-us-east1}"
JOB_NAME="${JOB_NAME:-prerender-jobs}"

# cloudrun-job.yaml references ${REGION} and ${JOB_NAME}; expand only those before applying.
TMP_SPEC="$(mktemp)"
trap 'rm -f "$TMP_SPEC"' EXIT
REGION="$REGION" JOB_NAME="$JOB_NAME" envsubst '${REGION} ${JOB_NAME}' < cloudrun-job.yaml > "$TMP_SPEC"

gcloud run jobs replace "$TMP_SPEC" --project $PROJECT --region $REGION