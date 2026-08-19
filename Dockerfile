# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim AS runtime
ARG KUBECTL_VERSION=v1.36.3
ARG TARGETARCH
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/agent
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium curl gosu iputils-ping sudo \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && printf 'Types: deb\nURIs: https://download.docker.com/linux/debian\nSuites: bookworm\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-buildx-plugin docker-ce-cli docker-compose-plugin \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /tmp/kubectl \
    && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && printf '%s  %s\n' "$(cat /tmp/kubectl.sha256)" /tmp/kubectl | sha256sum --check --strict \
    && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl \
    && kubectl version --client=true \
    && rm -f /tmp/kubectl /tmp/kubectl.sha256 \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/* \
    && usermod --login agent --home /home/agent --move-home node \
    && groupmod --new-name agent node
COPY --from=ghcr.io/astral-sh/uv:0.11.31 /uv /uvx /usr/local/bin/
COPY --from=deps --chown=agent:agent /app/node_modules ./node_modules
COPY --chown=agent:agent package.json ./package.json
COPY --chown=agent:agent dist ./dist
COPY --chown=agent:agent assets ./assets
COPY --chmod=440 agent.sudoers /etc/sudoers.d/agent
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN visudo --check --file=/etc/sudoers.d/agent \
    && mkdir -p data \
    && chown agent:agent data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
