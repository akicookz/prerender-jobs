#! /bin/bash

# Build docker image
docker build -t prerender-jobs-local .

# Make sure the host directory exists
mkdir -p ./offending-html

# Run docker container, mounting the host dir
docker run \
  --env-file=.env.local \
  -v "$(pwd)/offending-html:/mnt/offending-html" \
  prerender-jobs-local