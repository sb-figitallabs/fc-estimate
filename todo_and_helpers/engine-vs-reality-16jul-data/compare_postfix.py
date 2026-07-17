#!/usr/bin/env python3
"""Post-fix (P1-P6) three-way comparison vs the frozen baseline.

Engine quote convention (upgraded by P1, same as the 16-Jul report otherwise):
  package route with an un-blocked package_offer.quote  -> quote.with_package_total
  otherwise                                             -> final_estimate (itemized)
New verdict class QUESTION_RAISED: flow2 stopped at a P4/P5 question that the
FC document cannot answer (intended terminal state per the register).
Writes comparison_postfix.jsonl + console table with old-vs-new deltas.
"""
import json, re, statistics

D = '/private/tmp/fc-eval'
fcs = {c['file']: c for c in (json.loads(l) for l in open(f'{D}/fc_cases.jsonl'))}
fbs = [json.loads(l) for l in open(f'{D}/fb_cases.jsonl')]
runs = {r['file']: r for r in (json.loads(l) for l in open(f'{D}/engine_runs_postfix.jsonl'))}
old = {a[0]: a for a in json.load(open(f'{D}/adjudicated.json'))}  # file -> [file, verdict, engine, bill, eng_pct, fc_pct, note]

def norm(s):
    s = re.sub(r'\.pdf$', '', s, flags=re.I)
    s = re.sub(r'\b(FC|FB)\b', '', s, flags=re.I)
    return re.sub(r'[^A-Z0-9]', '', s.upper())
fb_by = {norm(b['file']): b for b in fbs}

def engine_quote(build, billing):
    """(quote, route_label) per the P1-upgraded convention: the quote is the
    headline ONLY on the package route (billing_identification.billing_type ==
    'package') AND when the quote is un-blocked; otherwise final_estimate."""
    if not build: return None, None
    po = build.get('package_offer') or {}
    q = po.get('quote') or {}
    is_pkg_route = (billing or {}).get('billing_type') == 'package'
    if is_pkg_route and q and not q.get('blocked') and q.get('with_package_total'):
        return round(q['with_package_total']), 'package_quote'
    return build.get('final_estimate'), 'itemized'

