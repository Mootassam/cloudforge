'use strict';
// Generates a ready-to-use GitHub Actions workflow for a project. Chosen model:
// Docker + build-on-GitHub → push image to GHCR (GitHub's private registry) →
// SSH to the customer VPS and restart with the new image. The small VPS never
// builds anything.

function deployWorkflow({ branch } = {}) {
  const b = branch || 'main';
  // NOTE: every GitHub expression below is written \${{ ... }} so JavaScript's
  // own ${ } interpolation leaves it alone — it lands in the file as ${{ ... }}.
  return `# CloudForge auto-deploy — generated for you.
# On every push to "${b}" this will:
#   1) build your app into a Docker image ON GITHUB (free, powerful),
#   2) store it in GitHub's PRIVATE registry (GHCR),
#   3) SSH into the customer VPS and restart with the new image.
#
# ===== ONE-TIME SETUP =====
# In this repo: Settings → Secrets and variables → Actions → "New repository secret"
#   VPS_HOST      server IP or hostname
#   VPS_USER      SSH username (e.g. root)
#   VPS_SSH_KEY   the PRIVATE SSH key that logs into the VPS
#   VPS_PORT      SSH port (use 22 if unsure)
#   VPS_PATH      folder on the VPS that holds docker-compose.yml
#   GHCR_TOKEN    a GitHub token with "read:packages" (lets the VPS pull the image)
#
# Your docker-compose.yml on the VPS should pull the image instead of building, e.g.:
#   services:
#     app:
#       image: ghcr.io/OWNER/REPO:latest
name: CloudForge Build & Deploy

on:
  push:
    branches: ["${b}"]
  workflow_dispatch: {}

concurrency:
  group: cloudforge-deploy
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      # Builds the Docker image from the Dockerfile in your repo and pushes it.
      # (Multiple services? Duplicate this step per Dockerfile with its own tag.)
      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/\${{ github.repository }}:latest

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to the VPS over SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: \${{ secrets.VPS_HOST }}
          username: \${{ secrets.VPS_USER }}
          key: \${{ secrets.VPS_SSH_KEY }}
          port: \${{ secrets.VPS_PORT }}
          script: |
            echo "\${{ secrets.GHCR_TOKEN }}" | docker login ghcr.io -u \${{ github.actor }} --password-stdin
            cd \${{ secrets.VPS_PATH }}
            docker compose pull
            docker compose up -d
`;
}

module.exports = { deployWorkflow };
