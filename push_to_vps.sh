#!/usr/bin/env bash
# MAPIMS PACS Connect - Push Project to VPS
# Reads SSH & SSH_PASSWORD from .env automatically
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
python3 "$DIR/scripts/push_to_vps.py" "$@"
