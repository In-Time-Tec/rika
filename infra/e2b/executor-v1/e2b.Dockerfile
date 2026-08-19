FROM oven/bun:1.3.14

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client sudo \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 rika-executor \
  && useradd --uid 10001 --gid rika-executor --create-home --shell /bin/sh rika-executor \
  && groupadd --gid 10002 rika-workspace \
  && useradd --uid 10002 --gid rika-workspace --create-home --shell /bin/sh rika-workspace \
  && printf 'rika-executor ALL=(rika-workspace) NOPASSWD: ALL\n' > /etc/sudoers.d/rika-workspace \
  && chmod 0440 /etc/sudoers.d/rika-workspace \
  && install -d -m 0700 -o rika-executor -g rika-executor /var/lib/rika-executor \
  && install -d -m 0750 -o rika-workspace -g rika-workspace /workspace

WORKDIR /opt/rika
COPY infra/e2b/executor-v1/package.json ./package.json
RUN bun install --production
COPY packages/remote-execution/src ./src
COPY infra/e2b/executor-v1/start.sh ./start.sh
RUN chmod 0555 /opt/rika/start.sh \
  && chown -R root:rika-executor /opt/rika \
  && chmod -R u=rwX,g=rX,o= /opt/rika

USER rika-executor
EXPOSE 7070
CMD ["/opt/rika/start.sh"]
