#! /bin/bash

set -e

PROJECT="seotools01"
REGION="us-east1"

gcloud run jobs replace cloudrun-job.yaml --project $PROJECT --region $REGION