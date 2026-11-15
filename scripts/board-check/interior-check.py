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

def project_name(expected, suffix):
    # TextContent alone misses a shadow painted over the first letter. Measure the full text range
    # against its clipping ancestors and the actual painted left-hand highlight, including inset.
    value = evaluate('''(()=>{
        const group=document.querySelector('.sess-group.is-inside'),name=group?.querySelector('.sess-name');
        if(!name)return {visible:false};
        const range=document.createRange();range.selectNodeContents(name);
        const text=range.getBoundingClientRect(),g=group.getBoundingClientRect();
        const clip={left:0,top:0,right:innerWidth,bottom:innerHeight};
        for(let node=name;node;node=node.parentElement){
            const style=getComputedStyle(node),r=node.getBoundingClientRect();
            if(/hidden|clip|auto|scroll/.test(style.overflowX)){
                clip.left=Math.max(clip.left,r.left+node.clientLeft);
                clip.right=Math.min(clip.right,r.left+node.clientLeft+node.clientWidth);
            }
            if(/hidden|clip|auto|scroll/.test(style.overflowY)){
                clip.top=Math.max(clip.top,r.top+node.clientTop);
                clip.bottom=Math.min(clip.bottom,r.top+node.clientTop+node.clientHeight);
            }
        }
        const shadow=getComputedStyle(group).boxShadow;
        const [x,y,blur,spread]=shadow.replace(/rgba?\\([^)]*\\)|inset/g,'').trim().split(/\\s+/).map(Number.parseFloat);
        const bar=shadow.includes('inset')?{left:g.left,right:g.left+x}:{left:g.left+x,right:g.left};
        const barVisible=bar.right>bar.left&&y===0&&blur===0&&spread===0;
        const unclipped=text.width>0&&text.height>0&&text.left>=clip.left-.5&&text.right<=clip.right+.5&&text.top>=clip.top-.5&&text.bottom<=clip.bottom+.5;
        const clearOfBar=text.left>=bar.right-.5||text.right<=bar.left+.5;
        return {name:name.textContent,unclipped,clearOfBar,barVisible,shadow,bar,clip,text:{left:text.left,right:text.right,top:text.top,bottom:text.bottom}};
    })()''')
    check(f'interior_project_name_unclipped_{suffix}', value.get('name')==expected and all(value.get(k) for k in ['unclipped','clearOfBar','barVisible']), value)

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
        project_name('station0', f'station0_{width}')
        check(f'interior_demo_no_hub_requests_{width}', not evaluate('performance.getEntriesByType("resource").some(e=>new URL(e.name).pathname.startsWith("/api/"))'), None)
        cmd(['screenshot',str(OUT/f'interior-{width}x{height}.png')])
    cmd(['open',ab.board_url() + ('&' if '?' in ab.board_url() else '?') + 'tour=off'])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    cmd(['wait','--load','networkidle'])
    requests = evaluate('performance.getEntriesByType("resource").map(e=>new URL(e.name).pathname)')
    check('interior_tour_off_no_chunk', not any('/interior/' in s or '/scene-' in s for s in requests), None)
    check('interior_tour_off_no_name', not stage().get('inside'), None)
    # Same board -> same API URL set when pinned. Only labels/graphics change, never the data source.
    before = sorted(set(s for s in requests if s.startswith('/api/')))
    parts = urlsplit(ab.board_url())
    query = dict(parse_qsl(parts.query)); query['interior']='station0'
    cmd(['open',urlunsplit(parts._replace(query=urlencode(query)))])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    cmd(['wait','--load','networkidle'])
    after = evaluate('performance.getEntriesByType("resource").map(e=>new URL(e.name).pathname).filter(s=>s.startsWith("/api/"))')
    check('interior_live_api_paths_unchanged', before==sorted(set(after)), {'before':before,'after':sorted(set(after))})
    # Number keys are presentation navigation; D stays the existing detail round trip.
    cmd(['open',url(case='tour',tour='off')])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    cmd(['press','1'])
    cmd(['wait','--fn','document.querySelector(".town-stage")?.dataset.tour === "inside" && Number(document.querySelector(".town-interior-fade")?.style.opacity) === 0'])
    check('interior_number_enters', stage().get('inside')=='STATION0',stage())
    cmd(['screenshot',str(OUT/'manual-inside.png')])
    cmd(['press','Escape'])
    cmd(['wait','--fn','!document.querySelector(".town-inside")'])
    check('interior_escape_exits',not stage().get('inside'),None)
    cmd(['press','1'])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-inside"))'])
    cmd(['press','0'])
    cmd(['wait','--fn','!document.querySelector(".town-inside")'])
    check('interior_zero_exits',not stage().get('inside'),None)
    # Demo has no detail route. Check D from the live pinned room instead.
    cmd(['open',urlunsplit(parts._replace(query=urlencode(query)))])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    cmd(['press','D'])
    cmd(['wait','--fn','location.hash === "#/detail" && Boolean(document.querySelector(".detail .dpanel"))'])
    cmd(['press','D'])
    cmd(['wait','--fn','location.hash !== "#/detail" && Boolean(document.querySelector(".town-map:not([hidden])"))'])
    check('interior_D_round_trip',True,None)
    cmd(['open',url(case='tour-sign',tour='off')])
    cmd(['wait','--fn','Boolean(document.querySelector(".town-map:not([hidden])"))'])
    cmd(['press','1'])
    cmd(['wait','--fn','document.querySelector(".town-stage")?.dataset.tour === "inside" && Number(document.querySelector(".town-interior-fade")?.style.opacity) === 0'])
    cmd(['screenshot',str(OUT/'sign-before.png')])
    cmd(['wait','--fn','Boolean(document.querySelector(".board.border-yellow")) && !document.querySelector(".town-inside")'])
    check('interior_sign_preempts',not stage().get('inside'),None)
    cmd(['screenshot',str(OUT/'sign-exit.png')])
    cmd(['press','1'])
    check('interior_sign_blocks_reentry',not stage().get('inside'),None)
    for width,height in [(1920,1080),(1366,768)]:
        cmd(['set','viewport',str(width),str(height)])
        cmd(['open',url(case='interior-cafe')])
        cmd(['wait','--fn','document.querySelector(".town-inside")?.textContent === "NO-WUKKAS-CAFE"'])
        room = stage()
        check(f'interior_cafe_name_and_panel_{width}', room.get('inside')=='NO-WUKKAS-CAFE' and room.get('highlight')==1 and room.get('hidden')=='true',room)
        project_name('no-wukkas-cafe', f'cafe_{width}')
        check(f'interior_cafe_demo_no_hub_{width}',not evaluate('performance.getEntriesByType("resource").some(e=>new URL(e.name).pathname.startsWith("/api/"))'),None)
        cmd(['screenshot',str(OUT/f'cafe-{width}x{height}.png')])
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
