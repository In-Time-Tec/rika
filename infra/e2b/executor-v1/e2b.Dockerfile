FROM debian:12.15-slim@sha256:362e64223cc0da95422b3b13c045186fc0a81250e765d31c025fbddf257f6143

ARG BUN_VERSION=1.4.0
ARG BUN_SHA256=2d03fb5fb83ac8b567aca0a281b2ce1a1a19d488f56c2968d88c3f25e92fe452
ARG CHROMIUM_VERSION=152.0.7977.54
ARG CHROMIUM_SHA256=88af83664e1e5f79dc1c1378d0699b98dddd69690a748addf4ccbe322bfacedf
ARG NODE_VERSION=24.19.0
ARG NODE_SHA256=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647
ARG YQ_VERSION=4.53.6
ARG YQ_SHA256=c5f056448f973ae7d39b5401949648a78f2dc1947d6a8eb65be60d5c504b9385
ARG WEBSOCAT_VERSION=1.14.0
ARG WEBSOCAT_SHA256=33a80fcbf2313e3c6e816ddafec333c1a04cc34464d4ba4970d938275775a12f
ARG AGENT_BROWSER_VERSION=0.34.0
ARG COREPACK_VERSION=0.35.0
ARG NPM_VERSION=12.0.2
ARG NPM_BRACE_EXPANSION_VERSION=5.0.9
ARG NPM_IP_ADDRESS_VERSION=10.5.0
ARG NPM_TAR_VERSION=7.5.21
ARG PNPM_VERSION=11.22.0
ARG YARN_VERSION=1.22.22
ARG PILLOW_VERSION=12.3.0
ARG SETUPTOOLS_VERSION=84.0.0

