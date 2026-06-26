#! /bin/bash

set -e

PROJECT="seotools01"
JOB_NAME="${JOB_NAME:-prerender-jobs}"
REGION="${REGION:-us-east1}"

gcloud builds submit . --substitutions=_REGION="$REGION",_JOB_NAME="$JOB_NAME"