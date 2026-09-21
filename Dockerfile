# Static app served by nginx. nginx:alpine is published multi-arch
# (amd64, arm64, armv7, ...), so the same image runs on x86 servers,
# Apple Silicon, and Raspberry Pi class devices.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
