FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1 AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      coreutils \
      diffutils \
      findutils \
      fuse3 \
      gawk \
      git \
      grep \
      jq \
      libfuse2t64 \
      procps \
      python3 \
      sed \
      sqlite3 \
      util-linux \
 && useradd --uid 10001 --create-home --home-dir /tmp/agent-home --shell /bin/bash agent \
 && mkdir -p /workspace /tmp/agent-home \
 && chown agent:agent /tmp/agent-home \
 && chmod 700 /tmp/agent-home \
 && printf 'user_allow_other\n' > /etc/fuse.conf \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY agent_exec.py /usr/local/bin/agent-exec
COPY entrypoint.sh /usr/local/bin/computer-entrypoint

RUN chown root:root /usr/local/bin/agent-exec /usr/local/bin/computer-entrypoint \
 && chmod 755 /usr/local/bin/agent-exec /usr/local/bin/computer-entrypoint /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
ENV COMPUTERD_FUSE_EXTRA_OPTS=allow_other
ENV EXEC_LOG_MAX_BYTES=131072

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computer-entrypoint"]
