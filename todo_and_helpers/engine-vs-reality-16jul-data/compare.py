#!/usr/bin/env python3
"""Three-way comparison: engine vs FC-human vs final bill. -> comparison.jsonl + console table."""
import json, re, statistics

D = '/private/tmp/fc-eval'
fcs = {c['file']: c for c in (json.loads(l) for l in open(f'{D}/fc_cases.jsonl'))}
fbs = [json.loads(l) for l in open(f'{D}/fb_cases.jsonl')]
runs = {r['file']: r for r in (json.loads(l) for l in open(f'{D}/engine_runs.jsonl'))}

def norm(s):
    s = re.sub(r'\.pdf$', '', s, flags=re.I)
    s = re.sub(r'\b(FC|FB)\b', '', s, flags=re.I)
    return re.sub(r'[^A-Z0-9]', '', s.upper())
fb_by = {norm(b['file']): b for b in fbs}

out = open(f'{D}/comparison.jsonl', 'w')
rows = []
for file, fc in sorted(fcs.items()):
    r = runs.get(file, {})
    fb = fb_by.get(norm(file))
    c = {'file': file, 'patient': fc.get('patient'), 'fb_file': fb['file'] if fb else None}
    c['treatment'] = r.get('treatment_text') or fc.get('surgery_name')
    c['counselling_type'] = fc.get('counselling_type')
    c['payment_mode'] = fc.get('payment_mode')
    c['payor'] = (r.get('payment') or {}).get('payor_bucket')
    c['org'] = (r.get('org_resolution') or {}).get('organization_name')
    c['special_equipment'] = r.get('special_equipment')

    # FC human numbers
    tr = fc.get('total_range') or {}
    fc_low, fc_high = tr.get('low'), tr.get('high')
    c['fc_range'] = [fc_low, fc_high]
    c['fc_los'] = fc.get('los')
    c['fc_estimate_type'] = fc.get('estimate_type')

    # FB numbers
    if fb:
        fnb = fb.get('fnb_amount') or 0
        net = fb.get('net_amount')
        gross = fb.get('gross_amount')
        c['fb_bill_type'] = fb.get('bill_type')
        c['fb_package'] = fb.get('package')
        c['fb_extra_lines'] = fb.get('extra_procedure_lines') or []
        c['fb_los'] = fb.get('actual_los_days')
        c['fb_net'] = net
        c['fb_gross'] = gross
        c['fb_fnb'] = fnb
        c['fb_net_xfnb'] = round(net - fnb, 2) if net is not None else None
        c['fb_gross_xfnb'] = round(gross - fnb, 2) if gross is not None else None
        c['fb_concession'] = fb.get('concession_amount')
        c['fb_org_payable'] = fb.get('org_payable')
        c['fb_patient_payable'] = fb.get('patient_payable')
    # engine numbers
    bp = r.get('build_planned') or {}
    bd = r.get('build_default') or {}
    br = r.get('build_replay_actual') or {}
    c['engine_family'] = (r.get('family_match') or {}).get('family')
    c['engine_confidence'] = (r.get('family_match') or {}).get('confidence')
    c['engine_route'] = (r.get('billing_identification') or {}).get('billing_type')
    c['engine_pkg'] = {k: (r.get('billing_identification') or {}).get(k) for k in ('package_code', 'package_name', 'package_amount')}
    c['engine_total_planned'] = bp.get('final_estimate')
    c['engine_band_planned'] = bp.get('band')
    c['engine_total_default'] = bd.get('final_estimate')
    c['engine_los_p50'] = ((bd.get('los') or {}).get('p50'))
    c['engine_total_replay'] = br.get('final_estimate')
    c['engine_band_replay'] = br.get('band')
    c['engine_warnings'] = bp.get('warnings') or bd.get('warnings')
    c['engine_error'] = bp.get('error') or bd.get('error')
    c['room_used'] = r.get('room_used')

    # ---- Engine vs FC-human ----
    et = c.get('engine_total_planned')
    if et and fc_low and fc_high:
        c['engine_vs_fc'] = 'inside' if fc_low <= et <= fc_high else ('above' if et > fc_high else 'below')
        mid = (fc_low + fc_high) / 2
        c['engine_vs_fc_pct'] = round((et - mid) / mid * 100, 1)
        # bucket mapping (only when FC has itemized buckets)
        bk = fc.get('buckets') or {}
        eb = bp.get('bucket_totals') or {}
        if any(v for v in bk.values()):
            g = lambda *ks: sum(eb.get(k, 0) or 0 for k in ks)
            f = lambda *ks: sum(bk.get(k) or 0 for k in ks)
            c['bucket_deltas'] = {
                'professional(FC cons+PF vs E PF)': [f('consultation', 'professional_fees'), g('Professional Fees')],
                'room': [f('room'), g('Room Charges')],
                'investigation': [f('investigation'), g('Investigations')],
                'procedure_ot': [f('procedure'), g('Procedure / OT Charges', 'Cath Lab Charges')],
                'pharmacy': [f('pharmacy'), g('Pharmacy', 'Drug Administration Charges')],
                'service_misc': [f('service', 'misc'), g('Bedside Services', 'Optional Add-Ons')],
            }

    # ---- FC-human vs FB ----
    bill = c.get('fb_net_xfnb')
    if bill and fc_low and fc_high:
        c['fc_vs_fb'] = 'inside' if fc_low <= bill <= fc_high else ('bill_above' if bill > fc_high else 'bill_below')
        mid = (fc_low + fc_high) / 2
        c['fc_vs_fb_pct'] = round((mid - bill) / bill * 100, 1)  # + = FC overestimated

    # ---- divergence context ----
    div = []
    if c.get('fb_los') is not None and c.get('fc_los') is not None:
        dl = c['fb_los'] - c['fc_los']
        if abs(dl) >= 2 or (c['fc_los'] > 0 and c['fb_los'] >= 2 * c['fc_los']):
            div.append(f"LOS changed: planned {c['fc_los']} -> actual {c['fb_los']}")
    combo = [l for l in (c.get('fb_extra_lines') or []) if re.search(r'-\s*\d+%\)', l)]
    if combo:
        div.append(f"multi-procedure combo bill ({len(combo)} discounted second-procedure lines)")
    if fb and fc.get('estimate_type') and c.get('fb_bill_type'):
        fc_pkg = fc['estimate_type'].lower().startswith('package')
        if fc_pkg != (c['fb_bill_type'] == 'package'):
            div.append(f"bill-type flip: FC said {fc['estimate_type']}, bill was {c['fb_bill_type']}")
    c['divergence'] = div

    # ---- verdict ----
    verdict, cause = None, ''
    if r.get('fatal') or c.get('engine_error'):
        verdict, cause = 'ERROR', str(r.get('fatal') or c.get('engine_error'))[:120]
    elif not c.get('engine_family'):
        verdict, cause = 'NO_MATCH', 'no onboarded family for this treatment'
    elif not fb or bill is None:
        verdict, cause = 'NO_FB', 'no usable final bill'
    else:
        err = abs(et - bill) / bill * 100 if et else None
        band = c.get('engine_band_planned')
        in_band = band and band[0] * 0.999 <= bill <= band[2] * 1.001
        combo_case = bool(combo)
        los_changed = any(d.startswith('LOS changed') for d in div)
        if combo_case:
            verdict = 'COURSE_CHANGED'
            cause = 'combo: ' + '; '.join(div)
        elif los_changed:
            verdict = 'COURSE_CHANGED'
            cause = '; '.join(div)
        elif et is None:
            verdict, cause = 'ERROR', 'family matched but build returned no total'
        elif err <= 25 or in_band:
            verdict = 'ENGINE_GOOD'
            cause = f'engine {et:,} vs bill {bill:,.0f} ({err:+.0f}% err)' if err is not None else 'bill inside engine band'
        else:
            verdict = 'ENGINE_OFF'
            cause = f'engine {et:,} vs bill {bill:,.0f} ({(et-bill)/bill*100:+.0f}%), same LOS/treatment'
        if verdict == 'COURSE_CHANGED' and c.get('engine_total_replay') and bill:
            rerr = abs(c['engine_total_replay'] - bill) / bill * 100
            rband = c.get('engine_band_replay')
            rin = rband and rband[0] * 0.999 <= bill <= rband[2] * 1.001
            c['replay_pct_err'] = round((c['engine_total_replay'] - bill) / bill * 100, 1)
            c['replay_verdict'] = 'REPLAY_GOOD' if (rerr <= 25 or rin) else 'REPLAY_OFF'
        if et and bill:
            c['engine_pct_err'] = round((et - bill) / bill * 100, 1)
    c['verdict'] = verdict
    c['cause'] = cause
    out.write(json.dumps(c) + '\n')
    rows.append(c)
