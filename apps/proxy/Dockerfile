FROM docker.io/library/caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

COPY apps/proxy/Caddyfile /etc/caddy/Caddyfile
COPY apps/proxy/entrypoint.sh /usr/local/bin/rika-proxy
RUN caddy fmt --overwrite /etc/caddy/Caddyfile \
  && chmod 755 /usr/local/bin/rika-proxy \
  && addgroup -S rika \
  && adduser -S -G rika rika

EXPOSE 3000
USER rika
ENTRYPOINT ["/usr/local/bin/rika-proxy"]
