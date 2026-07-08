/**
 * Package coverage engine — parses the curated semi-structured inclusion/
 * exclusion text into a coverage model, then applies it to the itemized
 * line items to produce per-row {status, final_amount} and dual totals.
 *
 * Statuses: fully_included | partially_included | capped | excluded |
 *           not_included | review (unparseable ⇒ full price, never silent ₹0).
 * Every rule carries its curated source line (provenance — no fabrication).
 */

const U = (s) => (s || '').toUpperCase();

/** Split curated text that concatenates multiple source variants into blocks. */
export function splitVariants(text) {
  if (!text || !text.trim()) return [];
  const out = [];
  let rest = text;
  for (;;) {
    const first = rest.indexOf('Hospital Stay');
    const next = first >= 0 ? rest.indexOf('Hospital Stay', first + 1) : -1;
    if (next < 0) { out.push(rest.trim()); break; }
    const cut = rest.lastIndexOf('-', next);
    out.push(rest.slice(0, cut > 0 ? cut : next).trim());
    rest = rest.slice(cut > 0 ? cut : next);
  }
  return out.filter(Boolean);
}

/** The curated text sometimes concatenates 2 source variants — keep the first. */
export function dedupeVariants(text) {
  const parts = splitVariants(text);
  return { text: parts[0] ?? '', variants: parts.length };
}

/** Parse curated inclusions/exclusions into a coverage model. */
/**
 * Category-level inclusion clauses — the format every insurance tariff uses
 * (GIPSA "L1: Standard inclusions - Doctor's fee, OT charges, …",
 *  TR201 "A: Inclusions - Room rents, Nursing charges, …",
 *  TR285 pipe-lists, TR287 prose). Instead of per-item caps/allowances these
 * declare whole categories as included in the package price; implants and the
 * like live in the exclusion text. Only used when the itemized curated parse
 * yields no signal, and only when the text clearly names several categories.
 */
const CATEGORY_PATTERNS = [
  ['room', /ROOM RENT|BED CHARGES|WARD/],
  ['nursing', /NURSING/],
  ['pf', /DOCTOR|SURGEON|PROFESSIONAL CHARGES|CONSULT|ANAESTH|ANESTH|GYNECOLOGIST|P(?:A?)EDIATRICIAN|PHYSICIAN/],
  ['ot', /OT CHARGES|OPERATION THEATRE|THEATRE CHARGES|OT GAS|OT CONSUMABLE/],
  ['pharmacy', /DRUGS|MEDICINES|CONSUMABLES/],
  ['investigations', /INVESTIGATION/],
  ['bedside', /MONITOR|OXYGEN|VENTILATOR|NEBULIS|ADMINISTRATIVE CHARGES|BLOOD/],
];

function extractCategories(text) {
  const up = U(text);
  const set = CATEGORY_PATTERNS.filter(([, re]) => re.test(up)).map(([k]) => k);
  const source = text.length > 160 ? text.slice(0, 157) + '…' : text;
  // stay-based package ("3 days hospital stay | Four ECGs | Cardiology
  // consultations…") = an end-to-end per-case rate; the listed items are
  // ancillary clarifications, so treat it as comprehensive — implants are
  // never category-included and still ride the exclusion text
  if (/\d+\s*DAYS?\s*HOSPITAL\s*STAY|HOSPITAL\s*STAY/.test(up) && set.length >= 1) {
    return { set: CATEGORY_PATTERNS.map(([k]) => k), source, comprehensive: true };
  }
  // otherwise require a clear multi-category clause — a stray keyword must
  // not flip the whole estimate into "everything included" mode
  if (set.length < 3) return null;
  return { set, source };
}

