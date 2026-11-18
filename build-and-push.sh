#!/bin/bash
set -e

IMAGE="registry.gian.ink/guesswho:latest"
REGISTRY_USER="${DOCKER_USER:-deploy}"
REGISTRY_PASS="${DOCKER_PASS:-}"

if [ -z "$REGISTRY_PASS" ] && [ -f .env ]; then
  REGISTRY_PASS=$(grep -E "^REGISTRY_PASS=" .env | cut -d= -f2-)
fi

if [ -z "$REGISTRY_PASS" ]; then
  REGISTRY_PASS="dockerpass"
fi

if command -v docker >/dev/null 2>&1; then
  echo "==> Logging into registry.gian.ink..."
  echo "$REGISTRY_PASS" | docker login registry.gian.ink -u "$REGISTRY_USER" --password-stdin

  echo "==> Building Docker image: $IMAGE..."
  docker build -t "$IMAGE" .

  echo "==> Pushing image to registry.gian.ink..."
  docker push "$IMAGE"
else
  echo "==> Streaming source to gian.ink and building remotely..."
  tar --exclude='node_modules' --exclude='.git' -czf - -C /home/gian/Apps/guesswho . | \
    ssh gian.ink "mkdir -p ~/docker-inf/guesswho && tar -xzf - -C ~/docker-inf/guesswho && cd ~/docker-inf/guesswho && echo '$REGISTRY_PASS' | docker login registry.gian.ink -u '$REGISTRY_USER' --password-stdin && docker build -t $IMAGE . && docker push $IMAGE && docker compose up -d"
fi

echo "==> Successfully built and deployed $IMAGE!"
