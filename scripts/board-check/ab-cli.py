#!/usr/bin/env python3
"""Isolated local-only agent-browser launcher. Does not install or change app settings."""
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Captures hold live board text, so they stay outside the repository.
CAPTURE_ROOT = Path.home() / 'Documents' / 'AgentCityCaptures' / 'ab'
AGENT_BROWSER = shutil.which('agent-browser')
DEFAULT_OUT = Path(os.environ.get('AGENTCITY_AB_OUT', str(CAPTURE_ROOT / datetime.now().strftime('%Y%m%d-%H%M%S-ab')))).expanduser().resolve()
if not DEFAULT_OUT.is_relative_to(CAPTURE_ROOT):
    raise ValueError('AGENTCITY_AB_OUT must stay under the approved capture directory')

def invoke(args, *, input_text=None, timeout=45, namespace=None):
    runtime = DEFAULT_OUT / 'runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY') if k in os.environ}
    env.update(TMPDIR=str(runtime) + '/', AGENT_BROWSER_NO_VERSION_CHECK='1')
    if AGENT_BROWSER is None:
        raise FileNotFoundError('agent-browser is not on PATH')
    command = [AGENT_BROWSER, '--config', str(HERE / 'agent-browser.json'),
               '--namespace', namespace or ('agentcity-' + DEFAULT_OUT.name), '--session', 'agentcity-check',
               '--allowed-domains', '127.0.0.1,localhost', '--no-webmcp', '--json', *args]
    return subprocess.run(command, input=input_text, capture_output=True, text=True, env=env, timeout=timeout)

if __name__ == '__main__':
    stdin = sys.stdin.read() if '--stdin' in sys.argv else None
    result = invoke(sys.argv[1:], input_text=stdin)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    sys.exit(result.returncode)
