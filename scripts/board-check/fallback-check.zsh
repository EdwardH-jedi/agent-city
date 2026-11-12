#!/bin/zsh
set -eu
exec python3 -B "${0:A:h}/board-check.py" ab3
