FROM oven/bun:1.3.14

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client sudo \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 rika-executor \
  && useradd --uid 10001 --gid rika-executor --create-home --shell /bin/sh rika-executor \
  && groupadd --gid 10002 rika-workspace \
  && useradd --uid 10002 --gid rika-workspace --create-home --shell /bin/sh rika-workspace \
  && printf 'Defaults:rika-executor env_reset\nrika-executor ALL=(rika-workspace) NOPASSWD: ALL\n' > /etc/sudoers.d/rika-workspace \
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

# E2B executes the start command once while validating the template without
# assignment environment. These non-secret, non-authoritative defaults let the
# host expose loopback readiness and wait for bootstrap. Runtime provisioning
# overrides every value with the exact assignment fence.
ENV RIKA_EXECUTOR_TARGET=e2b \
  RIKA_EXECUTOR_ASSIGNMENT_ID=template-readiness \
  RIKA_EXECUTOR_GENERATION=1 \
  RIKA_EXECUTOR_ID=template-readiness:g1 \
  RIKA_EXECUTOR_TEMPLATE_BUILD_ID=template-readiness \
  RIKA_EXECUTOR_CONTROLLER_URL=ws://127.0.0.1:1 \
  RIKA_EXECUTOR_WORKSPACE=/workspace \
  RIKA_CHECKPOINT_OBJECT_PREFIX=assignments/template-readiness/g1/

USER rika-executor
EXPOSE 7070
CMD ["/opt/rika/start.sh"]