USER root
RUN export DEBIAN_FRONTEND=noninteractive \
  && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260902T083340Z bookworm main' > /etc/apt/sources.list \
  && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260902T083340Z bookworm-security main' >> /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash=5.2.15-2+b13 build-essential=12.9 ca-certificates=20250419~deb12u1 cmake=3.25.1-1 \
    curl=7.88.1-10+deb12u15 dnsutils=1:9.18.49-1~deb12u2 fd-find=8.6.0-3 \
    ffmpeg=7:5.1.9-0+deb12u1 file=1:5.44-3 findutils=4.9.0-4 \
    fonts-liberation=1:1.07.4-11 fzf=0.38.0-1+b1 \
    g++=4:12.2.0-3 gcc=4:12.2.0-3 gh=2.23.0+dfsg1-1 \
    git=1:2.39.5-0+deb12u3 git-lfs=3.3.0-1+deb12u1 \
    imagemagick=8:6.9.11.60+dfsg-1.6+deb12u13 iproute2=6.1.0-3 jq=1.6-2.1+deb12u2 \
    less=590-2.1~deb12u2 libasound2=1.2.8-1+b1 libatk-bridge2.0-0=2.46.0-5 \
    libatk1.0-0=2.46.0-5 libatspi2.0-0=2.46.0-5 libc6=2.36-9+deb12u14 \
    libcairo2=1.16.0-7 libcups2=2.4.2-3+deb12u9 libdbus-1-3=1.14.10-1~deb12u1 \
    libexpat1=2.5.0-1+deb12u3 libgbm1=22.3.6-1+deb12u2 libglib2.0-0=2.74.6-2+deb12u9 \
    libgtk-3-0=3.24.38-2~deb12u3 libnspr4=2:4.35-1 libnss3=2:3.87.1-1+deb12u4 \
    libpango-1.0-0=1.50.12+ds-1 libsecret-1-0=0.20.5-3 libudev1=252.39-1~deb12u2 libvulkan1=1.3.239.0-1 \
    libx11-6=2:1.8.4-2+deb12u2 libxcb1=1.15-1 libxcomposite1=1:0.4.5-1 \
    libxdamage1=1:1.1.6-1 libxext6=2:1.3.4-1+b1 libxfixes3=1:6.0.0-2 \
    libxkbcommon0=1.5.0-1 libxrandr2=2:1.5.2-2+b1 \
    locales=2.36-9+deb12u14 lsof=4.95.0-1 make=4.3-4.1 \
    netcat-openbsd=1.219-1 ninja-build=1.11.1-2~deb12u1 openssh-client=1:9.2p1-2+deb12u10 \
    pkg-config=1.8.1-1 procps=2:4.0.2-3 psmisc=23.6-1 \
    python3=3.11.2-1+b1 python3-pip=23.0.1+dfsg-1 python3-venv=3.11.2-1+b1 \
    redis-tools=5:7.0.15-1~deb12u9 ripgrep=13.0.0-4+b2 sqlite3=3.40.1-2+deb12u2 \
    postgresql-client=15+248+deb12u1 sudo=1.9.13p3-1+deb12u4 tar=1.34+dfsg-1.2+deb12u1 \
    tmux=3.3a-3 tree=2.1.0-1 tzdata=2026b-0+deb12u1 util-linux=2.38.1-5+deb12u3 \
    vim=2:9.0.1378-2+deb12u2 unzip=6.0-28+deb12u1 wget=1.21.3-1+deb12u1 \
    xdg-utils=1.1.3-4.1 xz-utils=5.4.1-1+deb12u1 zip=3.0-13 zstd=1.5.4+dfsg2-5 \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i 's/^# en_US.UTF-8 UTF-8$/en_US.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
  && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
  && ln -s bun /usr/local/bin/bunx \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o /tmp/chromium.zip "https://storage.googleapis.com/chrome-for-testing-public/${CHROMIUM_VERSION}/linux64/chrome-linux64.zip" \
  && echo "${CHROMIUM_SHA256}  /tmp/chromium.zip" | sha256sum -c - \
  && unzip -q /tmp/chromium.zip -d /opt/chromium && ln -s /opt/chromium/chrome-linux64/chrome /usr/local/bin/chromium \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
  && npm install --global "agent-browser@${AGENT_BROWSER_VERSION}" "corepack@${COREPACK_VERSION}" \
  && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" --activate \
  && npm install --global "npm@${NPM_VERSION}" \
  && npm install --global "brace-expansion@${NPM_BRACE_EXPANSION_VERSION}" "ip-address@${NPM_IP_ADDRESS_VERSION}" "tar@${NPM_TAR_VERSION}" \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion /usr/local/lib/node_modules/npm/node_modules/ip-address /usr/local/lib/node_modules/npm/node_modules/tar \
  && mv /usr/local/lib/node_modules/brace-expansion /usr/local/lib/node_modules/ip-address /usr/local/lib/node_modules/tar /usr/local/lib/node_modules/npm/node_modules/ \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
  && echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/yq \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o /tmp/websocat "https://github.com/vi/websocat/releases/download/v${WEBSOCAT_VERSION}/websocat.x86_64-unknown-linux-musl" \
  && echo "${WEBSOCAT_SHA256}  /tmp/websocat" | sha256sum -c - \
  && install -m 0755 /tmp/websocat /usr/local/bin/websocat \
  && python3 -m venv /opt/rika-python \
  && /opt/rika-python/bin/pip install --no-cache-dir "Pillow==${PILLOW_VERSION}" "setuptools==${SETUPTOOLS_VERSION}" \
  && ln -s /opt/rika-python/bin/pip /usr/local/bin/pip \
  && ln -s /opt/rika-python/bin/python /usr/local/bin/python \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /tmp/* /root/.npm \
  && groupadd --gid 10001 rika-executor \
  && useradd --uid 10001 --gid rika-executor --create-home --shell /bin/bash rika-executor \
  && groupadd --gid 10002 rika-workspace \
  && useradd --uid 10002 --gid rika-workspace --create-home --shell /bin/bash rika-workspace \
  && usermod --append --groups rika-workspace rika-executor \
  && echo 'Defaults:rika-executor env_reset' > /etc/sudoers.d/rika-workspace \
  && echo 'rika-executor ALL=(rika-workspace) NOPASSWD: ALL' >> /etc/sudoers.d/rika-workspace \
  && chmod 0440 /etc/sudoers.d/rika-workspace \
  && echo 'rika-executor ALL=(root) NOPASSWD: /usr/bin/install -d -m 2750 -o rika-executor -g rika-workspace /run/rika' > /etc/sudoers.d/rika-runtime \
  && chmod 0440 /etc/sudoers.d/rika-runtime \
  && install -d -m 0700 -o rika-executor -g rika-executor /var/lib/rika-executor \
  && install -d -m 2750 -o rika-executor -g rika-workspace /run/rika \
  && install -d -m 0750 -o rika-workspace -g rika-workspace /home/rika-workspace/workspace
RUN npm install --global --force "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
  && pnpm --version \
  && yarn --version

WORKDIR /opt/rika
COPY package.json bun.lock ./
COPY packages/configuration ./packages/configuration
COPY packages/credential-vault ./packages/credential-vault
COPY packages/e2b-executor ./packages/e2b-executor
COPY packages/execution ./packages/execution
COPY packages/extensions ./packages/extensions
COPY packages/github-app ./packages/github-app
COPY packages/identity ./packages/identity
COPY packages/product ./packages/product
COPY packages/product-store ./packages/product-store
COPY packages/remote-execution ./packages/remote-execution
COPY packages/terminal ./packages/terminal
COPY packages/transcript ./packages/transcript
COPY apps/api ./apps/api
COPY apps/proxy ./apps/proxy
COPY apps/rika ./apps/rika
COPY apps/web ./apps/web
RUN bun install --production --frozen-lockfile --ignore-scripts \
  && test -f node_modules/generalist/package.json \
  && rm -rf node_modules/.bun/@typescript+typescript-* /root/.bun
COPY infra/e2b/executor-v1/start.sh ./start.sh
COPY infra/e2b/executor-v1/tool-manifest.json ./tool-manifest.json
COPY infra/e2b/executor-v1/doctor.ts ./doctor.ts
COPY infra/e2b/executor-v1/rika ./rika
RUN chmod 0555 /opt/rika/start.sh /opt/rika/rika \
  && ln -s /opt/rika/rika /usr/local/bin/rika \
  && chown -R root:rika-workspace /opt/rika \
  && chmod -R u=rwX,g=rX,o= /opt/rika \
  && sudo -n -u rika-workspace -- test -w /home/rika-workspace/workspace

ENV HOME=/home/rika-executor \
  LANG=en_US.UTF-8 \
  PATH=/run/rika/bin:/opt/rika-python/bin:/usr/local/bin:/usr/bin:/bin \
  GH_CONFIG_DIR=/run/rika/gh \
  RIKA_IMAGE_MANIFEST=/opt/rika/tool-manifest.json \
  RIKA_EXECUTOR_TARGET=orb \
  RIKA_EXECUTOR_ASSIGNMENT_ID=template-readiness \
  RIKA_EXECUTOR_GENERATION=1 \
  RIKA_EXECUTOR_ID=template-readiness:g1 \
  RIKA_EXECUTOR_TEMPLATE_BUILD_ID=template-readiness \
  RIKA_EXECUTOR_API_URL=ws://127.0.0.1:1 \
  RIKA_EXECUTOR_WORKSPACE_ID=template-readiness \
  RIKA_EXECUTOR_OWNER_ID=template-readiness \
  RIKA_EXECUTOR_THREAD_ID=template-readiness \
  RIKA_EXECUTOR_ENVIRONMENT_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000 \
  RIKA_EXECUTOR_SETUP_CACHE=0 \
  RIKA_EXECUTOR_WORKSPACE=/home/rika-workspace/workspace/repo \
  RIKA_CHECKPOINT_OBJECT_PREFIX=assignments/template-readiness/g1/

USER rika-executor
EXPOSE 7070
CMD ["/opt/rika/start.sh"]
