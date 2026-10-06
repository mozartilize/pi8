FROM docker.io/library/rust:1-slim-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates cmake make \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /cache/cargo /cache/target