out = open(f'{D}/comparison_postfix.jsonl', 'w')
rows = []
for file, fc in sorted(fcs.items()):
    r = runs.get(file, {})
    fb = fb_by.get(norm(file))
    c = {'file': file, 'patient': fc.get('patient'), 'fb_file': fb['file'] if fb else None}
    c['treatment'] = r.get('treatment_text') or fc.get('surgery_name')
    c['payor'] = (r.get('payment') or {}).get('payor_bucket')

    tr = fc.get('total_range') or {}
    fc_low, fc_high = tr.get('low'), tr.get('high')
    c['fc_range'] = [fc_low, fc_high]
    c['fc_los'] = fc.get('los')

    bill = None
    if fb:
        fnb = fb.get('fnb_amount') or 0
        net = fb.get('net_amount')
        c['fb_los'] = fb.get('actual_los_days')
        c['fb_bill_type'] = fb.get('bill_type')
        c['fb_extra_lines'] = fb.get('extra_procedure_lines') or []
        c['fb_net_xfnb'] = round(net - fnb, 2) if net is not None else None
        bill = c['fb_net_xfnb']

    bp = r.get('build_planned') or {}
    br = r.get('build_replay_actual') or {}
    billing = r.get('billing_identification') or {}
    c['engine_family'] = (r.get('family_match') or {}).get('family')
    c['engine_route'] = billing.get('billing_type')
    et, route = engine_quote(bp, billing)
    c['engine_quote'] = et
    c['engine_quote_route'] = route
    c['engine_itemized'] = bp.get('final_estimate')
    c['engine_band_planned'] = bp.get('band')
    c['pkg_quote_detail'] = (bp.get('package_offer') or {}).get('quote')
    rt, rroute = engine_quote(br, billing)
    c['engine_total_replay'] = rt
    c['engine_band_replay'] = br.get('band')
    c['questions_answered'] = r.get('questions_answered') or []
    c['question_raised'] = r.get('question_raised')
    c['named_drug'] = bp.get('named_drug')
    c['engine_warnings'] = bp.get('warnings')
    c['engine_error'] = bp.get('error')

    # divergence context (identical rules to compare.py)
    div = []
    if c.get('fb_los') is not None and c.get('fc_los') is not None:
        dl = c['fb_los'] - c['fc_los']
        if abs(dl) >= 2 or (c['fc_los'] > 0 and c['fb_los'] >= 2 * c['fc_los']):
            div.append(f"LOS changed: planned {c['fc_los']} -> actual {c['fb_los']}")
    combo = [l for l in (c.get('fb_extra_lines') or []) if re.search(r'-\s*\d+%\)', l)]
    if combo:
        div.append(f"multi-procedure combo bill ({len(combo)} discounted second-procedure lines)")
    c['divergence'] = div

    verdict, cause = None, ''
    if r.get('fatal') or c.get('engine_error'):
        verdict, cause = 'ERROR', str(r.get('fatal') or c.get('engine_error'))[:120]
    elif c.get('question_raised'):
        verdict = 'QUESTION_RAISED'
        cause = (c['question_raised'].get('question') or '')[:110]
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
            verdict, cause = 'COURSE_CHANGED', 'combo: ' + '; '.join(div)
        elif los_changed:
            verdict, cause = 'COURSE_CHANGED', '; '.join(div)
        elif et is None:
            verdict, cause = 'ERROR', 'family matched but build returned no total'
        elif err <= 25 or in_band:
            verdict = 'ENGINE_GOOD'
            cause = f'engine {et:,} ({route}) vs bill {bill:,.0f} ({(et-bill)/bill*100:+.0f}%)'
        else:
            verdict = 'ENGINE_OFF'
            cause = f'engine {et:,} ({route}) vs bill {bill:,.0f} ({(et-bill)/bill*100:+.0f}%), same LOS/treatment'
        if verdict == 'COURSE_CHANGED' and rt and bill:
            rerr = abs(rt - bill) / bill * 100
            rband = c.get('engine_band_replay')
            rin = rband and rband[0] * 0.999 <= bill <= rband[2] * 1.001
            c['replay_pct_err'] = round((rt - bill) / bill * 100, 1)
            c['replay_verdict'] = 'REPLAY_GOOD' if (rerr <= 25 or rin) else 'REPLAY_OFF'
        # course-changed but quote may stand on its own (package-insulated)
        if verdict == 'COURSE_CHANGED' and et and bill and route == 'package_quote':
            e = (et - bill) / bill * 100
            c['planned_quote_pct_err'] = round(e, 1)
            if abs(e) <= 25:
                c['reclass_candidate'] = f'package quote {et:,} lands {e:+.1f}% at planned inputs (package bills are LOS-insulated)'
    if et and bill:
        c['engine_pct_err'] = round((et - bill) / bill * 100, 1)

    # FC-human vs bill (unchanged)
    if bill and fc_low and fc_high:
        mid = (fc_low + fc_high) / 2
        c['fc_vs_fb_pct'] = round((mid - bill) / bill * 100, 1)

    # old adjudication
    o = old.get(file)
    if o:
        c['old_verdict'], c['old_engine'], c['old_pct'] = o[1], o[2], o[4]
    c['verdict'] = verdict
    c['cause'] = cause
    out.write(json.dumps(c) + '\n')
    rows.append(c)
out.close()

from collections import Counter
cnt = Counter(x['verdict'] for x in rows)
print('VERDICTS:', dict(cnt))
clean = [x for x in rows if x['verdict'] in ('ENGINE_GOOD', 'ENGINE_OFF') and x.get('engine_pct_err') is not None]
ce = [abs(x['engine_pct_err']) for x in clean]
fh = [abs(x['fc_vs_fb_pct']) for x in clean if x.get('fc_vs_fb_pct') is not None]
if ce:
    print(f'engine  median|err| clean n={len(ce)}: {statistics.median(ce):.1f}%   mean {statistics.mean(ce):.1f}%')
if fh:
    print(f'human   median|err| same set n={len(fh)}: {statistics.median(fh):.1f}%   mean {statistics.mean(fh):.1f}%')
print()
print(f"{'case':30} {'old->new verdict':32} {'old%':>7} {'new%':>7} {'quote':>9} {'route':13} cause")
for x in rows:
    ov = x.get('old_verdict', '?')
    nv = x['verdict']
    mark = '' if ov == nv else ' *'
    print(f"{x['file'][:29]:30} {ov[:14]+'->'+nv[:14]+mark:32} {str(x.get('old_pct')):>7} {str(x.get('engine_pct_err')):>7} {str(x.get('engine_quote')):>9} {str(x.get('engine_quote_route'))[:12]:13} {x['cause'][:55]}")
