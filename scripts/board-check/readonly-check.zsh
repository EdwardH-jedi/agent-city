#!/bin/zsh
set -eu
exec python3 -B "${0:A:h}/readonly-check.py"
