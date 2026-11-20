# NME's Paperclip image: the stock upstream image plus Chromium and fonts, so agents (running as
# `node`, without root) can take screenshots. Nothing else differs from upstream: our additions
# to Paperclip live in NME-IaC (plugins, start-time patches), not here.
#
# Upgrade: bump BASE (tag and digest together), then push the tag nme/v<upstream version>-nme.<n>.
# The workflow refuses a tag whose version does not match BASE.
ARG BASE=ghcr.io/paperclipai/paperclip:2026.1023.0@sha256:40f46940c4612ead131aebe6079cd4651f8cd1434af49f7c621887f4a452a62e
FROM ${BASE}
# The base runs as root (its entrypoint drops to `node`), so apt works and USER stays unchanged.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
