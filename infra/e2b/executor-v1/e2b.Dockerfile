FROM debian:12.11-slim@sha256:cea2634840f5a87503d8210e4df97b9f23a2acd67ff860a76c133d963032f866

ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG NODE_VERSION=24.15.0
ARG NODE_SHA256=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
ARG YQ_VERSION=4.47.1
ARG YQ_SHA256=0fb28c6680193c41b364193d0c0fc4a03177aecde51cfc04d506b1517158c2fb
ARG WEBSOCAT_VERSION=1.14.0
ARG WEBSOCAT_SHA256=33a80fcbf2313e3c6e816ddafec333c1a04cc34464d4ba4970d938275775a12f
ARG AGENT_BROWSER_VERSION=0.34.0
ARG COREPACK_VERSION=0.35.0
ARG PNPM_VERSION=11.22.0
ARG YARN_VERSION=1.22.22
ARG PILLOW_VERSION=11.3.0

USER root
RUN export DEBIAN_FRONTEND=noninteractive \
  && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20250630T000000Z bookworm main\n' > /etc/apt/sources.list \
  && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20250630T000000Z bookworm-security main\n' >> /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash=5.2.15-2+b8 build-essential=12.9 ca-certificates=20230311 cmake=3.25.1-1 \
    chromium=138.0.7204.49-1~deb12u1 curl=7.88.1-10+deb12u12 \
    dnsutils=1:9.18.33-1~deb12u2 fd-find=8.6.0-3 \
    ffmpeg=7:5.1.6-0+deb12u1 file=1:5.44-3 findutils=4.9.0-4 fzf=0.38.0-1+b1 \
    g++=4:12.2.0-3 gcc=4:12.2.0-3 gh=2.23.0+dfsg1-1 \
    git=1:2.39.5-0+deb12u2 git-lfs=3.3.0-1+deb12u1 \
    imagemagick=8:6.9.11.60+dfsg-1.6+deb12u3 iproute2=6.1.0-3 jq=1.6-2.1 \
    less=590-2.1~deb12u2 locales=2.36-9+deb12u10 lsof=4.95.0-1 make=4.3-4.1 \
    netcat-openbsd=1.219-1 ninja-build=1.11.1-2~deb12u1 openssh-client=1:9.2p1-2+deb12u6 \
    pkg-config=1.8.1-1 procps=2:4.0.2-3 psmisc=23.6-1 \
    python3=3.11.2-1+b1 python3-pip=23.0.1+dfsg-1 python3-venv=3.11.2-1+b1 \
    redis-tools=5:7.0.15-1~deb12u4 ripgrep=13.0.0-4+b2 sqlite3=3.40.1-2+deb12u1 \
    postgresql-client=15+248 sudo=1.9.13p3-1+deb12u1 tar=1.34+dfsg-1.2+deb12u1 \
    tmux=3.3a-3 tree=2.1.0-1 tzdata=2025b-0+deb12u1 util-linux=2.38.1-5+deb12u3 \
    vim=2:9.0.1378-2+deb12u2 unzip=6.0-28 wget=1.21.3-1+deb12u1 \
    xz-utils=5.4.1-1 zip=3.0-13 zstd=1.5.4+dfsg2-5 \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i 's/^# en_US.UTF-8 UTF-8$/en_US.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen \
  && curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
  && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -q /tmp/bun.zip -d /tmp/bun && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
  && ln -s bun /usr/local/bin/bunx \
  && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local \
  && npm install --global "agent-browser@${AGENT_BROWSER_VERSION}" "corepack@${COREPACK_VERSION}" \
  && corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" --activate \
  && curl -fsSLo /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" \
  && echo "${YQ_SHA256}  /usr/local/bin/yq" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/yq \
  && curl -fsSLo /tmp/websocat "https://github.com/vi/websocat/releases/download/v${WEBSOCAT_VERSION}/websocat.x86_64-unknown-linux-musl" \
  && echo "${WEBSOCAT_SHA256}  /tmp/websocat" | sha256sum -c - \
  && install -m 0755 /tmp/websocat /usr/local/bin/websocat \
  && python3 -m venv /opt/rika-python \
  && /opt/rika-python/bin/pip install --no-cache-dir "Pillow==${PILLOW_VERSION}" \
  && ln -s /opt/rika-python/bin/pip /usr/local/bin/pip \
  && ln -s /opt/rika-python/bin/python /usr/local/bin/python \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /tmp/* /root/.npm \
  && groupadd --gid 10001 rika-executor \
  && useradd --uid 10001 --gid rika-executor --create-home --shell /bin/bash rika-executor \
  && groupadd --gid 10002 rika-workspace \
  && useradd --uid 10002 --gid rika-workspace --create-home --shell /bin/bash rika-workspace \
  && usermod --append --groups rika-workspace rika-executor \
  && printf 'Defaults:rika-executor env_reset\nrika-executor ALL=(rika-workspace) NOPASSWD: ALL\n' > /etc/sudoers.d/rika-workspace \
  && chmod 0440 /etc/sudoers.d/rika-workspace \
  && install -d -m 0700 -o rika-executor -g rika-executor /var/lib/rika-executor \
  && install -d -m 2750 -o rika-executor -g rika-workspace /run/rika \
  && install -d -m 0750 -o rika-workspace -g rika-workspace /home/rika-workspace/workspace
RUN npm install --global --force "pnpm@${PNPM_VERSION}" "yarn@${YARN_VERSION}" \
  && pnpm --version \
  && yarn --version

WORKDIR /opt/rika
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --production --frozen-lockfile --ignore-scripts \
  && test -f node_modules/tenetkit/package.json \
  && test -f packages/kernel/src/executor-runtime.ts \
  && bun -e 'import { workerModule } from "tenetkit/repl/bun"; if (!(await Bun.file(workerModule).exists())) process.exit(1)'
COPY infra/e2b/executor-v1/start.sh ./start.sh
COPY infra/e2b/executor-v1/tool-manifest.json ./tool-manifest.json
COPY infra/e2b/executor-v1/doctor.ts ./doctor.ts
COPY infra/e2b/executor-v1/kernel-doctor.ts ./kernel-doctor.ts
COPY infra/e2b/executor-v1/rika ./rika
RUN chmod 0555 /opt/rika/start.sh /opt/rika/rika \
  && ln -s /opt/rika/rika /usr/local/bin/rika \
  && chown -R root:rika-executor /opt/rika \
  && chmod -R u=rwX,g=rX,o= /opt/rika \
  && sudo -n -u rika-workspace -- test -w /home/rika-workspace/workspace

ENV HOME=/home/rika-executor \
  LANG=en_US.UTF-8 \
  PATH=/run/rika/bin:/opt/rika-python/bin:/usr/local/bin:/usr/bin:/bin \
  GH_CONFIG_DIR=/run/rika/gh \
  RIKA_IMAGE_MANIFEST=/opt/rika/tool-manifest.json \
  RIKA_EXECUTOR_TARGET=e2b \
  RIKA_EXECUTOR_ASSIGNMENT_ID=template-readiness \
  RIKA_EXECUTOR_GENERATION=1 \
  RIKA_EXECUTOR_ID=template-readiness:g1 \
  RIKA_EXECUTOR_TEMPLATE_BUILD_ID=template-readiness \
  RIKA_EXECUTOR_API_URL=ws://127.0.0.1:1 \
  RIKA_EXECUTOR_WORKSPACE_ID=template-readiness \
  RIKA_EXECUTOR_WORKSPACE=/home/rika-workspace/workspace/repo \
  RIKA_CHECKPOINT_OBJECT_PREFIX=assignments/template-readiness/g1/

USER rika-executor
EXPOSE 7070
CMD ["/opt/rika/start.sh"]
