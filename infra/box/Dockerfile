FROM debian:12.15-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

USER root
RUN export DEBIAN_FRONTEND=noninteractive \
  && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20260906T000000Z bookworm main' > /etc/apt/sources.list \
  && echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20260906T000000Z bookworm-security main' >> /etc/apt/sources.list \
  && rm -f /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1000 --create-home --shell /bin/bash user

COPY --from=box-executor-artifacts . /opt/rika-artifacts
COPY infra/box/install.sh infra/box/doctor.sh /opt/rika-template/
RUN chmod 0555 /opt/rika-template/install.sh /opt/rika-template/doctor.sh \
  && /opt/rika-template/install.sh /opt/rika-artifacts \
  && rm -rf /opt/rika-artifacts

USER user
WORKDIR /home/user/workspace
CMD ["/bin/bash"]
