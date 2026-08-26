#!/bin/bash
set -euo pipefail

# All workspace users share one data plane. The daemon stays root so it
# can mount FUSE. The command wrapper drops each agent process to uid 10001.
umask 000
exec /usr/local/bin/computerd
