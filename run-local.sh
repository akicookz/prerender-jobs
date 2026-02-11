#! /bin/bash

# Build docker image
docker build -t seotools-test-local .

# Run docker container
docker run --env-file=.env.local seotools-test-local