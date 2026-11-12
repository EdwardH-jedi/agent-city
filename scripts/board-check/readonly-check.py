#!/usr/bin/env python3
"""AB2: one 90-second live observation, D roundtrip, then one demo navigation."""
import importlib.util
import json
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ab_cli',HERE/'ab-cli.py')
ab=importlib.util.module_from_spec(spec);spec.loader.exec_module(ab)
OUT=ab.DEFAULT_OUT/'ab2';OUT.mkdir(parents=True,exist_ok=True)
result={'checks':[],'samples':[],'instrumentation':'WebSocket constructor proxy observes URL/open/close only; no frames or payloads.'}

def save(name,obj): (OUT/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')
def cmd(args,stdin=None):
    p=ab.invoke(args,input_text=stdin)
    try: value=json.loads(p.stdout)
    except Exception: raise RuntimeError(p.stderr or p.stdout)
    if p.returncode or not value.get('success'): raise RuntimeError(value.get('error'))
    return value['data']
def evaluate(js): return cmd(['eval','--stdin'],js)['result']
def requests():
    rows=cmd(['network','requests'])['requests']
    return [{k:r.get(k) for k in ['requestId','url','method','resourceType','status','timestamp','mimeType']} for r in rows]
def check(name,passed,value): result['checks'].append({'name':name,'status':'PASS' if passed else 'FAIL','value':value})

try:
    cmd(['--init-script',str(HERE/'observe-websocket.js'),'open'])
    cmd(['set','viewport','1920','1080'])
    cmd(['network','requests','--clear'])
    cmd(['open',ab.board_url()])
    cmd(['wait','--fn','document.querySelector(".bm-online") && (document.querySelector(".campus canvas") || document.querySelector(".town-stage canvas") || document.querySelector(".tiles"))','--timeout','15000'])
    started=time.monotonic()
    for target in [0,30,60,90]:
        remaining=started+target-time.monotonic()
        if remaining>0: time.sleep(remaining)
        sample=evaluate('({at:new Date().toISOString(),sentence:document.querySelector(".board-sentence")?.textContent,counts:document.querySelector(".board-counts")?.textContent,disconnected:Boolean(document.querySelector(".conn-band")),scene:document.querySelector(".tiles")?"2d":"3d",websockets:window.__agentCityABObservation?.websockets})')
        sample['elapsedSeconds']=round(time.monotonic()-started,3)
        result['samples'].append(sample);save('observation.json',result)
        print(json.dumps({'ab2_elapsed':sample['elapsedSeconds'],'disconnected':sample['disconnected'],'websockets':sample.get('websockets')},ensure_ascii=False),flush=True)
    check('live_observed_at_least_90_seconds',result['samples'][-1]['elapsedSeconds']>=90,result['samples'][-1]['elapsedSeconds'])
    cmd(['press','D']);cmd(['wait','--fn','location.hash === "#/detail" && Boolean(document.querySelector("table"))','--timeout','3000'])
    save('detail-snapshot.json',cmd(['snapshot']))
    cmd(['press','D']);cmd(['wait','--fn','location.hash !== "#/detail" && Boolean(document.querySelector(".board-sentence"))','--timeout','3000'])
    check('live_detail_roundtrip',True,'D -> detail tables -> D -> board')
    result['liveRequests']=requests()
    result['liveResources']=evaluate('performance.getEntriesByType("resource").map(e=>({name:e.name,initiatorType:e.initiatorType,startTime:e.startTime,responseEnd:e.responseEnd,duration:e.duration,transferSize:e.transferSize}))')
    result['liveWebsockets']=evaluate('window.__agentCityABObservation.websockets')
    result['liveErrors']=cmd(['errors']).get('errors',[])
    result['liveConsole']=cmd(['console']).get('messages',[])
    post=cmd(['network','requests','--method','POST'])
    result['methodFilterPostCount']=len(post.get('requests',[]))
    cmd(['network','requests','--clear'])
    cmd(['open',ab.board_url(demo=True)])
    cmd(['wait','--fn','document.querySelector(".demo-band") && (document.querySelector(".campus canvas") || document.querySelector(".town-stage canvas") || document.querySelector(".tiles"))','--timeout','15000'])
    cmd(['eval','--stdin'],'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    result['demoRequests']=requests()
    result['demoWebsockets']=evaluate('window.__agentCityABObservation.websockets')
    all_requests=result['liveRequests']+result['demoRequests']
    non_get=[r for r in all_requests if r['method']!='GET']
    foreign=[r for r in all_requests if urlsplit(r['url']).hostname!='127.0.0.1']
    check('http_non_get_zero',not non_get,{'total':len(all_requests),'nonGet':non_get})
    check('request_hosts_loopback_only',not foreign,{'hosts':sorted(set(urlsplit(r['url']).hostname for r in all_requests)),'outside':foreign})
    demo_live=[r['url'] for r in result['liveRequests'] if 'DemoBoard' in r['url']]
    demo_demo=[r['url'] for r in result['demoRequests'] if 'DemoBoard' in r['url']]
    check('demo_chunk_only_on_demo_navigation',not demo_live and bool(demo_demo),{'live':demo_live,'demo':demo_demo})
    check('live_websocket_open',any(urlsplit(w['url']).path=='/ws' and urlsplit(w['url']).hostname=='127.0.0.1' and 'openedAt' in w for w in result['liveWebsockets']),result['liveWebsockets'])
    check('demo_no_websocket',not result['demoWebsockets'],result['demoWebsockets'])
    entries=result['liveResources'];main=next((e for e in entries if '/assets/index-' in e['name'] and e['name'].endswith('.js')),None)
    scene=next((e for e in entries if '/assets/CampusScene-' in e['name'] or '/assets/TownScene-' in e['name']),None)
    check('scene_separate_later_chunk',bool(main and scene and scene['startTime']>=main['responseEnd']),{'entry':main,'scene':scene})
    counts=Counter((urlsplit(r['url']).path+('?' +urlsplit(r['url']).query if urlsplit(r['url']).query else ''),r['method']) for r in all_requests)
    result['requestTable']=[{'path':path,'method':method,'count':count} for (path,method),count in sorted(counts.items())]
except Exception as exc:
    check('inspection_completed',False,str(exc))
finally:
    p=ab.invoke(['close']);save('close.json',{'exit':p.returncode,'response':json.loads(p.stdout)})
    save('result.json',result)
    lines=[]
    for c in result['checks']:
        line=f"RESULT: {c['status']} {c['name']} {json.dumps(c['value'],ensure_ascii=False,separators=(',',':'))}"
        lines.append(line);print(line,flush=True)
    lines.append('TOTAL '+json.dumps({s:sum(c['status']==s for c in result['checks']) for s in ['PASS','FAIL']}))
    (OUT/'report.txt').write_text('\n'.join(lines)+'\n')

if any(c['status']=='FAIL' for c in result['checks']): raise SystemExit(1)
