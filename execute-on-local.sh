#! /bin/bash

# Build docker image
docker build -t prerender-jobs-local .

# Run docker container
docker run --env-file=.env.local prerender-jobs-local