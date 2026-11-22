# NME's Paperclip image: the stock upstream image plus Chromium and fonts, so agents (running as
# `node`, without root) can take screenshots. Nothing else differs from upstream: our additions
# to Paperclip live in NME-IaC (plugins, start-time patches), not here.
#
# Upgrade: bump BASE (tag and digest together), then push the tag nme/v<upstream version>-nme.<n>.
# The workflow refuses a tag whose version does not match BASE.
ARG BASE=ghcr.io/paperclipai/paperclip:2026.1117.0@sha256:bdf38d10544dc6c831e16dc027f23ad586353ef3be1a1b2c6979e63b956aceb1
FROM ${BASE}
# The base runs as root (its entrypoint drops to `node`), so apt works and USER stays unchanged.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
