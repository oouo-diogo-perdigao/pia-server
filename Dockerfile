FROM node:24-bookworm-slim AS node-runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg zip tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=node-runtime /app/node_modules ./node_modules
COPY package.json ./
COPY vendor/pia-podcast/requirements.txt /tmp/podcast-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/podcast-requirements.txt
COPY vendor/pia-podcast /opt/pia-podcast
ENV PIA_PODCAST_ROOT=/opt/pia-podcast PIA_PODCAST_PYTHON=/usr/local/bin/python3 \
    PYTHONDONTWRITEBYTECODE=1 PIA_DATA=/data PORT=8787
RUN mkdir -p /data && chown node:node /data
USER node
RUN PYTHONPATH=/opt/pia-podcast/Plugins/Apps/podcast_automation/src:/opt/pia-podcast \
    python3 -c "from podcast_automation.server_worker import run_cli; import boto3, mutagen"
COPY src ./src
COPY web ./web
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
