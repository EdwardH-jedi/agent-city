#!/usr/bin/env python3
"""21: room layout, lazy load and unchanged read paths, on an isolated local browser."""
import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('ab_cli', HERE/'ab-cli.py')
ab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ab)
OUT = ab.DEFAULT_OUT/'ab4'
OUT.mkdir(parents=True, exist_ok=True)
checks = []

def cmd(args, js=None):
    p = ab.invoke(args, input_text=js)
    d = json.loads(p.stdout)
    if p.returncode or not d.get('success'):
        raise RuntimeError(d.get('error', p.stderr))
    return d.get('data', {})

def evaluate(js):
    return cmd(['eval', '--stdin'], js)['result']

def check(name, ok, value):
    checks.append({'name': name, 'status': 'PASS' if ok else 'FAIL', 'value': value})

def url(**extra):
    parts = urlsplit(ab.board_url(demo=True, case='interior'))
    q = dict(parse_qsl(parts.query))
    q.update(extra)
    return urlunsplit(parts._replace(query=urlencode(q)))

def stage():
    return evaluate('''(()=>{const c=document.querySelector('.town-stage canvas'),h=document.querySelector('.town-stage'),r=h?.getBoundingClientRect();return {width:r?.width,height:r?.height,rtW:h?.dataset.rtW,rtH:h?.dataset.rtH,scale:h?.dataset.scale,inside:document.querySelector('.town-inside')?.textContent,highlight:document.querySelectorAll('.sess-group.is-inside').length,hidden:c?.getAttribute('aria-hidden')}})()''')

try:
    cmd(['open'])
    for width,height in [(1920,1080),(1366,768)]:
        cmd(['set','viewport',str(width),str(height)])
        cmd(['open',url(interior='not-a-building')])
        cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
        ring = stage()
        check(f'interior_unknown_stays_ring_{width}', not ring.get('inside'), ring)
        resources = evaluate('performance.getEntriesByType("resource").map(e=>e.name)')
        check(f'interior_unknown_no_chunk_{width}', not any('/interior/' in s or '/scene-' in s for s in resources), [])
        cmd(['open',url()])
        cmd(['wait','--fn','document.querySelector(".town-inside")?.textContent === "STATION0"'])
        room = stage()
        check(f'interior_stage_matches_ring_{width}', all(room.get(k)==ring.get(k) for k in ['width','height','rtW','rtH','scale']), {'ring':ring,'room':room})
        check(f'interior_name_and_panel_{width}', room.get('inside')=='STATION0' and room.get('highlight')==1 and room.get('hidden')=='true', room)
        check(f'interior_demo_no_hub_requests_{width}', not evaluate('performance.getEntriesByType("resource").some(e=>new URL(e.name).pathname.startsWith("/api/"))'), None)
        cmd(['screenshot',str(OUT/f'interior-{width}x{height}.png')])
    cmd(['open',ab.board_url()])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    requests = evaluate('performance.getEntriesByType("resource").map(e=>new URL(e.name).pathname)')
    check('interior_default_no_chunk', not any('/interior/' in s or '/scene-' in s for s in requests), None)
    check('interior_default_no_name', not stage().get('inside'), None)
    # Same board -> same API URL set when pinned. Only labels/graphics change, never the data source.
    before = sorted(set(s for s in requests if s.startswith('/api/')))
    parts = urlsplit(ab.board_url())
    query = dict(parse_qsl(parts.query)); query['interior']='station0'
    cmd(['open',urlunsplit(parts._replace(query=urlencode(query)))])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    after = evaluate('performance.getEntriesByType("resource").map(e=>new URL(e.name).pathname).filter(s=>s.startsWith("/api/"))')
    check('interior_live_api_paths_unchanged', before==sorted(set(after)), {'before':before,'after':sorted(set(after))})
    errors = cmd(['errors']).get('errors',[])
    check('interior_errors_zero', not errors, len(errors))
except Exception as error:
    check('interior_inspection_completed',False,str(error))
finally:
    cmd(['close'])
    (OUT/'result.json').write_text(json.dumps({'checks':checks},ensure_ascii=False,indent=2)+'\n')
    for c in checks: print(f"RESULT: {c['status']} {c['name']} {json.dumps(c['value'],ensure_ascii=False)}",flush=True)
    print('TOTAL '+json.dumps({s:sum(c['status']==s for c in checks) for s in ['PASS','FAIL']}),flush=True)
if any(c['status']=='FAIL' for c in checks): raise SystemExit(1)
