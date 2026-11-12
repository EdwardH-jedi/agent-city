#!/usr/bin/env python3
"""Read-only AB1/AB3 assertions, using agent-browser for all browser operations."""
import importlib.util
import json
import sys
from pathlib import Path

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ab_cli',HERE/'ab-cli.py')
ab=importlib.util.module_from_spec(spec);spec.loader.exec_module(ab)
OUT=ab.DEFAULT_OUT
MODE=sys.argv[1] if len(sys.argv)>1 else 'ab1'
BASE='http://127.0.0.1:4317/'
results=[]

def command(args, *, stdin=None, required=True):
    p=ab.invoke(args,input_text=stdin)
    try: data=json.loads(p.stdout)
    except Exception: data={'success':False,'error':p.stderr or p.stdout}
    if required and (p.returncode or not data.get('success')):
        raise RuntimeError(f'{args[0]}: {data.get("error")}')
    return data,p.returncode

def save(path,obj): path.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')

try:
    if MODE=='ab3': command(['--args','--disable-webgl','open'])
    else: command(['open'])
    cases=[(1920,1080,False),(1920,1080,True)]
    if MODE=='ab1': cases.extend([(1366,768,False),(1366,768,True)])
    for width,height,demo in cases:
        name=f'{MODE}-{width}x{height}-'+('demo' if demo else 'live')
        case_dir=OUT/name;case_dir.mkdir(parents=True,exist_ok=True)
        record={'name':name,'mode':MODE,'checks':[]}
        try:
            command(['set','viewport',str(width),str(height)])
            command(['errors','--clear']);command(['console','--clear'])
            command(['open',BASE+('?demo=1' if demo else '')])
            ready='Boolean(document.querySelector(".board-sentence") && (document.querySelector(".campus canvas") || document.querySelector(".tiles")) && '+('document.querySelector(".demo-band")' if demo else 'document.querySelector(".bm-online")')+')'
            wait,code=command(['wait','--fn',ready,'--timeout','15000'],required=False)
            save(case_dir/'wait.json',{'exit':code,**wait})
            if not wait.get('success'): raise RuntimeError('board readiness timed out')
            command(['eval','--stdin'],stdin='(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()')
            measured,_=command(['eval','--stdin'],stdin=(HERE/'measure-board.js').read_text())
            record.update(measured['data']['result'])
            command(['screenshot',str(case_dir/'screen.png')])
            snap,_=command(['snapshot']);save(case_dir/'snapshot.json',snap)
            if MODE=='ab3':
                gl,_=command(['eval','--stdin'],stdin='(()=>{const a=document.createElement("canvas"),b=document.createElement("canvas");return {webgl:Boolean(a.getContext("webgl")),webgl2:Boolean(b.getContext("webgl2")),tiles:Boolean(document.querySelector(".tiles"))}})()')
                probe=gl['data']['result'];record['webglProbe']=probe
                record['checks'].append({'name':'webgl_disabled_and_2d_tiles','status':'PASS' if not probe['webgl'] and not probe['webgl2'] and probe['tiles'] else 'FAIL','value':probe})
            if demo:
                record['detail']={'applicable':False,'reason':'Demo has no detail view (11 AB1 table and section 8).'}
            else:
                command(['press','D'])
                detail,detail_code=command(['wait','--fn','location.hash === "#/detail" && Boolean(document.querySelector("table"))','--timeout','2000'],required=False)
                route,_=command(['eval','--stdin'],stdin='({url:location.href,tables:document.querySelectorAll("table").length,board:Boolean(document.querySelector(".board"))})')
                record['detail']={'applicable':True,'wait':detail,'exit':detail_code,**route['data']['result']}
                back_ok=False
                if detail.get('success'):
                    detail_snap,_=command(['snapshot']);save(case_dir/'detail-snapshot.json',detail_snap)
                    command(['press','D'])
                    back,_=command(['wait','--fn','location.hash !== "#/detail" && Boolean(document.querySelector(".board-sentence"))','--timeout','2000'],required=False)
                    back_ok=back.get('success',False)
                record['checks'].append({'name':'detail_roundtrip_D','status':'PASS' if detail.get('success') and back_ok else 'FAIL','value':{'detail':detail.get('success',False),'returned':back_ok,'url':record['detail']['url']}})
            errors,_=command(['errors']);logs,_=command(['console'])
            record['errors']=errors['data'].get('errors',[])
            record['console']=logs['data'].get('messages',[])
            console_errors=[m for m in record['console'] if m.get('type',m.get('level'))=='error']
            record['checks'].append({'name':'console_errors_zero','status':'PASS' if not record['errors'] and not console_errors else 'FAIL','value':{'pageErrors':len(record['errors']),'consoleErrors':len(console_errors)}})
        except Exception as exc:
            record['checks'].append({'name':'inspection_completed','status':'FAIL','value':str(exc)})
        save(case_dir/'result.json',record);results.append(record)
        lines=[f"scene={record.get('metrics',{}).get('scene','unknown')} {name}"]
        for c in record['checks']:
            line=f"RESULT: {c['status']} {c['name']} {json.dumps(c.get('value'),ensure_ascii=False,separators=(',',':'))}"
            lines.append(line)
        counts={s:sum(c['status']==s for c in record['checks']) for s in ['PASS','FAIL','KNOWN']}
        lines.append('TOTAL '+json.dumps(counts))
        (case_dir/'report.txt').write_text('\n'.join(lines)+'\n')
        print(json.dumps({'case':name,'scene':record.get('metrics',{}).get('scene'),'counts':counts,'failures':[c for c in record['checks'] if c['status']=='FAIL'],'known':[c for c in record['checks'] if c['status']=='KNOWN']},ensure_ascii=False),flush=True)
finally:
    close,code=command(['close'],required=False)
    save(OUT/(MODE+'-close.json'),{'exit':code,**close})
    save(OUT/(MODE+'-results.json'),results)

# A FAIL is a failed check; KNOWN (an accepted limit) is not.
if any(c['status']=='FAIL' for r in results for c in r['checks']): sys.exit(1)
