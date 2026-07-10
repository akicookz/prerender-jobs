#! /bin/bash

# Build docker image
# linux/amd64 is required: Chrome for Testing has no linux-arm64 build, so a
# native arm64 build on Apple Silicon fails at the chrome install step.
docker build --platform linux/amd64 -t prerender-jobs-local .

# Run docker container
# ./snapshots is bind-mounted onto OUTPUT_DIR (/app/snapshots in .env.local)
# so each run's prerendered snapshots land on the host in snapshots/run-<ts>/.
mkdir -p snapshots
docker run --rm \
  --platform linux/amd64 \
  --env-file=.env.local \
  -v "$(pwd)/snapshots:/app/snapshots" \
  prerender-jobs-local