out.close()

# ---- console scoreboard ----
from collections import Counter
cnt = Counter(x['verdict'] for x in rows)
print('VERDICTS:', dict(cnt))
clean = [abs(x['engine_pct_err']) for x in rows if x['verdict'] in ('ENGINE_GOOD', 'ENGINE_OFF') and x.get('engine_pct_err') is not None]
fcerr = [abs(x['fc_vs_fb_pct']) for x in rows if x['verdict'] in ('ENGINE_GOOD', 'ENGINE_OFF') and x.get('fc_vs_fb_pct') is not None]
fcall = [abs(x['fc_vs_fb_pct']) for x in rows if x.get('fc_vs_fb_pct') is not None]
if clean: print(f'engine median abs %err (clean cases, n={len(clean)}): {statistics.median(clean):.1f}%')
if fcerr: print(f'FC-human median abs %err (same clean cases, n={len(fcerr)}): {statistics.median(fcerr):.1f}%')
if fcall: print(f'FC-human median abs %err (all billed, n={len(fcall)}): {statistics.median(fcall):.1f}%')
print()
print(f"{'case':32} {'verdict':14} {'pay':6} {'FCrange':>17} {'engine':>8} {'bill-xFnB':>10} {'LOS p/a':>8} cause")
for x in rows:
    fr = x.get('fc_range') or [None, None]
    print(f"{x['file'][:31]:32} {str(x['verdict']):14} {str(x.get('payor'))[:5]:6} {str(fr[0])+'-'+str(fr[1]):>17} {str(x.get('engine_total_planned')):>8} {str(x.get('fb_net_xfnb')):>10} {str(x.get('fc_los'))+'/'+str(x.get('fb_los')):>8} {x['cause'][:60]}")