export function parseCoverage(inclusionsText, exclusionsText) {
  const { text, variants } = dedupeVariants(inclusionsText);
  const model = {
    stay: { ward_days: null, icu_days: null, source: null },
    caps: {},          // ip_pharmacy / ot_pharmacy / implants / investigations(room-wise)
    pf: [],            // included professional-fee lines (informational amounts)
    allowances: [],    // { name, qty, source }
    exclusions: [],    // { text }
    beyondDaysAtActuals: false,
    unparsed: [],
    variants,
  };
  // split on newlines only — item names legitimately contain " - "
  const lines = text.split(/\n/).map((l) => l.replace(/^[-•]\s*/, '').trim()).filter(Boolean);
  for (const line of lines) {
    const up = U(line);
    let m;
    if ((m = up.match(/HOSPITAL STAY\s*\|?\s*(\d+)\s*DAY[- ]?WARD\s*,?\s*(\d+)\s*DAY[- ]?ICU/))) {
      model.stay = { ward_days: +m[1], icu_days: +m[2], source: line };
    } else if ((m = up.match(/PHARMACY.*?\bIP\b\s*\|\s*([\d,]+)/))) {
      model.caps.ip_pharmacy = { amount: +m[1].replace(/,/g, ''), source: line };
    } else if ((m = up.match(/PHARMACY.*?\bOT\b\s*\|\s*([\d,]+)/))) {
      model.caps.ot_pharmacy = { amount: +m[1].replace(/,/g, ''), source: line };
    } else if ((m = up.match(/^IMPLANTS?\s*\|\s*([\d,]+)/))) {
      model.caps.implants = { amount: +m[1].replace(/,/g, ''), source: line };
    } else if ((m = up.match(/^INVESTIGATIONS?\s*:?\s*\|(.+)/))) {
      const rooms = {};
      for (const rm of m[1].matchAll(/(GENERAL|TWIN|SINGLE|DELUXE)\s*[-–]\s*([\d,]+)/g)) {
        rooms[rm[1].toLowerCase()] = +rm[2].replace(/,/g, '');
      }
      if (Object.keys(rooms).length) model.caps.investigations = { rooms, source: line };
      else model.unparsed.push(line);
    } else if (/^(SURGEON|ANAESTHESIA|ANESTHESIA|ASSISTANTS?)/.test(up)) {
      model.pf.push({ source: line }); // included PF — informational amounts, not caps
    } else if (up.includes('BEYOND THE PACKAGE DAYS')) {
      model.beyondDaysAtActuals = true;
    } else if (line.includes(' - ') && /- *\d+(\s*,|$)/.test(line + ',')) {
      // item allowance list: "NAME - QTY, NAME - QTY, ..."
      for (const part of line.split(/,(?![^(]*\))/)) {
        const pm = part.trim().match(/^(.*?)\s*[-–]\s*(\d+)$/);
        if (pm && pm[1].trim()) model.allowances.push({ name: U(pm[1]).trim(), qty: +pm[2], source: part.trim() });
        else if (part.trim()) model.unparsed.push(part.trim());
      }
    } else if (line) {
      model.unparsed.push(line);
    }
  }
  for (const line of (exclusionsText || '').split(/\n|\||(?=- )/)) {
    const t = line.replace(/^[-•]\s*/, '').replace(/\.$/, '').trim();
    if (t && !/^excluded/i.test(t)) model.exclusions.push({ text: t });
  }

  // clause-format fallback: no itemized signal → try category-level inclusions
  const hasSignal = model.stay.ward_days != null || Object.keys(model.caps).length ||
    model.allowances.length || model.pf.length;
  if (!hasSignal) model.categories = extractCategories(text);

  return model;
}

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * Apply coverage to the estimate's line items.
 * Returns { rows:[{index,name,status,final_amount,source,note}], totals, parse }.
 */
