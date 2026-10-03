#!/usr/bin/env bash
# Copy the publishable static site into dist/ (keeps worker/, tests/, shots/,
# node_modules and docs out of the Pages upload). No build step.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
cp index.html sections.html styles.css app.js scene.js room.js obs.js boom.js contcam.js \
   _headers _redirects robots.txt sitemap.xml dist/
cp -R assets brand studio live viewer dist/
echo "staged $(find dist -type f | wc -l) files in dist/"
