FROM debian:12

ARG BUN_VERSION=1.3.14
ARG PNPM_VERSION=11.10.0
ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/opt/bun
ENV COREPACK_HOME=/opt/corepack
ENV PATH="/opt/rika/bin:/usr/local/bin:/opt/bun/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git tmux ripgrep jq unzip openssh-client gnupg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs gh \
  && mkdir -p /opt/bun /opt/corepack \
  && corepack enable --install-directory /usr/local/bin pnpm \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
  && curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise MISE_INSTALL_HELP=0 MISE_INSTALL_MUSL=1 sh \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
  && ln -sf /opt/bun/bin/bunx /usr/local/bin/bunx \
  && (id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user) \
  && mkdir -p /opt/rika/bin /opt/rika/share/rika /home/user/repo \
  && printf 'new-session -A -s rika\n' > /home/user/.tmux.conf \
  && chmod -R a+rx /opt/bun \
  && chown -R user:user /home/user /opt/corepack \
  && rm -rf /var/lib/apt/lists/*

COPY .build/rika/bin/rika /opt/rika/bin/rika
COPY .build/rika/share/ /opt/rika/share/rika/

RUN chmod +x /opt/rika/bin/rika \
  && ln -sf /opt/rika/bin/rika /usr/local/bin/rika

WORKDIR /home/user/repo
USER user
