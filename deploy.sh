#! /bin/bash

# Manual deploy. Builds the image once and updates BOTH Cloud Run Jobs
# (prerender-jobs in us-east1 and prerender-jobs-enterprise in us-central1),
# same as the Cloud Build trigger that runs on every push to main.

set -e

PROJECT="seotools01"

gcloud builds submit . --project "$PROJECT"
