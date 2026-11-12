#!/usr/bin/env python3
"""Isolated local-only agent-browser launcher. Does not install or change app settings."""
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
# Captures hold live board text, so they stay outside the repository.
CAPTURE_ROOT = Path.home() / 'Documents' / 'AgentCityCaptures' / 'ab'
AGENT_BROWSER = shutil.which('agent-browser')
DEFAULT_OUT = Path(os.environ.get('AGENTCITY_AB_OUT', str(CAPTURE_ROOT / datetime.now().strftime('%Y%m%d-%H%M%S-ab')))).expanduser().resolve()
if not DEFAULT_OUT.is_relative_to(CAPTURE_ROOT):
    raise ValueError('AGENTCITY_AB_OUT must stay under the approved capture directory')

# The page under test. `AGENTCITY_BOARD_URL` (default: the hub's own port) may carry a query such as
# `?scene=campus`; `board_url()` merges what a case adds (`demo=1`) into it instead of appending blindly.
# Only http://127.0.0.1[:port]/... is accepted (the browser is launched with --allowed-domains 127.0.0.1,
# localhost, and the AB2 checks compare hosts to 127.0.0.1). The URL is rebuilt from its parsed parts, so
# what is checked is what is opened; a backslash, `@`, whitespace or credentials in it are refused.
def parse_board_url(raw):
    raw = raw.strip()
    if not raw or any(c.isspace() or c == '\\' or ord(c) < 32 for c in raw):
        raise ValueError('AGENTCITY_BOARD_URL must not contain whitespace, control characters or a backslash')
    parts = urlsplit(raw)
    if parts.scheme != 'http':
        raise ValueError('AGENTCITY_BOARD_URL must be an http:// URL')
    if '@' in parts.netloc or parts.username is not None or parts.password is not None:
        raise ValueError('AGENTCITY_BOARD_URL must not carry credentials')
    if parts.hostname != '127.0.0.1':
        raise ValueError('AGENTCITY_BOARD_URL must be on 127.0.0.1')
    port = parts.port  # raises ValueError on a bad port
    netloc = '127.0.0.1' + (f':{port}' if port is not None else '')
    return parts._replace(netloc=netloc, path=parts.path or '/', fragment='')

BOARD_PARTS = parse_board_url(os.environ.get('AGENTCITY_BOARD_URL', '') or 'http://127.0.0.1:4317/')
BOARD_URL = urlunsplit(BOARD_PARTS)

def board_url(*, demo=False, case=None):
    # `case` (16 A4-2): a demo case (`busy`, `calm`); it replaces a case the base URL may carry
    query = [(k, v) for k, v in parse_qsl(BOARD_PARTS.query, keep_blank_values=True) if k != 'demo' and not (case and k == 'case')]
    if demo: query.append(('demo', '1'))
    if demo and case: query.append(('case', case))
    return urlunsplit(BOARD_PARTS._replace(query=urlencode(query)))

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