export function applyCoverage(estimate, coverage) {
  const roomKey = estimate.resolved_context.room_key || 'single';
  const items = estimate.line_items;
  const drv = estimate.drivers;
  const sel = (row) => Number(row.selected?.[roomKey] ?? 0);

  const rows = items.map((r, i) => ({ index: i, name: r.name, bucket: r.bucket, amount: round2(sel(r)) }));
  const out = new Map(); // index -> {status, final_amount, source, note}
  const set = (i, status, final, source, note) => out.set(i, { status, final_amount: round2(Math.max(0, final)), source: source ?? null, note: note ?? null });

  const isExcluded = (name) => coverage.exclusions.find((e) => {
    const a = U(name), b = U(e.text);
    return a.includes(b) || b.includes(a);
  });
  const allowanceFor = (name) => {
    const a = U(name);
    return coverage.allowances.find((al) => a.includes(al.name) || al.name.includes(a) ||
      // common name variations
      (al.name.replace(/[^A-Z0-9]/g, '').includes(a.replace(/[^A-Z0-9]/g, '')) && a.length > 6));
  };

  // ---- per-day (stay) rows ----
  const ICU_ROWS = /NURSING - ICU|ICU - SURGICAL|INTENSIVIST|MONITOR PER DAY/i;
  const WARD_ROWS = /NURSING - ROOM|^DMO$|BED CHARGES|WARD CONSUMABLES/i;
  const coveredIcu = coverage.stay.icu_days;
  const coveredWard = coverage.stay.ward_days;

  items.forEach((r, i) => {
    const name = r.name;
    const amt = sel(r);
    if (out.has(i)) return;

    // exclusions first
    const ex = isExcluded(name);
    if (ex) return set(i, 'excluded', amt, ex.text, 'excluded by package');

    // PF rows: included in the package price (curated PF lines are the package's own fees;
    // clause-format packages include them via the 'pf' category)
    if (r.bucket === 'Professional Fees') {
      const catPf = coverage.categories?.set.includes('pf');
      const inc = coverage.pf.length > 0 || catPf;
      const src = coverage.pf[0]?.source ?? (catPf ? coverage.categories.source : null);
      return set(i, inc ? 'fully_included' : 'review', inc ? 0 : amt, src,
        inc ? 'professional fees included in package' : 'no curated PF line');
    }
    // stay-driven rows
    if (coveredIcu != null && ICU_ROWS.test(name)) {
      const rate = Number(r.rate?.[roomKey] ?? r.rate?.general ?? 0) || (drv.icu.selected ? amt / drv.icu.selected : 0);
      const extraDays = Math.max(0, drv.icu.selected - coveredIcu);
      return set(i, extraDays === 0 ? 'fully_included' : 'partially_included', extraDays * rate,
        coverage.stay.source, extraDays ? `${coveredIcu}d ICU covered, ${extraDays}d extra` : `${coveredIcu}d ICU covered`);
    }
    if (coveredWard != null && WARD_ROWS.test(name)) {
      const rate = Number(r.rate?.[roomKey] ?? r.rate?.general ?? 0) || (drv.ward.selected ? amt / drv.ward.selected : 0);
      const wardSel = /WARD CONSUMABLES/i.test(name) ? drv.los.selected : drv.ward.selected;
      const covered = /WARD CONSUMABLES/i.test(name) ? (coveredWard + (coveredIcu ?? 0)) : coveredWard;
      const extraDays = Math.max(0, wardSel - covered);
      return set(i, extraDays === 0 ? 'fully_included' : 'partially_included', extraDays * rate,
        coverage.stay.source, extraDays ? `${covered}d covered, ${extraDays}d extra` : `${covered}d covered`);
    }
    // item allowances (incl. procedure/OT/robotic rows)
    const slotMatch = r.otSlot?.label ? allowanceFor(r.otSlot.label) : null;
    const al = allowanceFor(name) || (r.code ? allowanceFor(r.code) : null) || slotMatch;
    if (al) {
      // OT rows matched via their slot label count in SLOTS (one slot used), not hours
      const qty = al === slotMatch ? 1 : (Number(r.qty?.selected ?? 1) || 1);
      if (qty <= al.qty) return set(i, 'fully_included', 0, al.source, `allowance ${al.qty}`);
      const unit = qty ? amt / qty : 0;
      return set(i, 'partially_included', (qty - al.qty) * unit, al.source, `${al.qty} covered, ${qty - al.qty} extra`);
    }
  });

  // ---- amount-capped buckets (proportional distribution across member rows) ----
  const capGroup = (memberPred, cap, label) => {
    if (!cap) return;
    const members = items.map((r, i) => ({ r, i })).filter(({ r, i }) => !out.has(i) && memberPred(r));
    const total = members.reduce((t, { r }) => t + sel(r), 0);
    if (!members.length) return;
    const payable = Math.max(0, total - cap.amount);
    for (const { r, i } of members) {
      const share = total > 0 ? sel(r) / total : 0;
      set(i, payable === 0 ? 'fully_included' : 'capped', payable * share, cap.source,
        payable === 0 ? `within ${label} cap ₹${cap.amount}` : `${label} cap ₹${cap.amount}, ₹${round2(payable)} beyond cap`);
    }
  };
  capGroup((r) => /IP Drugs|IP Consumables/i.test(r.name) && r.bucket === 'Pharmacy', coverage.caps.ip_pharmacy, 'IP pharmacy');
  capGroup((r) => /OT Drugs|OT Consumables/i.test(r.name) && r.bucket === 'Pharmacy', coverage.caps.ot_pharmacy, 'OT pharmacy');
  capGroup((r) => /^Implants$/i.test(r.name), coverage.caps.implants, 'implants');
  if (coverage.caps.investigations) {
    const capAmt = coverage.caps.investigations.rooms[roomKey] ??
      Object.values(coverage.caps.investigations.rooms)[0];
    capGroup((r) => r.bucket === 'Investigations', { amount: capAmt, source: coverage.caps.investigations.source }, 'investigations');
  }

  // ---- drug administration: 12.5% surcharge applies only on payable pharmacy ----
  items.forEach((r, i) => {
    if (out.has(i) || r.name !== 'Drug Administration Charges') return;
    const isCash = estimate.resolved_context.pricing_mode === 'Cash / TR1';
    const payablePharm = items.reduce((t, x, j) => (x.bucket === 'Pharmacy' && out.has(j) ? t + out.get(j).final_amount : t), 0);
    set(i, 'recomputed', isCash ? 0.125 * payablePharm : 0, null, 'recomputed on payable pharmacy only');
  });

  // ---- clause-format packages: whole categories included in the package price ----
  // (implants are deliberately never category-matched — they ride the exclusion
  // text, or stay payable when the text is silent)
  if (coverage.categories) {
    const catOf = (r) => {
      if (/^Implants$/i.test(r.name)) return null;
      if (r.bucket === 'Room Charges') return 'room';
      if (r.bucket === 'Pharmacy') return 'pharmacy';
      if (r.bucket === 'Investigations') return 'investigations';
      if (r.bucket === 'Professional Fees') return 'pf';
      if (r.bucket === 'Procedure / OT Charges') return 'ot';
      if (r.bucket === 'Bedside Services') return 'bedside';
      return null;
    };
    items.forEach((r, i) => {
      if (out.has(i) || r.addOn) return;
      const cat = catOf(r);
      if (cat && coverage.categories.set.includes(cat)) {
        set(i, 'fully_included', 0, coverage.categories.source, `${cat} covered by package inclusion clause`);
      }
    });
  }

  // ---- everything else ----
  items.forEach((r, i) => {
    if (out.has(i)) return;
    const amt = sel(r);
    if (amt === 0) return set(i, 'not_included', 0, null, 'not selected / zero');
    if (r.addOn) return set(i, 'not_included', amt, null, 'optional add-on — payable');
    set(i, 'review', amt, null, 'not found in curated inclusions — payable pending review');
  });

  const coverageRows = rows.map((r) => ({ ...r, ...out.get(r.index) }));
  const payableExtras = round2(coverageRows.reduce((t, r) => t + (r.final_amount ?? 0), 0));
  return {
    rows: coverageRows,
    totals: {
      without_package: round2(estimate.final_estimate),
      package_amount: null, // filled by caller
      payable_extras: payableExtras,
      with_package: null,   // filled by caller
    },
    parse: {
      mode: coverage.categories ? 'category-clause' : 'itemized-curated',
      categories: coverage.categories?.set ?? null,
      variants: coverage.variants,
      stay: coverage.stay,
      caps: Object.fromEntries(Object.entries(coverage.caps).map(([k, v]) => [k, v.amount ?? v.rooms])),
      allowances: coverage.allowances.length,
      exclusions: coverage.exclusions.length,
      unparsed: coverage.unparsed,
    },
  };
}
