// =======================================================
// WELLMODEL.APP — PHYSICS ENGINE  v3.4.9
// Gas Well Multiphase Flow Simulator
//
// CHANGES v3.4.9 vs v3.4.8:
//
//   FIX-F  Step D: WHP floor replaced by rate-collapse when column overloads
//     Root cause: the flowing pressure cascade (Step D) integrates from BHP
//     upward using the transient st.HL[] values.  When the transient column
//     is heavily loaded (mid-column slugs, HL_mean ≈ 0.55-0.60), the
//     integrated column weight can equal or exceed BHP-P_sep, producing
//     st.P[0] ≤ P_sep.  The previous code floored WHP to P_sep+3 and kept
//     st.qG at the current flowing rate — a clear energy-conservation
//     violation (gas flows but the column weight exactly consumes all
//     available drawdown).  WHP appeared pinned at P_sep+3 ("WHP at
//     maximum") regardless of column state.
//     Fix: after the cascade loop, when st.P[0] < P_sep+5 psi, collapse
//     st.qG to zero and write the actual (sub-floor) hydrostatic WHP to
//     state so the display reflects the true column pressure.  The
//     useColumnSolver flag then picks up qG=0 on the very next step.
//
//   FIX-G  Step C: marginal-stability kill at q_max_loaded
//     Root cause: the BHP_needed gate (introduced v3.4) correctly computes
//     the maximum rate at which the IPR-provided BHP can support the current
//     transient column weight: q_max_loaded.  But when qG_out is trimmed to
//     q_max_loaded it sits exactly at the stability limit (zero margin).
//     On the same step, Step D cascades from that BHP and lands at
//     st.P[0] ≈ P_sep — the marginal-stability symptom that FIX-F targets.
//     Fix: after the q_max_loaded clip, if qG_out/q_max_loaded > 0.98 (rate
//     within 2% of the zero-margin limit), collapse qG_out to zero.  This
//     makes Step C and Step D consistent: both say the well is dead when it
//     is at the edge of its column-support capacity.
//
// CHANGES v3.4.8 vs v3.4.7:
//
//   FIX-D  Regime monotonicity: annular below a liquid slug (physics)
//     Root cause: grayCorrelation classifies each cell on local KuG/Ngv/lamL
//     criteria with no global awareness of the wellbore topology.  In a
//     recovering or loaded transient the liquid inventory concentrates into a
//     mid-column slug (HL ~98%).  Deep cells below the slug have low HL (~8%)
//     and, at high in-situ pressure, a reduced KuG threshold — so they pass
//     the KuG≥3.1 annular criterion even though annular flow is physically
//     impossible below a liquid plug (it requires a continuous gas core from
//     bottom to surface).
//     Fix: before Step B, precompute a per-cell boolean liquidAboveFlag[j]:
//     true when any shallower cell (k < j) has HL > 0.55.  After the
//     grayCorrelation call inside the Step B loop, if liquidAboveFlag[j] is
//     set AND the classified regime is annular or churn, override C0 and Vd
//     to bubble parameters (C0=1.20, Vd=drift-flux bubble velocity at local
//     P/T/fluids).  This corrects the two drift-flux quantities that drive
//     gas-rise velocity and liquid-carry in intercell transport, eliminating
//     the ~170 psi holdup-driven pressure error in the deep cells.
//
//   FIX-E  Regime monotonicity: annular below a liquid slug (display)
//     transientToSegs reads st.HL[j] (already converged) and calls
//     grayCorrelation again purely for the display regime label.  The same
//     local-only logic produces annular labels below the slug.  A single
//     O(n) post-processing pass over the segs array scans top-to-bottom,
//     sets a flag when a liquid-dominated cell (HL > 0.55) is encountered,
//     and re-labels any subsequent annular/churn cell as bubble.  No pressure
//     or holdup values are touched — display-only change.
//
// CHANGES v3.2 vs v3.1:
//
//   FIX-A  Intercell liquid transport (Step B, flowing):
//     Root cause of excessive liquid accumulation.
//     Old: dVL_up = cf * vsl * Ap * HL * dt
//       This vanishes when HL is small (gas-dominated cell) even
//       though gas may be blasting through at 20+ ft/s dragging
//       all available liquid. cf * vsl * HL → ~0 in those cells.
//     New: dVL_up = vL_eff * Ap * HL * dt  where
//       vL_eff = vT  when above Turner (mist — gas drags all liquid)
//       vL_eff = (vsl/vG) * vG_drift  below Turner (slip-corrected)
//     Effect: above Turner the liquid transport velocity equals the
//     Turner droplet velocity (~3-5 ft/s), which correctly empties
//     gas-dominated cells of their small liquid volume each step.
//     This eliminates the "phantom liquid pool" at high gas rates.
//
//   FIX-B  Surface BC liquid exit (Step C):
//     Old: dVL_out = cf * HL_top * dVg_out
//       Same starvation: when cell[0] is gas-dominated HL_top≈0
//       so dVL_out≈0 regardless of carry fraction.
//     New: dVL_out uses velocity-based transport consistent with
//       intercell fix above. Also adds a mass-balance floor:
//       at minimum, what reservoir delivers × carry fraction exits,
//       drawing from the nearest occupied cells if cell[0] is empty.
//       This makes liquid egress self-consistent with influx.
//
//   FIX-C  Re-open liquid flush:
//     When well re-opens with BHP near Pr, the available pressure
//     differential is large enough to lift the liquid column.
//     Old: no flush — well sees full liquid load on first step,
//       operating point collapses, well stays dead.
//     New: on transition isShutIn→flowing, if BHP > Pwf_vlp at AOF,
//       distribute the excess pressure energy as a liquid flush:
//       flush fraction = min(0.80, (BHP - Pwf_vlp) / (rhoL * TD/144))
//       Applied proportionally bottom-up (gas + pressure lifts bottom
//       liquid first, as in real blowdown).
//
//   UNCHANGED from v3.1:
//     h_net, Gp_cum, tp_hr (Agarwal), all PVT, Gray, IPR/VLP nodal
// =======================================================
// =======================================================

var GC   = 32.174;   // ft·lbm/(lbf·s²)
var G_SI = 9.806;    // m/s²
var FT2M = 0.3048;   // ft → m

// -------------------------------------------------------
// Z-FACTOR: Papay (1985) + Standing (1981) pseudocritical
// -------------------------------------------------------
function papayZ(P, TR, sg) {
  var Ppc = 677 + 15 * sg - 37.5 * sg * sg;
  var Tpc = 168 + 325 * sg - 12.5 * sg * sg;
  var Ppr = Math.min(P / Ppc, 12);
  var Tpr = Math.max(TR / Tpc, 1.05);
  return Math.max(0.4, Math.min(1.2,
    1 - 3.52 * Ppr / Math.pow(10, 0.9813 * Tpr) +
    0.274 * Ppr * Ppr / Math.pow(10, 0.8157 * Tpr)));
}

function gasDen(P, TR, sg) {
  return 28.97 * sg * P / (10.73 * papayZ(P, TR, sg) * TR);
}

// -------------------------------------------------------
// GAS VISCOSITY: Lee-Gonzalez-Eakin (1966)
// -------------------------------------------------------
function leeGonzMuG(P, TR, sg) {
  var rG = gasDen(P, TR, sg), M = 28.97 * sg;
  var K  = (9.379 + 0.01607 * M) * Math.pow(TR, 1.5) / (209.2 + 19.26 * M + TR);
  var X  = 3.448 + 986.4 / TR + 0.01009 * M;
  var Y  = 2.447 - 0.2224 * X;
  return 1e-4 * K * Math.exp(X * Math.pow(rG / 62.428, Y));
}

// -------------------------------------------------------
// MOODY FRICTION FACTOR: Swamee-Jain (1976)
// -------------------------------------------------------
function moodyFF(Re, epsD) {
  if (Re < 1)    return 0.1;
  if (Re < 2300) return Math.max(64 / Re, 0.008);
  return Math.max(0.008, Math.min(0.1,
    0.25 / Math.pow(Math.log10(epsD / 3.7 + 5.74 / Math.pow(Re, 0.9)), 2)));
}

// -------------------------------------------------------
// GRAY (1974) DRIFT-FLUX + Duns-Ros regime map
// -------------------------------------------------------
function grayCorrelation(vsg, vsl, rL, rG, sig_dc, D_ft, muL_cp) {
  var vm   = vsg + vsl;
  var lamL = vsl / Math.max(vm, 1e-9);
  if (vm < 0.05 && vsg < 0.05)
    return { HL: lamL, regime: 'static', C0: 1.0, Vd: 0, Ngv: 0, KuG: 0, lamL: lamL };
  if (vsg < 0.01 && lamL > 0.80)
    return { HL: lamL, regime: 'static', C0: 1.0, Vd: 0, Ngv: 0, KuG: 0, lamL: lamL };

  var sig  = Math.max(sig_dc, 0.5);
  var Ngv  = 1.938 * vsg * Math.pow(rL / sig, 0.25);
  var rLsi = rL * 16.018, rGsi = rG * 16.018;
  var s_si = sig * 1e-3, D_m = D_ft * FT2M;
  var dR   = Math.max(rLsi - rGsi, 1);
  var KuG  = vsg * FT2M * Math.pow(rGsi / (G_SI * s_si * dR), 0.25);

  var regime, C0, Vd;
  if (KuG >= 3.1) {
    regime = 'annular'; C0 = 1.0; Vd = 0;
  } else if (KuG >= 1.5 || (Ngv > 7 && lamL < 0.30)) {
    regime = 'churn';  C0 = 1.15;
    Vd = 0.15 * Math.sqrt(G_SI * D_m * dR / rLsi) / FT2M;
  } else if (Ngv >= Math.max(0.2, 0.51 * Math.pow(100 * lamL + 1, 0.172)) || lamL < 0.40) {
    regime = 'slug';   C0 = 1.20;
    Vd = 0.35 * Math.sqrt(G_SI * D_m * dR / rLsi) / FT2M;
  } else if (lamL > 0.85 && Ngv < 0.5) {
    regime = 'static'; C0 = 1.0; Vd = 0;
  } else {
    regime = 'bubble'; C0 = 1.20;
    Vd = 1.53 * Math.pow(G_SI * s_si * dR / (rLsi * rLsi), 0.25) / FT2M;
  }

  var denom = C0 * vm + Vd;
  var HL    = Math.max(lamL, Math.min(0.99, 1 - vsg / Math.max(denom, 1e-9)));
  return { HL: HL, regime: regime, C0: C0, Vd: Vd, Ngv: Ngv, KuG: KuG, lamL: lamL };
}

// -------------------------------------------------------
// PRESSURE GRADIENTS: gravity + friction + acceleration
// -------------------------------------------------------
function pressureGrads(vsg, vsl, HL, rL, rG, muL, muG, D_ft, P) {
  var a    = Math.max(1 - HL, 0.005);
  var vG   = vsg / a, vL = vsl / Math.max(HL, 0.005);
  var rM   = rL * HL + rG * a;
  var epsD = 1.5e-4 / D_ft;
  var dPg  = rM / 144;
  var ReG  = rG * Math.abs(vG) * D_ft / Math.max(muG * 6.72e-4, 1e-12);
  var dPfG = moodyFF(ReG, epsD) * rG * vG * vG * a / (2 * GC * D_ft * 144);
  var ReL  = rL * Math.abs(vL) * D_ft / Math.max(muL * 6.72e-4, 1e-12);
  var dPfL = moodyFF(ReL, epsD) * rL * vL * vL * HL / (2 * GC * D_ft * 144);
  var Ek   = Math.max(0, Math.min(0.8, rM * (vsg + vsl) * vsg / Math.max(GC * P * 144, 1)));
  return { total: (dPg + dPfG + dPfL) / Math.max(1 - Ek, 0.2), grav: dPg, Ek: Ek };
}

// -------------------------------------------------------
// CHOKE: API 14B isentropic gas orifice
// -------------------------------------------------------
function computeWHP(qM, ck64, Ps, Tw, Zw, sg, P_tubing) {
  var k = 1.28, Cd = 0.85, TR = Tw + 459.67;
  if (ck64 <= 0) return P_tubing || Math.max(Ps + 5, 50);
  var d = ck64 / 64, A = Math.PI / 4 * d * d;
  var qK = qM * 1000, Pf = Math.max(Ps + 5, 50);
  if (qK <= 0) return P_tubing || Pf;
  var rc = Math.pow(2 / (k + 1), k / (k - 1));
  var sf = k * Math.pow(2 / (k + 1), (k + 1) / (k - 1));
  var sq = Math.sqrt(TR * Zw * sg);
  var Cc = 879 * Cd * A * Math.sqrt(sf);
  if (Cc <= 0) return P_tubing || Pf;
  var Wc = (qK * sq) / Cc;
  if (Wc <= 0) return P_tubing || Pf;
  if (Ps / Wc <= rc) return Math.max(Wc, Pf);
  var qS = function(Pu) {
    var r = Ps / Pu; if (r >= 1) return 0;
    var e = (2 * k / (k - 1)) * (Math.pow(r, 2 / k) - Math.pow(r, (k + 1) / k));
    return e <= 0 ? 0 : (Cc * Pu / sq) * Math.sqrt(e / sf);
  };
  var lo = Pf, hi = Math.max(Wc * 8, Pf * 4);
  for (var it = 0; qS(hi) < qK && it < 20; it++) hi *= 2;
  for (var i = 0; i < 50; i++) { var m = (lo + hi) / 2; if (qS(m) < qK) lo = m; else hi = m; }
  return Math.max((lo + hi) / 2, Pf);
}

function waterProps(T, S) {
  var sal  = S || 0;
  var rhoW = 62.4 * (1 + 0.695e-6 * sal) * (1 - Math.max(-0.02, Math.min(0.05, (T - 60) * 3.6e-4)));
  var muW  = Math.max(0.3, Math.exp(1.003 - 1.479e-2 * T + 1.982e-5 * T * T) * (1 + 1.5e-5 * sal));
  var sigW = 72 * (1 + 0.35e-6 * sal);
  return { rhoW: rhoW, muW: muW, sigW: sigW, cW: 4800 + 1.5 * sal / 1000 };
}

// -------------------------------------------------------
// THREE-PHASE CHOKE: Perkins (1993) mixture-sonic
// -------------------------------------------------------
function computeWHP2(qM, ck64, Ps, Tw, Zw, sg, wgr, cgr, salinity, P_tubing) {
  var Wg = computeWHP(qM, ck64, Ps, Tw, Zw, sg, P_tubing);
  if (qM <= 0 || ck64 <= 0) return Wg;
  var qWbpd = (wgr || 0) * qM, qCbpd = (cgr || 0) * qM;
  if (qWbpd + qCbpd < 1) return Wg;
  var wp   = waterProps(Tw, salinity || 0), TR = Tw + 459.67;
  var rhoG = gasDen(Math.max(Wg, 50), TR, sg);
  var qGf  = qM * 1e6 / 86400 * Zw * (TR / 520) * (14.7 / Math.max(Wg, 50));
  var qWf  = qWbpd * 5.615 / 86400, qCf = qCbpd * 5.615 / 86400;
  var qT   = qGf + qWf + qCf;
  var aG   = qGf / Math.max(qT, 1e-12), aL = (qWf + qCf) / Math.max(qT, 1e-12);
  var aW   = qWf / Math.max(qT, 1e-12), aC = qCf / Math.max(qT, 1e-12);
  var rhoM = aG * rhoG + aW * wp.rhoW + aC * 49.9;
  var kk   = 1.28;
  var cG   = Math.sqrt(kk * Math.max(Wg, 50) * 144 * GC / Math.max(rhoG, 0.1));
  var sInv = aG / (rhoG * cG * cG) + aW / (wp.rhoW * wp.cW * wp.cW) + aC / (49.9 * 3500 * 3500);
  var cM   = 1 / Math.sqrt(Math.max(rhoM * sInv, 1e-12));
  var eta  = 0.5 * (1 - aG);
  var Frho = Math.sqrt(1 + aL * Math.max(0, rhoM / Math.max(rhoG, 0.1) - 1));
  var Fsn  = Math.pow(Math.max(1, cG / Math.max(cM, 50)), eta);
  return Math.max(Wg * Math.min(5.0, Frho * Fsn), Ps + 5);
}

function wetGasSG(sg, cgr, P, Pd) {
  if (!cgr || cgr < 0.5 || Pd <= 0 || P < Pd) return sg;
  var G = 1e6 / cgr, Sc = 0.80, Ap = 141.5 / Sc - 131.5;
  var Mw = Math.max(70, 6084 / Math.max(Ap - 5.9, 1));
  return Math.max(sg, Math.min(1.2, (sg * G + 4584 * Sc) / (G + 133000 * Sc / Mw)));
}

function iprPwf(q, Pr, A, B) { var d = Pr*Pr - A*q - B*q*q; return d > 0 ? Math.sqrt(d) : 0; }
function computeAOF(Pr, A, B) {
  if (B <= 0) return A > 0 ? Pr * Pr / A : 50;
  return (-A + Math.sqrt(A * A + 4 * B * Pr * Pr)) / (2 * B);
}

function liquidProps(p) {
  var wV  = (p.wgr || 0) / Math.max((p.wgr || 0) + (p.cgr || 0), 0.01);
  var wp  = waterProps(p.T_surf || 85, p.salinity || 0);
  var sig = wp.sigW * wV + 20 * (1 - wV);
  if (p.foam_type && ((p.foam_batch_conc || 0) > 0 || p.foam_rate > 0)) {
    // Batch treatment: use foam_batch_conc when available (preferred), fall back to foam_rate
    var conc_bt = (p.foam_batch_conc || 0) > 0 ? p.foam_batch_conc : p.foam_rate;
    var sig_chem = foamSigma(sig, conc_bt, p.foam_type, p.T_surf || 85, p.salinity || 0);
    var eff = (p.foam_efficiency !== undefined ? Math.max(0, Math.min(100, p.foam_efficiency)) : 100) / 100;
    sig = sig - eff * (sig - sig_chem);
  } else if (p.foam_rate > 0) {
    // Legacy continuous foamer path (gal/Mscf scale, 0-5)
    sig = sig * Math.max(0.07, 1 - p.foam_rate * 0.18);
  }
  return {
    rL: wp.rhoW * wV + 49.9 * (1 - wV),
    muL: wp.muW * wV + 0.5 * (1 - wV),
    sig: sig, rhoW: wp.rhoW, rhoC: 49.9,
    cW: wp.cW, cC: 3500, sigW: wp.sigW
  };
}

function carryFractionMech(vsg, vsl, rhoL, rhoG, sig, D_ft, turnerC) {
  var TC = turnerC || 5.62;
  var drho = Math.max(rhoL - rhoG, 0.1);
  var vT   = TC * Math.pow(sig * drho / Math.max(rhoG * rhoG, 0.01), 0.25);
  var jL   = vsl * Math.sqrt(rhoL / (GC * D_ft * drho));
  var sqJL = Math.sqrt(Math.max(jL, 0));
  var x0   = 0.9 * (1 + 0.4 * sqJL), k = 8.0 * (1 + 0.5 * sqJL);
  var arg  = Math.max(-30, Math.min(30, -k * (vsg / Math.max(vT, 0.01) - x0)));
  return Math.max(0, Math.min(1, 1.0 / (1.0 + Math.exp(arg))));
}

// -------------------------------------------------------
// VLP / NODAL ANALYSIS
// -------------------------------------------------------
function outflowPwf(q, p, extraHL) {
  var eHL = extraHL || 0;
  var Dft = p.id_in / 12;
  var vs_on = p.vs_on && p.vs_id > 0 && p.vs_depth > 0;
  var Dvs = vs_on ? (p.vs_id / 12) : Dft;
  var vsd = vs_on ? Math.min(p.vs_depth, p.TD) : p.TD;
  var Apt = Math.PI * (Dft / 2) * (Dft / 2);
  var Apv = Math.PI * (Dvs / 2) * (Dvs / 2);
  var ps = p.P_sep || 250, ck = p.choke_64 || 32;
  var lp = liquidProps(p), rL = lp.rL, muL = lp.muL, sig = lp.sig;
  var WHP;
  if (q < 0.001) {
    WHP = ps;
  } else {
    var Tr = p.T_surf + 459.67;
    var Z1 = papayZ(Math.max(ps * 1.5 + 50, 80), Tr, p.sg);
    var W1 = computeWHP2(q, ck, ps, p.T_surf, Z1, p.sg, p.wgr, p.cgr, p.salinity);
    var Z2 = papayZ(Math.max(W1, 80), Tr, p.sg);
    WHP = Math.max(computeWHP2(q, ck, ps, p.T_surf, Z2, p.sg, p.wgr, p.cgr, p.salinity), ps + 5);
  }
  var qGs = q < 0.001 ? 0 : q * 1e6 / 86400;
  var qLs = ((p.wgr || 0) + (p.cgr || 0)) * q * 5.615 / 86400;
  var Nv = 15, dz = p.TD / Nv;
  function vGr(dep, P) {
    var inVS = vs_on && dep >= vsd;
    var Df = inVS ? Dvs : Dft, Ap = inVS ? Apv : Apt;
    var TF = p.T_surf + (p.geo_grad / 100) * dep, TR = TF + 459.67;
    var se = wetGasSG(p.sg, p.cgr, Math.max(P, 5), p.P_dew || 0);
    var z = papayZ(Math.max(P, 5), TR, se);
    var rG = gasDen(Math.max(P, 5), TR, se);
    var muG = leeGonzMuG(Math.max(P, 5), TR, se);
    var vs = qGs > 0 ? qGs * z * (TR / 520) * (14.7 / Math.max(P, 5)) / Ap : 0;
    var vl = qLs / Ap;
    var gr = grayCorrelation(vs, vl, rL, rG, sig, Df, muL);
    var HL = Math.min(0.98, gr.HL + eHL * (1 - gr.HL));
    return pressureGrads(vs, vl, HL, rL, rG, muL, muG, Df, Math.max(P, 5)).total;
  }
  var Pv = WHP;
  for (var i = 1; i <= Nv; i++) {
    var dt = (i - 1) * dz, dm = dt + dz * 0.5, Pt = Pv;
    var Pb = Pt + vGr(dt, Pt) * dz;
    for (var j = 0; j < 4; j++) {
      var Pm = Math.max((Pt + Pb) / 2, 5);
      var Pn = Pt + vGr(dm, Pm) * dz;
      if (Math.abs(Pn - Pb) < 0.1) { Pb = Pn; break; } Pb = Pn;
    }
    Pv = Math.max(Pb, Pt + 0.01);
  }
  return Pv;
}

function findOperatingPoint(p, A, B, extraHL) {
  A = A || 1; B = B || 0; var eHL = extraHL || 0;
  var Pr = p.Pr, qAOF = computeAOF(Pr, A, B);
  var res = function(q) { return iprPwf(q, Pr, A, B) - outflowPwf(q, p, eHL); };
  var nS = 200, qMin = 0.01, qH = Math.min(qAOF * 0.998, 100);
  var rH = null, rL2 = null;
  for (var i = nS; i >= 0; i--) {
    var q = qMin + (i / nS) * (qH - qMin);
    if (res(q) > 0) { rH = q; rL2 = qMin + ((i + 1) / nS) * (qH - qMin); break; }
  }
  if (rH === null) {
    if (res(qMin) <= 0) return { q_op: 0, pwf_op: outflowPwf(0, p, eHL), noFlow: true };
    rH = qH; rL2 = qH;
  }
  if (rL2 === null || rL2 <= rH) rL2 = Math.min(qH, rH + (qH - qMin) / nS);
  var lo = rH, hi = rL2;
  for (var j = 0; j < 60; j++) { var m = (lo + hi) / 2; if (res(m) > 0) lo = m; else hi = m; }
  return { q_op: (lo + hi) / 2, pwf_op: iprPwf((lo + hi) / 2, Pr, A, B), noFlow: false };
}

function buildNodalCurves(p, A, B, extraHL) {
  A = A || 1; B = B || 0; var eHL = extraHL || 0;
  var qAOF = Math.max(0.01, computeAOF(p.Pr, A, B));
  var qMax = Math.min(qAOF * 1.08, 100), pts = [];
  for (var i = 0; i <= 60; i++) {
    var q = (i / 60) * qMax;
    pts.push({ q: q, pi: iprPwf(q, p.Pr, A, B), po: outflowPwf(q, p, 0), poL: outflowPwf(q, p, eHL) });
  }
  return { pts: pts, qMax: qMax, qAOF: qAOF };
}

var NS = 30;
function computeProfile(p, t) {
  var Df = p.id_in / 12, A = Math.PI * (Df / 2) * (Df / 2);
  var ts = 3 * t * t - 2 * t * t * t;
  var qt = findOperatingPoint(p, p.A_F || 1, p.B_F || 0).q_op;
  var qG = qt * (0.12 + 0.88 * ts);
  var wB = p.wgr * qG, cB = p.cgr * qG, qL = wB + cB;
  var lp = liquidProps(p), rL = lp.rL, muL = lp.muL, sig = lp.sig;
  var ps = p.P_sep || 250, ck = p.choke_64 || 32, Tr = p.T_surf + 459.67;
  var Z1 = papayZ(Math.max(ps * 1.5 + 50, 80), Tr, p.sg);
  var W1 = computeWHP2(qG, ck, ps, p.T_surf, Z1, p.sg, p.wgr, p.cgr, p.salinity);
  var Z2 = papayZ(Math.max(W1, 80), Tr, p.sg);
  var W2 = computeWHP2(qG, ck, ps, p.T_surf, Z2, p.sg, p.wgr, p.cgr, p.salinity);
  var Wt = Math.max(Math.min(W2, p.Pr - 50), ps + 5);
  var qGs = qG * 1e6 / 86400, qLs = qL * 5.615 / 86400, dz = p.TD / NS;
  function sP(dep, P) {
    var TF = p.T_surf + (p.geo_grad / 100) * dep, TR2 = TF + 459.67;
    var se = wetGasSG(p.sg, p.cgr, P, p.P_dew || 0);
    var z = papayZ(P, TR2, se), rG = gasDen(P, TR2, se), muG = leeGonzMuG(P, TR2, se);
    var vs = qGs * z * (TR2 / 520) * (14.7 / P) / A, vl = qLs / A;
    var gr = grayCorrelation(vs, vl, rL, rG, sig, Df, muL);
    var gd = pressureGrads(vs, vl, gr.HL, rL, rG, muL, muG, Df, P);
    return { P: P, rG: rG, vs: vs, vl: vl, gr: gr, gd: gd,
             vT: (p.turner_const || 5.62) * Math.pow(sig * Math.max(rL - rG, 1) / Math.max(rG * rG, 0.01), 0.25), se: se };
  }
  var segs = [], Pc = Wt;
  for (var i = 0; i <= NS; i++) {
    var dep = i * dz;
    if (i === 0) {
      var s = sP(0, Pc);
      segs.push({ depth: 0, P: Pc, rG: s.rG, vsg: s.vs, vsl: s.vl, HL: s.gr.HL,
        regime: s.gr.regime, Ngv: s.gr.Ngv, KuG: s.gr.KuG, C0: s.gr.C0, Vd: s.gr.Vd,
        vT: s.vT, vTR: s.vs / Math.max(s.vT, 0.01), siPhase: 'flowing', sg_eff: s.se }); continue;
    }
    var dt2 = (i - 1) * dz, dm = dt2 + dz * 0.5, Pt2 = Pc;
    var s0 = sP(dt2, Pt2), Pb2 = Pt2 + s0.gd.total * dz;
    for (var j = 0; j < 5; j++) {
      var Pm2 = (Pt2 + Pb2) / 2, sm = sP(dm, Math.max(Pm2, 10)), Pn2 = Pt2 + sm.gd.total * dz;
      if (Math.abs(Pn2 - Pb2) < 0.1) { Pb2 = Pn2; break; } Pb2 = Pn2;
    }
    Pb2 = Math.max(Pb2, Pt2 + 0.01); Pc = Pb2;
    var s2 = sP(dep, Pc);
    segs.push({ depth: dep, P: Pc, rG: s2.rG, vsg: s2.vs, vsl: s2.vl, HL: s2.gr.HL,
      regime: s2.gr.regime, Ngv: s2.gr.Ngv, KuG: s2.gr.KuG, C0: s2.gr.C0, Vd: s2.gr.Vd,
      vT: s2.vT, vTR: s2.vs / Math.max(s2.vT, 0.01), siPhase: 'flowing', sg_eff: s2.se });
  }
  var rN = segs.length;
  return { segs: segs, WHP_t: Wt, Pwf: segs[segs.length - 1].P, qGmmscfd: qG, qLbpd: qL,
    waterBpd: wB, condBpd: cB,
    slugFrac:  segs.filter(function(s){return s.regime==='slug';}).length/rN,
    churnFrac: segs.filter(function(s){return s.regime==='churn';}).length/rN,
    bubbleFrac:segs.filter(function(s){return s.regime==='bubble';}).length/rN,
    vslSurf: segs[0].vsl, vsgSurf: segs[0].vsg, vTR: segs[0].vTR || 0,
    rL: rL, sig: sig, D_ft: Df, Pr: p.Pr, P_sep: ps };
}

// -------------------------------------------------------
// SLUG FREQUENCY — vertical gas well (Taylor bubble model)
// -------------------------------------------------------
function slugFreq(vsl, vsg, Df, rL, rG, sig) {
  var vm = vsl + vsg;
  if (vm < 0.01) return 0.05;

  var rhoL = rL || 62.4, rhoG = rG || 1.0, sigma = sig || 72;

  var rLsi = rhoL * 16.018, rGsi = rhoG * 16.018, D_m = Df * FT2M;
  var dRho = Math.max(rLsi - rGsi, 1);
  var Vd_t = 0.35 * Math.sqrt(G_SI * D_m * dRho / rLsi) / FT2M;

  var C0   = 1.20;
  var vslug = C0 * vm + Vd_t;

  var ls_D = 16;
  var ls   = ls_D * Df;

  var gr   = grayCorrelation(Math.max(vsg, 0.001), Math.max(vsl, 0.001),
             rhoL, rhoG, sigma, Df, 1.0);
  var HL   = gr.HL;

  var HL_body = Math.max(HL + 0.05, 0.25);
  var HL_pkt  = Math.max(0.02, 0.08 * HL);
  var denom   = Math.max(HL_body - HL_pkt, 0.01);
  var ratio   = Math.max(0.05, Math.min(20, (HL_body - HL) / denom));
  var lg      = ls * ratio;

  var T_unit  = (ls + lg) / Math.max(vslug, 0.01);
  var f       = 1.0 / Math.max(T_unit, 0.2);

  return Math.max(0.03, Math.min(3.0, f));
}

// -------------------------------------------------------
// SURFACE RATE FLUCTUATION from slug/churn flow
// -------------------------------------------------------
function surfFluct(ph, sF, cF, bF, vsl, vsg, Df, HL, rL, rG, sig) {
  var vm = vsl + vsg;

  if (sF < 0.05 && cF < 0.05) {
    var g = 1 + bF * 0.10 * Math.sin(ph * 1.3) + 0.03 * Math.sin(ph * 2.7);
    return { fL: Math.max(0.80, g), fG: Math.max(0.90, 2 - g) };
  }

  var f  = slugFreq(vsl, vsg, Df, rL, rG, sig);
  var cy = Math.max(0.2, 1.0 / f);

  var cycleIdx = Math.floor(ph / cy);
  var randAmp  = 1.0 + 0.30 * Math.sin(cycleIdx * 7.3917 + 2.1);
  var randTim  = 1.0 + 0.15 * Math.sin(cycleIdx * 13.8741 + 0.7);

  var sp = ((ph % (cy * randTim)) + cy) % (cy * randTim) / (cy * randTim);

  var HL_use   = HL !== undefined ? Math.max(0.01, Math.min(0.97, HL)) : Math.max(0.01, vsl / Math.max(vm, 0.01));
  var HL_pkt   = Math.max(0.02, 0.08 * HL_use);
  var gp       = Math.max(0.10, Math.min(0.85, (1 - HL_use) / Math.max(1 - HL_pkt, 0.01)));

  var HL_body  = Math.min(0.95, HL_use + (1 - HL_use) * gp / Math.max(1 - gp, 0.01) * (1 - HL_pkt));
  HL_body      = Math.max(HL_use + 0.05, Math.min(0.95, HL_body));

  var fG_pocket = Math.max(1.0, (1 - HL_pkt)  / Math.max(1 - HL_use, 0.01));
  var fL_slug   = Math.max(1.0, HL_body        / Math.max(HL_use,     0.01));
  fG_pocket = 1 + (fG_pocket - 1) * randAmp;
  fL_slug   = 1 + (fL_slug   - 1) * randAmp;

  var sL, sG;
  if (sp < gp) {
    var ep = Math.sin(Math.PI * sp / Math.max(gp, 0.01));
    sG = 1.0 + (fG_pocket - 1) * ep;
    sL = Math.max(0.02, 1.0 - (1 - 1.0/Math.max(fL_slug, 1)) * ep);
  } else {
    var es = Math.sin(Math.PI * (sp - gp) / Math.max(1 - gp, 0.01));
    sL = 1.0 + (fL_slug   - 1) * es;
    sG = Math.max(0.05, 1.0 - (1 - 1.0/Math.max(fG_pocket, 1)) * es);
  }

  var cL = 1 + 0.50 * Math.sin(ph * 2.1 * randAmp);
  var cG = 2 - cL;

  var rest = Math.max(0, 1 - sF - cF - bF);
  return {
    fL: Math.max(0.01, sF * sL + cF * cL + bF + rest),
    fG: Math.max(0.05, sF * sG + cF * cG + bF + rest),
    gp: gp, slugFreqHz: f
  };
}

// =======================================================
// TRANSIENT ENGINE v3.1 — PER-CELL MASS BALANCE
// =======================================================

var TNC = 60;

function gasMassToP(mG, TR, sg, Vg) {
  if (mG <= 0 || Vg <= 0) return 14.7;
  var Mw = 28.97 * sg, n = mG / Mw, R = 10.73, P = 14.7;
  for (var i = 0; i < 15; i++) {
    var Z = papayZ(Math.max(P, 14.7), TR, sg);
    var Pn = n * Z * R * TR / Vg;
    if (Math.abs(Pn - P) < 0.5) { P = Pn; break; }
    P = Pn;
  }
  return Math.max(14.7, Math.min(P, 80000));
}

// -------------------------------------------------------
// RADIAL RESERVOIR GRID — replaces Horner PBU shortcut
// -------------------------------------------------------
// Gas radial diffusion on a log-spaced finite-volume grid from rw to re.
// Cell pressures evolve via implicit (linearized) Darcy-radial flux in the
// p²-formulation; well draws from innermost cell; outer boundary Dirichlet at Pr.
// Uses the user's A_F as the fundamental transmissibility parameter:
//   Tr = ln(re/rw) / A_F  [MMscfd per psi²·dlnR-unit]
// This guarantees that steady-state grid behaviour reproduces the user's IPR.
// Skin lives at the cell-0 → sandface interface (not in intercell fluxes).
// Implicit Thomas solve is unconditionally stable for any engine dt.
var N_RES = 20;  // radial cells

function createReservoirState(p) {
  var N  = N_RES;
  var rw = 0.354;
  var re = Math.max(100, p.r_e || 1500);
  var h  = Math.max(5, p.h_net || Math.min(100, Math.max(20, p.TD * 0.01)));
  var phi = Math.max(0.01, Math.min(0.45, p.porosity || 0.15));

  var lnStep = Math.log(re / rw) / N;
  var r_face = new Array(N + 1);
  var r_cell = new Array(N);
  var V_pore = new Array(N);

  for (var i = 0; i <= N; i++) r_face[i] = rw * Math.exp(i * lnStep);
  for (var j = 0; j < N; j++) {
    r_cell[j] = Math.sqrt(r_face[j] * r_face[j + 1]);
    V_pore[j] = Math.PI * (r_face[j + 1] * r_face[j + 1] - r_face[j] * r_face[j]) * h * phi;
  }

  return {
    N: N, rw: rw, re: re, h_net: h, phi: phi,
    r_face: r_face, r_cell: r_cell, V_pore: V_pore,
    P: new Array(N).fill(p.Pr)
  };
}

// Steady-state radial Darcy drawdown profile (used when initializing into flowing state):
//   P(r)² = BHP² + (Pr² - BHP²) × ln(r/rw) / ln(re/rw)
function initReservoirSteady(res, p, BHP) {
  var lnReRw = Math.log(res.re / res.rw);
  var BHP2   = BHP * BHP, Pr2 = p.Pr * p.Pr;
  for (var i = 0; i < res.N; i++) {
    var f  = Math.log(res.r_cell[i] / res.rw) / lnReRw;
    if (f < 0) f = 0; if (f > 1) f = 1;
    var P2 = BHP2 + (Pr2 - BHP2) * f;
    res.P[i] = Math.sqrt(Math.max(14.7 * 14.7, P2));
  }
}

// Effective A coefficient from cell-0 to sandface (includes skin).
// A_local = A_F × (ln(r_cell_0 / rw) + S) / ln(re/rw)
function reservoirAinner(res, p) {
  var A_F    = Math.max(0.01, p.A_F || 1);
  var lnReRw = Math.log(res.re / res.rw);
  var S      = p.skin || 0;
  return A_F * (Math.log(res.r_cell[0] / res.rw) + S) / lnReRw;
}

// Well rate (MMscfd) drawn from innermost cell given BHP.
// Uses Forchheimer with A_local including skin; q = 0 if BHP >= P_cell[0].
function reservoirIPR(res, p, BHP) {
  var P0  = res.P[0];
  var dP2 = P0 * P0 - BHP * BHP;
  if (dP2 <= 0) return 0;
  var A_loc = reservoirAinner(res, p);
  var B     = p.B_F || 0;
  if (B > 1e-6) {
    return (-A_loc + Math.sqrt(A_loc * A_loc + 4 * B * dP2)) / (2 * B);
  }
  return A_loc > 0 ? dP2 / A_loc : 0;
}

// Implicit (linearized) radial gas diffusion step. Tridiagonal via Thomas.
// q_well_mmscfd > 0 removes gas at r_cell[0]; q_well = 0 during shut-in.
// Outer boundary: Dirichlet at p.Pr (infinite-acting).
function stepReservoir(res, p, q_well_mmscfd, dt) {
  var N      = res.N;
  var rw     = res.rw, re = res.re;
  var lnReRw = Math.log(re / rw);
  var A_F    = Math.max(0.01, p.A_F || 1);
  var Tr     = lnReRw / A_F;  // MMscfd per (psi² × dlnR-unit)

  // Gas properties evaluated at grid-average pressure (p² formulation's
  // μZ≈const assumption; re-evaluated each step for nonlinearity).
  var P_avg = 0;
  for (var i0 = 0; i0 < N; i0++) P_avg += res.P[i0];
  P_avg = Math.max(14.7, P_avg / N);

  var T_res  = p.T_surf + (p.geo_grad / 100) * p.TD + 459.67;
  var Z_res  = papayZ(P_avg, T_res, p.sg);
  // K_conv relates d(gas_content_scf) to dP × V_pore : G = V_pore × P × 520/(14.65 × Z × T)
  var K_conv = 35.49 / (Z_res * T_res);  // scf/(ft³·psi)

  var dt_day = dt / 86400;

  // Tridiagonal: a_i × ΔP_{i-1} + b_i × ΔP_i + c_i × ΔP_{i+1} = d_i
  // Derivation:
  //   V_i × K_conv × ΔP_i = dt_day × 1e6 × Σ(flux^n + Δflux_linearized)
  //   flux = Tr × (P_a² - P_b²)/dlnR;  Δflux = (2Tr/dlnR) × (P_a ΔP_a - P_b ΔP_b)
  //   coef = 2 × Tr × 1e6 × dt_day / dlnR
  //   Moving Δ terms to LHS:
  //     a_i  = -coef_L × P_{i-1}
  //     b_i  = V_i×K_conv + (coef_L + coef_R) × P_i
  //     c_i  = -coef_R × P_{i+1}
  //     d_i  = 1e6 × dt_day × (flux_L^n - flux_R^n)

  var a = new Array(N).fill(0);
  var b = new Array(N);
  var c = new Array(N).fill(0);
  var d = new Array(N).fill(0);

  for (var i1 = 0; i1 < N; i1++) b[i1] = res.V_pore[i1] * K_conv;

  // Interior interfaces (between cell k and k+1)
  for (var k = 0; k < N - 1; k++) {
    var dlnR_k = Math.log(res.r_cell[k + 1] / res.r_cell[k]);
    var fn_k   = Tr * (res.P[k] * res.P[k] - res.P[k + 1] * res.P[k + 1]) / dlnR_k;  // MMscfd, k→k+1
    var coef_k = 2 * Tr * 1e6 * dt_day / dlnR_k;
    var f_ex_k = fn_k * 1e6 * dt_day;

    d[k]     -= f_ex_k;   // cell k loses (right flux)
    d[k + 1] += f_ex_k;   // cell k+1 gains (left flux)

    // Implicit linearization contributions
    b[k]     += coef_k * res.P[k];
    c[k]      = -coef_k * res.P[k + 1];
    a[k + 1]  = -coef_k * res.P[k];
    b[k + 1] += coef_k * res.P[k + 1];
  }

  // Outer boundary: Dirichlet at p.Pr (ΔP_boundary = 0)
  var dlnR_out = Math.log(re / res.r_cell[N - 1]);
  var fn_out   = Tr * (res.P[N - 1] * res.P[N - 1] - p.Pr * p.Pr) / dlnR_out;  // MMscfd out of N-1
  var coef_out = 2 * Tr * 1e6 * dt_day / dlnR_out;
  d[N - 1] -= fn_out * 1e6 * dt_day;
  b[N - 1] += coef_out * res.P[N - 1];

  // Inner boundary: well sink at cell 0 (explicit in q_well for this step;
  // BHP dynamics handled by the wellbore tank equation in Step D).
  d[0] -= q_well_mmscfd * 1e6 * dt_day;

  // Thomas forward sweep
  for (var i2 = 1; i2 < N; i2++) {
    var m = a[i2] / b[i2 - 1];
    b[i2] -= m * c[i2 - 1];
    d[i2] -= m * d[i2 - 1];
  }
  // Back substitution
  var dP = new Array(N);
  dP[N - 1] = d[N - 1] / b[N - 1];
  for (var i3 = N - 2; i3 >= 0; i3--) {
    dP[i3] = (d[i3] - c[i3] * dP[i3 + 1]) / b[i3];
  }

  // Apply with physical bounds. Outer BC is Dirichlet at Pr, so by maximum
  // principle for the diffusion equation, interior cell pressures should
  // remain ≤ Pr at all times during infinite-acting (no-production) behaviour.
  // (Previously we allowed Pr*1.02 as slack for linearization error, but that
  // let BHP follow over Pr during PBU — strict cap is correct.)
  var P_max = p.Pr;
  for (var i4 = 0; i4 < N; i4++) {
    var P_new = res.P[i4] + dP[i4];
    if (P_new < 14.7)   P_new = 14.7;
    if (P_new > P_max)  P_new = P_max;
    res.P[i4] = P_new;
  }

  return { P_near: res.P[0], P_avg: P_avg };
}


function createTransientState(NC) {
  return {
    NC: NC,
    mG: new Array(NC).fill(0),
    VL: new Array(NC).fill(0),
    P:  new Array(NC).fill(250),
    HL: new Array(NC).fill(0),
    Gamma: new Array(NC).fill(0),   // foam quality per cell Γ∈[0,Γ_s] — Session B, foam.js
    vm: new Array(NC).fill(0),
    qG: 0, Vliq: 0, WHP: 250, BHP: 3200,
    qLiqIn: 0, qLiqOut: 0, VliqEquil: 0,
    // v3.4.5: exponentially-smoothed rates for display (slug-flow averaging)
    qLiqIn_ema: 0, qLiqOut_ema: 0, qG_ema: 0,
    carryFrac: 1, turnerRatio: 0,
    stateLabel: 'static', isShutIn: true, simTime: 0,
    slugTopFrac: 0, churnTopFrac: 0, bubbleTopFrac: 0,
    slugFreqHz: 0, slugLiquidVol_bbl: 0, qSlugExtra: 0,
    clampHits: 0, bracketMisses: 0,
    qLiqDrain: 0,
    HL_mid: 0,
    // v3.1: material-balance equivalent producing time
    Gp_cum: 0,          // cumulative gas produced [MMscf]
    tp_hr: 0,           // Agarwal equivalent time [hr] = Gp_cum*24/q_current
    // Horner PBU fields (retained for UI backwards compat; populated as diagnostics
    // only — the actual PBU dynamics are now driven by the radial reservoir grid)
    t_shutin: 0,
    q_shutin: 0,
    m_horner: 0,
    Pwf_shutin: 0,
    // v3.3: radial reservoir grid (created/seeded in initTransientState)
    res: null
  };
}

function initTransientState(st, p) {
  var NC = st.NC, D_ft = p.id_in / 12;
  var Ap = Math.PI * (D_ft / 2) * (D_ft / 2);
  var dz = p.TD / NC, cellVol = Ap * dz;
  var lp = liquidProps(p);
  var rw = 0.354, lnReRw = Math.log(Math.max((p.r_e || 1000), 10) / rw);
  var skinMult = 1 + (p.skin || 0) / Math.max(lnReRw, 1);
  var A_eff = (p.A_F || 1) * skinMult, B_eff = p.B_F || 0;

  st.simTime = 0; st.isShutIn = true; st.stateLabel = 'static';
  st.qG = 0; st.carryFrac = 1; st.turnerRatio = 0;
  st.qLiqIn = 0; st.qLiqOut = 0; st.VliqEquil = 0;
  st.qLiqIn_ema = 0; st.qLiqOut_ema = 0; st.qG_ema = 0;
  st.slugTopFrac = st.churnTopFrac = st.bubbleTopFrac = 0;
  st.slugFreqHz = 0; st.slugLiquidVol_bbl = 0; st.qSlugExtra = 0;
  // v3.1: reset cumulative production on full init
  st.Gp_cum = 0; st.tp_hr = 0;

  var op = findOperatingPoint(p, A_eff, B_eff, 0);
  var qG = op.noFlow ? 0 : op.q_op;
  st.qG  = qG;

  // v3.3: create radial reservoir grid, default to uniform Pr
  st.res = createReservoirState(p);

  if (qG < 0.001) {
    var TR_avg = p.T_surf + (p.geo_grad / 100) * p.TD * 0.5 + 459.67;
    var rG_avg = gasDen(p.Pr * 0.85, TR_avg, p.sg);
    var WHP_ag = p.Pr - rG_avg * p.TD / 144;
    var hL_eq  = (WHP_ag > 50) ? 0 :
      Math.min(Math.max(0, (p.Pr * 144 - rG_avg * p.TD) / Math.max(lp.rL - rG_avg, 1)), p.TD * 0.8);
    var Vrem = hL_eq * Ap;
    for (var jh = NC - 1; jh >= 0; jh--) {
      var z_jh = (jh + 0.5) * dz;
      var TR_jh = p.T_surf + (p.geo_grad / 100) * z_jh + 459.67;
      var P_est = Math.max(14.7, p.Pr - lp.rL * (p.TD - z_jh) / 144);
      st.VL[jh]  = Math.min(Vrem, cellVol * 0.95); Vrem = Math.max(0, Vrem - st.VL[jh]);
      var Vg_jh  = Math.max(cellVol - st.VL[jh], cellVol * 0.01);
      st.mG[jh]  = gasDen(P_est, TR_jh, p.sg) * Vg_jh;
      st.P[jh]   = gasMassToP(st.mG[jh], TR_jh, p.sg, Vg_jh);
      st.HL[jh]  = st.VL[jh] / cellVol;
      st.vm[jh]  = 0;
    }
    st.WHP = st.P[0]; st.BHP = st.P[NC - 1];
    st.Vliq = hL_eq * Ap / 5.615;
    return;
  }

  var Tr0 = p.T_surf + 459.67;
  var Z0  = papayZ(Math.max((p.P_sep || 250) * 1.5 + 50, 80), Tr0, p.sg);
  var WHP = Math.max(computeWHP2(qG, p.choke_64 || 32, p.P_sep || 250,
              p.T_surf, Z0, p.sg, p.wgr, p.cgr, p.salinity), (p.P_sep || 250) + 5);
  var qGs = qG * 1e6 / 86400;
  var qLs = ((p.wgr || 0) + (p.cgr || 0)) * qG * 5.615 / 86400;
  var Vliq_acc = 0;
  st.P[0] = WHP;

  for (var j = 0; j < NC; j++) {
    var z_j  = (j + 0.5) * dz;
    var TR_j = p.T_surf + (p.geo_grad / 100) * z_j + 459.67;
    var Pj   = Math.max(st.P[j] || WHP, 14.7);
    var se   = wetGasSG(p.sg, p.cgr, Pj, p.P_dew || 0);
    var Zj   = papayZ(Pj, TR_j, se);
    var rGj  = gasDen(Pj, TR_j, se);
    var muGj = leeGonzMuG(Pj, TR_j, se);
    var vsg  = qGs * Zj * (TR_j / 520) * (14.7 / Pj) / Ap;
    var vsl  = qLs / Ap;
    var gr   = grayCorrelation(Math.max(vsg, 0.001), Math.max(vsl, 0.001), lp.rL, rGj, lp.sig, D_ft, lp.muL);
    st.VL[j]  = gr.HL * cellVol;
    var Vg_j  = Math.max(cellVol - st.VL[j], cellVol * 0.01);
    st.mG[j]  = rGj * Vg_j;
    st.P[j]   = gasMassToP(st.mG[j], TR_j, p.sg, Vg_j);
    st.HL[j]  = gr.HL;
    st.vm[j]  = vsg + vsl;
    Vliq_acc += st.VL[j] / 5.615;
    if (j < NC - 1) {
      var pg = pressureGrads(vsg, vsl, gr.HL, lp.rL, rGj, lp.muL, muGj, D_ft, Pj);
      st.P[j + 1] = Math.max(14.7, Pj + pg.total * dz);
    }
  }
  st.WHP = st.P[0]; st.BHP = st.P[NC - 1]; st.Vliq = Vliq_acc;
  st.qLiqDrain = 0;

  // v3.3: seed reservoir with steady-state drawdown profile matching BHP.
  // Otherwise the grid starts uniformly at Pr and spends the first seconds
  // of simulation just drawing down cell 0 — cosmetic but ugly transient.
  initReservoirSteady(st.res, p, st.BHP);
}

// -------------------------------------------------------
// SHUT-IN COLUMN EQUILIBRATION (v3.4)
// -------------------------------------------------------
// Replaces the single-P/single-T "lumped tank + cascade" PBU update with a
// self-consistent compressible hydrostatic column solve.
//
// Why: on PBU time scales (minutes to days), vertical pressure waves in the
// gas column travel at sonic speed (12,000 ft / 1500 ft/s ≈ 8 s), so the
// column is always in hydrostatic equilibrium.  What changes is the total
// gas mass in the column (reservoir afterflow adds mass).  Given total mass,
// there is exactly one hydrostatic profile consistent with it; we solve for
// it directly.
//
// Unknowns: P[0..NC-1] (NC values)
// Knowns:   T[k], HL[k], V_gas[k], ρ_liquid, mG_total
// Equations:
//   (1) P_k = P_{k+1} - ρ_mix(P_k, T_k, HL_k) · dz / 144     [hydrostatic cascade]
//   (2) Σ ρ_g(P_k, T_k) · V_gas[k] = mG_total                [mass conservation]
//
// We parametrize on BHP (= P[NC-1]) and bisect on (2).
//
// This formulation has no Z in any denominator in a way that could double-
// count — gas density comes directly from ρ_g(P,T,sg) = Mw·P/(Z·R·T) which
// is self-consistent by construction.
//
// ── KNOWN LIMITATION (v3.4) ──────────────────────────────────────
// At the exact moment of shut-in, BHP briefly dips (~300-500 psi for deep
// gas wells at high rate) before recovering.  Root cause: the pre-existing
// flowing-state pressure cascade (Step D, else-branch) produces P[k] values
// in the upper cells that are not fully mass-consistent with the BHP (it
// does a downward cascade, then overrides P[0] with max(P_sep+3, P[0]) which
// can break the ladder mid-column).  The new shut-in solver reads those
// slightly-inconsistent mG[k] values, totals them, and finds the hydrostatic
// BHP matching that total — which ends up lower than the flowing BHP that
// carried an artificial friction signature.
//
// Effect: a single-step transient at t=0 of shut-in; resolved by t~30 sec
// as afterflow rebuilds mass.  Does not affect long-term PBU shape or final
// pressures — 6 hr, 1 day, 90 day recovery values are physically correct
// to within 1-2 psi.  Flagged here to make future work on the flowing-state
// cascade traceable.
// ───────────────────────────────────────────────────────────────────

// Given a trial BHP, cascade upward with proper ρ_mix(P_k) and return the
// total gas mass in the column.  T_arr is precomputed per-cell absolute T [R].
function columnGasMassGivenBHP(BHP, st, p, T_arr, rhoL, cellVol) {
  var NC = st.NC;
  var dz = p.TD / NC;
  var P = new Array(NC);
  P[NC - 1] = Math.max(BHP, 14.7);

  // Upward cascade.  ρ_mix depends on local P via gas density; we iterate
  // once per cell (fixed-point, converges in 1-2 iterations because gas
  // density is a weak function of pressure over one cell's dz).
  for (var k = NC - 2; k >= 0; k--) {
    var T_k  = T_arr[k];
    var HL_k = st.HL[k];
    // Initial guess: P_k ≈ P_{k+1} (neglect hydrostatic first)
    var P_guess = P[k + 1];
    for (var it = 0; it < 3; it++) {
      var rG    = gasDen(Math.max(P_guess, 14.7), T_k, p.sg);
      var rMix  = rhoL * HL_k + rG * (1 - HL_k);
      P_guess   = Math.max(14.7, P[k + 1] - rMix * dz / 144);
    }
    P[k] = P_guess;
  }

  // Sum gas mass across all cells
  var mG_tot = 0;
  for (var km = 0; km < NC; km++) {
    var T_km  = T_arr[km];
    var Vg_km = Math.max(cellVol - st.VL[km], cellVol * 0.005);
    var rG_km = gasDen(Math.max(P[km], 14.7), T_km, p.sg);
    mG_tot += rG_km * Vg_km;
  }

  return { mG_tot: mG_tot, P: P };
}

// Solve for BHP such that column gas mass matches target.  Monotonic in BHP
// (higher BHP → more mass everywhere via higher gas density), so bisection
// is robust.  Returns { BHP, P[] }.
function solveColumnBHP(mG_target, st, p, T_arr, rhoL, cellVol) {
  // Brackets: BHP must lie between atmospheric and ~Pr.  Use generous bounds.
  var BHP_lo = 14.7;
  var BHP_hi = Math.max(p.Pr * 1.2, st.BHP * 1.5, 100);

  // Check brackets
  var res_lo = columnGasMassGivenBHP(BHP_lo, st, p, T_arr, rhoL, cellVol);
  var res_hi = columnGasMassGivenBHP(BHP_hi, st, p, T_arr, rhoL, cellVol);

  // If target is outside brackets, clip to the closer end (should only happen
  // at simulation edges with very low mass or pathological params)
  if (mG_target <= res_lo.mG_tot) return { BHP: BHP_lo, P: res_lo.P };
  if (mG_target >= res_hi.mG_tot) {
    // Expand upper bracket once if needed
    BHP_hi = BHP_hi * 2;
    res_hi = columnGasMassGivenBHP(BHP_hi, st, p, T_arr, rhoL, cellVol);
    if (mG_target >= res_hi.mG_tot) return { BHP: BHP_hi, P: res_hi.P };
  }

  // Bisection to 0.01 psi
  for (var it = 0; it < 40; it++) {
    var BHP_mid = 0.5 * (BHP_lo + BHP_hi);
    var res_mid = columnGasMassGivenBHP(BHP_mid, st, p, T_arr, rhoL, cellVol);
    if (res_mid.mG_tot < mG_target) {
      BHP_lo = BHP_mid;
    } else {
      BHP_hi = BHP_mid;
    }
    if ((BHP_hi - BHP_lo) < 0.01) {
      return { BHP: BHP_mid, P: res_mid.P };
    }
  }
  var BHP_final = 0.5 * (BHP_lo + BHP_hi);
  var res_final = columnGasMassGivenBHP(BHP_final, st, p, T_arr, rhoL, cellVol);
  return { BHP: BHP_final, P: res_final.P };
}

// Top-pinned hydrostatic cascade — for dead-flowing wells where WHP is held
// at P_sep by an open choke.  Cascades downward from P[0] = WHP_top using
// local ρ_mix(P,T,HL).  Returns {P[], mG_tot} so caller can compute how much
// mass had to vent through the choke to reach this state.
function columnCascadeFromTop(WHP_top, st, p, T_arr, rhoL, cellVol) {
  var NC = st.NC;
  var dz = p.TD / NC;
  var P = new Array(NC);
  P[0] = Math.max(WHP_top, 14.7);

  for (var k = 1; k < NC; k++) {
    var T_k  = T_arr[k];
    var HL_k = st.HL[k];
    // Fixed-point over ρ_mix(P_k) — 2-3 iterations suffice because gas
    // density varies weakly across one cell at a constant liquid holdup.
    var P_guess = P[k - 1];
    for (var it = 0; it < 3; it++) {
      var rG   = gasDen(Math.max(P_guess, 14.7), T_k, p.sg);
      var rMix = rhoL * HL_k + rG * (1 - HL_k);
      P_guess  = Math.max(14.7, P[k - 1] + rMix * dz / 144);
    }
    P[k] = P_guess;
  }

  var mG_tot = 0;
  for (var km = 0; km < NC; km++) {
    var Vg_km = Math.max(cellVol - st.VL[km], cellVol * 0.005);
    var rG_km = gasDen(Math.max(P[km], 14.7), T_arr[km], p.sg);
    mG_tot += rG_km * Vg_km;
  }
  return { P: P, mG_tot: mG_tot };
}

// -------------------------------------------------------
// STEP TRANSIENT v3.1
// -------------------------------------------------------
function stepTransient(st, p, dt) {
  var NC = st.NC, D_ft = p.id_in / 12;
  var Ap = Math.PI * (D_ft / 2) * (D_ft / 2);
  var dz = p.TD / NC, cellVol = Ap * dz;
  var dtHr = dt / 3600;
  var lp   = liquidProps(p);
  var rhoL = lp.rL;
  var Mw   = 28.97 * p.sg;
  // Capture flowing rate BEFORE any step logic modifies st.qG.
  // st.qG is zeroed at the bottom of Step C (which is skipped when shut-in),
  // so by the time the state-label block runs it is already 0.
  // We use qG_prev below to set q_shutin correctly.
  var qG_prev = st.qG;
  var rw   = 0.354, lnReRw = Math.log(Math.max((p.r_e || 1000), 10) / rw);
  var skinMult = 1 + (p.skin || 0) / Math.max(lnReRw, 1);
  var A_eff = (p.A_F || 1) * skinMult, B_eff = p.B_F || 0;

  // ── A. RESERVOIR BOUNDARY ─────────────────────────────────
  var BHP_cur = st.P[NC - 1];

  // v3.3: reservoir near-wellbore pressure from the radial diffusion grid.
  // Replaces the Horner approximation — P_eff is now a real state variable
  // that diffuses from the far field on the physical time scale η = k/(φμc_t).
  // Safety: if the grid hasn't been created (legacy call path), fall back to Pr
  // so we don't crash.
  var resGrid = st.res;
  var P_eff;
  if (resGrid && resGrid.P) {
    P_eff = resGrid.P[0];
  } else {
    P_eff = p.Pr;
  }

  var dP2   = P_eff * P_eff - BHP_cur * BHP_cur;
  var q_res = 0;

  if (Math.abs(dP2) > 1) {
    // Local IPR from cell 0 to sandface (includes skin via reservoirAinner).
    // For flowing mode we still honour the user's A_eff (which equals the
    // full-radius A_F × skinMult at steady state because the grid, at SS,
    // matches the full Darcy profile). So for q_res we use the local coefficient
    // against P_cell[0], which naturally reduces to the correct IPR at SS.
    var A_use, B_use;
    if (resGrid) {
      A_use = reservoirAinner(resGrid, p);
      B_use = p.B_F || 0;
    } else {
      // Legacy fallback: use the old full-radius coefficients
      A_use = st.isShutIn ? (p.A_F || 1) : A_eff;
      B_use = st.isShutIn ? (p.B_F || 0) : B_eff;
    }

    if (dP2 > 0) {
      if (B_use > 1e-6) {
        q_res = (-A_use + Math.sqrt(A_use * A_use + 4 * B_use * dP2)) / (2 * B_use);
      } else {
        q_res = A_use > 0 ? dP2 / A_use : 0;
      }
      // Cap at AOF computed from CURRENT P_cell[0] (not fixed Pr) so depletion
      // of the near-well zone limits the well properly.
      var AOF_local = computeAOF(P_eff, A_use, B_use);
      if (q_res > AOF_local) q_res = AOF_local;
      if (q_res < 0) q_res = 0;
    } else {
      // Leakoff: BHP > P_cell[0], liquid leaks into reservoir
      var dP_leak   = BHP_cur - P_eff;
      var h_perf    = Math.max(5, p.h_net || Math.min(100, Math.max(20, p.TD * 0.01)));
      var q_liq_out = (p.k_md || 5) * h_perf * dP_leak /
                      (141.2 * lp.muL * lnReRw);
      q_liq_out = Math.min(q_liq_out, 500);
      var dVL_leak  = Math.min(q_liq_out * 5.615 / 86400 * dt, st.VL[NC - 1] * 0.95);
      st.VL[NC - 1] = Math.max(0, st.VL[NC - 1] - dVL_leak);
      st.qLiqDrain  = q_liq_out;
    }
  }

  if (dP2 > 1) {
    st.qLiqDrain = 0;
  }

  var TR_bot  = p.T_surf + (p.geo_grad / 100) * (NC - 0.5) * dz + 459.67;
  var Z_bot   = papayZ(Math.max(BHP_cur, 14.7), TR_bot, p.sg);
  var rG_bot  = gasDen(Math.max(BHP_cur, 14.7), TR_bot, p.sg);
  var Bg_bot  = Z_bot * (TR_bot / 520) * (14.7 / Math.max(BHP_cur, 14.7));

  var dVg_in_want = q_res * 1e6 / 86400 * Bg_bot * dt;
  var Vg_bot_avail = Math.max(cellVol - st.VL[NC - 1], cellVol * 0.005);
  var dVg_in  = Math.min(dVg_in_want, Vg_bot_avail * 0.80);
  var dmG_in  = dVg_in * rG_bot;
  st.mG[NC - 1] = Math.max(0, st.mG[NC - 1] + dmG_in);
  var q_res_actual = dVg_in / Math.max(Bg_bot * dt, 1e-12) / (1e6 / 86400);

  // v3.3: evolve the radial reservoir grid with the actual extracted rate.
  // This is what gives PBU its physical time scale — near-wellbore cell rebuilds
  // fast (seconds), far-field equilibration scales with r_e²/η (hours to days).
  if (resGrid) {
    stepReservoir(resGrid, p, q_res_actual, dt);
  }

  var wgr = p.wgr || 0, cgr = p.cgr || 0;
  var qLiq_reservoir = (wgr + cgr) * q_res;
  var dVL_in_want    = qLiq_reservoir * 5.615 / 86400 * dt;
  var VL_bot_current = st.VL[NC - 1];
  var HL_bot_est = VL_bot_current / cellVol;
  var P_bot_est  = Math.max(st.P[NC - 1], 14.7);
  var TR_bot_est = TR_bot;
  var rG_bot_est = gasDen(P_bot_est, TR_bot_est, p.sg);
  var qGs_bot    = st.qG * 1e6 / 86400;
  var qLs_bot    = (wgr + cgr) * st.qG * 5.615 / 86400;
  var Z_bot_est  = papayZ(P_bot_est, TR_bot_est, p.sg);
  var vsg_bot    = Math.max(0, Math.min(40,
    qGs_bot * Z_bot_est * (TR_bot_est / 520) * (14.7 / P_bot_est) / Ap));
  var vsl_bot    = Math.max(0, Math.min(8, qLs_bot / Ap));
  var gr_bot_est = grayCorrelation(
    Math.max(vsg_bot, 0.001), Math.max(vsl_bot, 0.001),
    rhoL, rG_bot_est, lp.sig, D_ft, lp.muL);
  var vG_bot_est = gr_bot_est.C0 * (vsg_bot + vsl_bot) + gr_bot_est.Vd;
  var vT_bot_est = (p.turner_const || 5.62) * Math.pow(lp.sig * Math.max(rhoL - rG_bot_est, 0.1) /
                   Math.max(rG_bot_est * rG_bot_est, 0.01), 0.25);
  var cf_bot_est = vsg_bot / Math.max(vT_bot_est, 0.01) >= 1 ? 1.0 :
                   Math.min(1.0, vsl_bot / Math.max(vG_bot_est, 0.001));
  var dVL_drain_est = Math.min(cf_bot_est * vsl_bot * Ap * HL_bot_est * dt,
                               VL_bot_current * 0.80);
  var space_avail = Math.max(0, cellVol * 0.97 - VL_bot_current) + dVL_drain_est;
  var dVL_in = Math.min(dVL_in_want, space_avail * 0.80);
  // v3.4.5: track actual volume added (post-clip) for mass-conservative qLiqIn.
  var VL_bot_before = st.VL[NC - 1];
  st.VL[NC - 1] = Math.min(cellVol * 0.97, st.VL[NC - 1] + dVL_in);
  var dVL_in_actual = st.VL[NC - 1] - VL_bot_before;
  st.qLiqIn = dVL_in_actual / Math.max(dt, 1) * 86400 / 5.615;

  // ── B. INTERCELL DRIFT-FLUX TRANSPORT ────────────────────
  // FIX-D pre-pass: flag cells that have a liquid-dominated cell above them.
  // A cell with liquidAboveFlag[j]=true cannot be in annular/churn flow because
  // the liquid slug above blocks the continuous gas-core path that annular
  // requires.  Built from the post-Step-A VL values so it reflects the current
  // liquid distribution before any intercell transport this step.
  var liquidAboveFlag = new Array(NC);
  var _liqSeen = false;
  for (var _li = 0; _li < NC; _li++) {
    liquidAboveFlag[_li] = _liqSeen;
    if (st.VL[_li] / cellVol > 0.55) _liqSeen = true;
  }

  for (var j = NC - 1; j > 0; j--) {
    var HL_j = Math.min(0.97, st.VL[j] / cellVol);
    var Vg_j = Math.max(cellVol - st.VL[j], cellVol * 0.005);
    var P_j  = Math.max(st.P[j], 14.7);
    var TR_j = p.T_surf + (p.geo_grad / 100) * (j + 0.5) * dz + 459.67;
    var se_j = wetGasSG(p.sg, p.cgr, P_j, p.P_dew || 0);
    var rG_j = gasDen(P_j, TR_j, se_j);

    var dmG_up = 0, dVL_up = 0, dVL_down = 0, dVg_up = 0;

    if (st.isShutIn) {
      // v3.4.3: Gravity settling of liquid past a near-full upper cell.
      //
      // Physical mechanism (Taylor bubble): in a vertical pipe with a dense
      // liquid column above a lighter one (or gas pocket above), Taylor
      // bubbles of gas rise at velocity Vd = 0.35√(g·D·Δρ/ρ) and an equal
      // volume of liquid falls in counter-current exchange.
      //
      // Previous bug: the guard `HL_above < 0.97` blocked exchange whenever
      // Step C had capped cell[0] at HL = 0.98.  Result: liquid trapped at
      // the top of the column during shut-in (visible as HL ~ 98% at top
      // while middle cells drained to 0).  The guard was redundant because
      // the capacity limits on line 1055 already enforce non-negative
      // transport.  Dropped the guard and raised the compacity ceiling to
      // 0.98 (matching Step C's cap) so liquid falls through even when the
      // upper cell starts at 0.98.
      var rLsi_j = rhoL * 16.018;
      var rGsi_j = rG_j * 16.018;
      var D_m_j  = D_ft * FT2M;
      var dRho_j = Math.max(rLsi_j - rGsi_j, 1);
      var Vd_taylor = 0.35 * Math.sqrt(G_SI * D_m_j * dRho_j / rLsi_j) / FT2M;
      var HL_above = st.VL[j - 1] / cellVol;
      // Volumetric exchange gated only by: there is some gas below to rise,
      // and there is some room above for it (cellVol*0.98 − VL_above > 0).
      if (Vg_j > cellVol * 0.005 && HL_above < 0.99) {
        dVg_up = Math.min(
          Vd_taylor * Ap * (1 - HL_j) * dt,
          Vg_j * 0.80,
          Math.max(0, cellVol * 0.98 - st.VL[j - 1])
        );
        dmG_up = dVg_up * rG_j;
        dVL_down = Math.min(
          dVg_up,
          st.VL[j - 1] * 0.80,
          Math.max(0, cellVol * 0.98 - st.VL[j])
        );
      }
      dVL_up = 0;

    } else {
      var qGs_j  = st.qG * 1e6 / 86400;
      var qLs_j  = ((p.wgr || 0) + (p.cgr || 0)) * st.qG * 5.615 / 86400;
      var Z_j    = papayZ(P_j, TR_j, se_j);
      var vsg_j  = Math.max(0, Math.min(40,
        qGs_j * Z_j * (TR_j / 520) * (14.7 / P_j) / Ap));
      var vsl_j  = Math.max(0, Math.min(8, qLs_j / Ap));

      // ── Foam batch: Session C — per-cell property modification ──────────
      // foamModifyProps blends rhoL, muL, C0, Vd toward foam values as Γ→Γ_s.
      // Only active when foam.js is loaded and this cell has Γ > 0.
      var Gamma_j = (st.Gamma && st.Gamma[j]) ? st.Gamma[j] : 0;
      var lp_j    = lp;
      if (Gamma_j > 0.001 && window.WM && window.WM.foam) {
        var _fp_base = { rL: lp.rL, muL: lp.muL, sig: lp.sig,
                         ftype: p.foam_type || 'anionic',
                         vsg: vsg_j, D_ft: D_ft };  // vsg/D_ft for shear-rate friction visc
        lp_j = window.WM.foam.foamModifyProps(_fp_base, Gamma_j, rG_j);
      }

      // Use muL_friction (bulk rheological viscosity, ~75 cP from lab data) for
      // friction pressure gradient in the foam zone; muL (slip, ~1.3 cP) is kept
      // for the Vd drift-flux correction applied below. The two roles are distinct:
      // bulk foam resists shear far more than individual bubbles resist rising.
      var _muForGray = (Gamma_j > 0.001 && lp_j.muL_friction && lp_j.muL_friction > lp_j.muL)
        ? lp_j.muL_friction
        : lp_j.muL;
      var gr_j = grayCorrelation(
        Math.max(vsg_j, 0.001), Math.max(vsl_j, 0.001),
        lp_j.rL, rG_j, lp_j.sig, D_ft, _muForGray);

      // FIX-D: annular/churn below a liquid slug is physically impossible.
      // Override C0 and Vd to bubble drift-flux parameters so intercell
      // gas-rise and liquid-carry velocities are computed correctly.
      if (liquidAboveFlag[j] &&
          (gr_j.regime === 'annular' || gr_j.regime === 'churn')) {
        var _rLsi = rhoL * 16.018;
        var _rGsi = rG_j * 16.018;
        var _dR   = Math.max(_rLsi - _rGsi, 1);
        var _ssi  = Math.max(lp.sig * 1e-3, 0.5e-3);
        gr_j.C0     = 1.20;
        gr_j.Vd     = 1.53 * Math.pow(G_SI * _ssi * _dR / (_rLsi * _rLsi), 0.25) / FT2M;
        gr_j.regime = 'bubble';
      }

      // Apply foam drift-flux overrides (Session C Eqs.11–13) after FIX-D
      // so foam correction does not conflict with bubble-below-slug logic.
      if (Gamma_j > 0.001 && lp_j.C0_override !== undefined) {
        gr_j.C0 = lp_j.C0_override;
      }
      if (Gamma_j > 0.001 && lp_j.Vd_fraction !== undefined) {
        gr_j.Vd = gr_j.Vd * lp_j.Vd_fraction;
      }

      // ── Foam batch: Session B — Gamma ODE update ─────────────────────────
      // Advances foam quality for this cell based on vsg vs percolation threshold.
      // Active only when foam_type is staged (set in par after "Stage treatment").
      if (st.Gamma && p.foam_type && window.WM && window.WM.foam) {
        var _vp_j = window.WM.foam.percolationThreshold(
          lp.sig, lp.rL, rG_j, p.foam_type);
        st.Gamma[j] = window.WM.foam.foamQualityStep(
          st.Gamma[j] || 0, vsg_j, _vp_j, p.foam_type, dt);
      }

      var vm_j  = vsg_j + vsl_j;
      var vGup  = Math.max(0, gr_j.C0 * vm_j + gr_j.Vd);
      dVg_up    = Math.min(vGup * Ap * (1 - HL_j) * dt, Vg_j * 0.80);
      dmG_up    = dVg_up * rG_j;

      // FIX-A: velocity-based liquid carry — eliminates phantom liquid accumulation.
      // Old formula  cf * vsl * HL * Ap * dt  vanishes when HL≈0 (gas cell) even
      // though gas drags liquid at Turner velocity in mist flow.
      // New: use the actual liquid transport velocity from drift-flux physics:
      //   Above Turner (tr>=1): mist flow — all liquid droplets travel at vT
      //     (Turner terminal velocity). This empties gas-dominated cells correctly.
      //   Below Turner: liquid travels at slip-corrected velocity vsl/vG * vG_drift.
      //     Same physics as before but expressed as velocity × HL × Ap × dt,
      //     which gives correct non-zero transport even when HL is small.
      var vT_j  = (p.turner_const || 5.62) * Math.pow(lp.sig * Math.max(rhoL - rG_j, 0.1) /
                  Math.max(rG_j * rG_j, 0.01), 0.25);
      var vG_j  = gr_j.C0 * vm_j + gr_j.Vd;
      var tr_j  = vsg_j / Math.max(vT_j, 0.01);
      var vL_eff_j;
      if (tr_j >= 1.0) {
        // Mist/annular: liquid dragged at Turner velocity
        vL_eff_j = vT_j;
      } else {
        // Slug/churn: slip-corrected liquid velocity, bounded by drift-flux
        var cf_j = Math.min(1.0, vsl_j / Math.max(vG_j, 0.001));
        vL_eff_j = cf_j * Math.max(vG_j, vsl_j);
      }
      dVL_up   = Math.min(vL_eff_j * Ap * HL_j * dt, st.VL[j] * 0.80);
      dVL_down = 0;
    }

    // v3.4.5: mass-conservative transport.
    // Previous code clipped destination via Math.min(cellVol * 0.98, ...)
    // which silently destroyed mass when the destination was at cap.
    // Now: compute the actual transferable volumes first (bounded by source
    // availability and destination headroom), then apply symmetrically.
    //
    // dVL_up: liquid from cell j → j-1 (upward transport)
    // dVL_down: liquid from cell j-1 → j (downward settling)
    // dmG_up: gas mass from cell j → j-1 (upward transport)
    var headroom_up   = Math.max(0, cellVol * 0.98 - st.VL[j - 1]);  // space in destination for dVL_up
    var headroom_down = Math.max(0, cellVol * 0.98 - st.VL[j]);      // space in destination for dVL_down
    var dVL_up_actual = Math.min(dVL_up, headroom_up);
    var dVL_down_actual = Math.min(dVL_down, headroom_down);

    st.mG[j]     = Math.max(0, st.mG[j] - dmG_up);
    st.mG[j - 1] = st.mG[j - 1] + dmG_up;
    st.VL[j]     = Math.max(0, st.VL[j] - dVL_up_actual + dVL_down_actual);
    st.VL[j - 1] = Math.max(0, st.VL[j - 1] + dVL_up_actual - dVL_down_actual);
  }

  // ── C. SURFACE BOUNDARY ───────────────────────────────────
  var qG_out = 0;
  if (!st.isShutIn && p.choke_64 > 0) {
    var TR_top = p.T_surf + 459.67;
    var ck = p.choke_64 || 32, Ps = p.P_sep || 250;

    var Z_est = papayZ(Math.max(Ps * 1.5 + 50, 80), TR_top, p.sg);
    var WHP_est = st.qG > 0.001 ?
      computeWHP2(st.qG, ck, Ps, p.T_surf, Z_est, p.sg, p.wgr, p.cgr, p.salinity) :
      (Ps + 3);
    var Z_whp = papayZ(Math.max(WHP_est, 14.7), TR_top, p.sg);
    var WHP_use = Math.max(st.qG > 0.001 ?
      computeWHP2(st.qG, ck, Ps, p.T_surf, Z_whp, p.sg, p.wgr, p.cgr, p.salinity) :
      (Ps + 3), Ps + 3);

    var BHP_ipr_c = st.qG > 0.001 ?
      Math.max(14.7, iprPwf(st.qG, p.Pr, A_eff, B_eff)) : p.Pr;

    var BHP_vlp = outflowPwf(st.qG > 0.001 ? st.qG : 0.001, p, 0);

    if (st.qG < 0.001) {
      var op_seed = findOperatingPoint(p, A_eff, B_eff, 0);
      qG_out = op_seed.noFlow ? 0 : op_seed.q_op;
    } else {
      // v3.4.7: live-sensitive operating point relaxation.
      //
      // Previous logic used a binary clamp:
      //   if (BHP_vlp <= BHP_ipr_c + 10) qG_out = st.qG;
      //   else recompute via findOperatingPoint
      //
      // Problem: when the user changes choke/P_sep/WGR live and the change
      // makes the new VLP LOWER than current st.qG (e.g. opening the choke),
      // BHP_vlp ≤ BHP_ipr_c stays true, so qG_out stuck at st.qG.  The well
      // failed to accelerate even though the IPR has spare pressure to deliver
      // more.
      //
      // New approach: compute the IPR/VLP residual at current qG and at a
      // small probe rate above; estimate the local Newton direction; relax
      // qG_out toward the operating point by a fraction limited by physical
      // wellbore-storage time scale.  This makes the engine continuously
      // sensitive to parameter changes without recomputing a full bisection
      // every step (expensive).
      //
      // Residual r(q) = BHP_ipr(q) - BHP_vlp(q)
      //   r > 0  → reservoir over-supplies → q should increase
      //   r < 0  → wellbore over-restricts → q should decrease
      //   r = 0  → operating point
      //
      // For wellbore-storage realism: the rate cannot change faster than the
      // wellbore can fill/empty.  A 1-second tubing fill time is plausible for
      // 3-4" tubing; we relax with τ_op ≈ 30 s so a step change in choke
      // smoothly transitions over ~1 minute of sim time, matching field
      // observation of how chokes actually behave.

      var dq_probe = Math.max(0.01, st.qG * 0.05);
      var q_lo = Math.max(0.001, st.qG - dq_probe);
      var q_hi = st.qG + dq_probe;

      var BHP_ipr_lo = iprPwf(q_lo, p.Pr, A_eff, B_eff);
      var BHP_vlp_lo = outflowPwf(q_lo, p, 0);
      var r_lo = BHP_ipr_lo - BHP_vlp_lo;

      var BHP_ipr_hi = iprPwf(q_hi, p.Pr, A_eff, B_eff);
      var BHP_vlp_hi = outflowPwf(q_hi, p, 0);
      var r_hi = BHP_ipr_hi - BHP_vlp_hi;

      var r_cur = BHP_ipr_c - BHP_vlp;

      // If residual changes sign between q_lo and q_hi, we're near the operating
      // point — bracket then bisect for an accurate target.  If both samples
      // have the same sign, take a Newton step using the local slope.
      var q_target;
      if (r_lo > 0 && r_hi < 0) {
        // operating point lies between q_lo and q_hi — bracket precisely
        var lo = q_lo, hi = q_hi;
        for (var bi = 0; bi < 12; bi++) {
          var qm = 0.5 * (lo + hi);
          var rm = iprPwf(qm, p.Pr, A_eff, B_eff) - outflowPwf(qm, p, 0);
          if (rm > 0) lo = qm; else hi = qm;
        }
        q_target = 0.5 * (lo + hi);
      } else if (r_cur > 0 && r_hi > 0) {
        // both positive at and above current rate — operating point is HIGHER
        // Newton step with local slope; if denominator is tiny use big step
        var slope_h = (r_hi - r_cur) / (q_hi - st.qG);
        if (slope_h < -1) {  // residual falls with increasing q (normal case)
          q_target = st.qG - r_cur / slope_h;
        } else {
          // weak slope or wrong sign: defer to full operating-point search
          var op_full = findOperatingPoint(p, A_eff, B_eff, 0);
          q_target = op_full.noFlow ? 0 : op_full.q_op;
        }
      } else if (r_cur < 0 && r_lo < 0) {
        // both negative at and below current rate — operating point is LOWER
        var slope_l = (r_cur - r_lo) / (st.qG - q_lo);
        if (slope_l < -1) {
          q_target = st.qG - r_cur / slope_l;
        } else {
          var op_full2 = findOperatingPoint(p, A_eff, B_eff, 0);
          q_target = op_full2.noFlow ? 0 : op_full2.q_op;
        }
      } else {
        // mixed signs but not the standard bracket — fall back to full search
        var op_fb = findOperatingPoint(p, A_eff, B_eff, 0);
        q_target = op_fb.noFlow ? 0 : op_fb.q_op;
      }

      // Bound q_target physically
      q_target = Math.max(0, Math.min(q_target,
                          computeAOF(p.Pr, A_eff, B_eff)));

      // Relax current rate toward target with first-order time constant.
      // tau_op = 30 s is consistent with typical choke step-response observed
      // in the field (the BHP/WHP transition takes ~1 minute to complete).
      var tau_op = 30;
      var alpha_op = 1 - Math.exp(-dt / tau_op);
      qG_out = st.qG + alpha_op * (q_target - st.qG);
    }

    qG_out = Math.max(0, qG_out);

    // v3.4: dead-well / loaded-well gate based on actual column state.
    // findOperatingPoint and outflowPwf both use a steady-state VLP model that
    // does not know about the current cell-by-cell liquid holdup.  When the
    // wellbore is loaded (HL significant through much of the column), the
    // hydrostatic pressure required to support that column can exceed what
    // the IPR delivers at the proposed rate — the flowing-state cascade then
    // hits its 14.7 psi floor in the middle cells (nonphysical).  Detect
    // this by comparing the actual hydrostatic requirement of the current
    // column against the BHP the IPR provides at the chosen qG_out.
    //
    // BHP_needed(HL) = WHP_min + Σ ρ_mix(P_k, T_k, HL_k) · dz / 144
    // BHP_avail(q)   = iprPwf(q, Pr, A, B)        [monotonically decreasing in q]
    //
    // Flow is physical only if BHP_avail ≥ BHP_needed.  If not at the current
    // qG_out, we must reduce qG until they match (iterate) or accept zero flow.
    // For simplicity we do one check and force qG=0 if IPR cannot support the
    // column even at q=0 (BHP_avail at q=0 is Pr itself).  Otherwise we scale
    // qG_out down so the IPR-delivered BHP ≥ BHP_needed.
    var rhoL_dd      = lp.rL;
    var BHP_needed   = Math.max(p.P_sep || 250, 14.7) + 3;
    for (var kd = 0; kd < NC; kd++) {
      var z_kd   = (kd + 0.5) * dz;
      var TR_kd  = p.T_surf + (p.geo_grad / 100) * z_kd + 459.67;
      var rG_kd  = gasDen(Math.max(st.P[kd], 14.7), TR_kd, p.sg);
      // Foam-effective liquid density reduces BHP_needed as Γ builds,
      // releasing the loaded-well gate once the foam column lightens.
      var _G_kd  = (st.Gamma && st.Gamma[kd]) ? st.Gamma[kd] : 0;
      var _rL_kd = (_G_kd > 0.001 && window.WM && window.WM.foam)
        ? window.WM.foam.foamDensity(_G_kd, rhoL_dd, rG_kd)
        : rhoL_dd;
      var rMix_k = _rL_kd * st.HL[kd] + rG_kd * (1 - st.HL[kd]);
      BHP_needed += rMix_k * dz / 144;
    }

    if (BHP_needed > p.Pr) {
      // Column too heavy for any flow — well is physically dead regardless
      // of what the steady-VLP model said.
      qG_out = 0;
    } else if (qG_out > 0.001) {
      // Column is potentially supportable.  Find max q such that IPR ≥ BHP_needed.
      // IPR: BHP_avail² = Pr² - A·q - B·q² → q such that BHP_avail = BHP_needed:
      //   A·q + B·q² = Pr² - BHP_needed²
      var dP2_max = p.Pr * p.Pr - BHP_needed * BHP_needed;
      if (dP2_max <= 0) {
        qG_out = 0;
      } else {
        var A_u = A_eff, B_u = B_eff;
        var q_max_loaded = B_u > 1e-6
          ? (-A_u + Math.sqrt(A_u * A_u + 4 * B_u * dP2_max)) / (2 * B_u)
          : (A_u > 0 ? dP2_max / A_u : qG_out);
        if (qG_out > q_max_loaded) qG_out = Math.max(0, q_max_loaded);

        // FIX-G: marginal-stability kill.
        // At q_max_loaded the IPR-BHP margin above BHP_needed is exactly
        // zero — one extra loaded cell would kill flow.  Any rate within
        // 2% of q_max_loaded is in the unstable zone; collapse to zero so
        // the column solver takes over rather than hovering at WHP ≈ P_sep.
        if (q_max_loaded > 0.001 &&
            qG_out / q_max_loaded > 0.98) {
          qG_out = 0;
        }
      }
    }

    // v3.4.2/v3.4.5: Dead-well gate based on column loading.
    //
    // If the gas column is heavily loaded AND gas velocity is below Turner,
    // steady upward flow is physically impossible — film reverses, liquid
    // accumulates, and any "flow" produced by the quasi-steady nodal analysis
    // is an artifact of the drift-flux correlation extrapolated outside its
    // valid range.
    //
    // Two independent criteria (well is dead if EITHER triggers):
    // (a) HL_mean > 0.85 AND previous turnerRatio < 0.3
    //     — classic mist-flow reversal indicator
    // (b) column fill > 95% (averaged HL across all cells)
    //     — wellbore saturated; no continuous gas path regardless of velocity.
    //     This was added after observing wells that reached HL_mean=0.98 with
    //     Turner=0.39 where (a) alone wouldn't fire but steady flow is clearly
    //     unphysical (v3.4.5 screenshot scenario).
    if (qG_out > 0.001) {
      var HL_mean = 0;
      for (var kh = 0; kh < NC; kh++) HL_mean += st.HL[kh];
      HL_mean /= NC;
      var tr_prev = st.turnerRatio || 0;
      var gateA = HL_mean > 0.85 && tr_prev < 0.3;
      var gateB = HL_mean > 0.95;
      if (gateA || gateB) {
        qG_out = 0;
      }
    }

    var P_top   = Math.max(st.P[0], 14.7);
    var Z_top   = papayZ(P_top, TR_top, p.sg);
    var Bg_top  = Z_top * (TR_top / 520) * (14.7 / P_top);
    var rG_top  = gasDen(P_top, TR_top, p.sg);
    var dVg_out = qG_out * 1e6 / 86400 * Bg_top * dt;
    var dmG_out = dVg_out * rG_top;

    // FIX-B: velocity-based liquid exit at surface + mass-balance floor.
    // Old: dVL_out = cf_top * HL_top * dVg_out
    //   Fails when cell[0] is gas-dominated (HL_top≈0) — no liquid exits
    //   even though the well is producing 10,000 bpd at reservoir.
    // New (two parts):
    //   Part 1: velocity-based exit from cell[0], consistent with FIX-A.
    //     Above Turner: liquid exits at Turner velocity × HL[0] × Ap × dt
    //     Below Turner: slip-corrected as before
    //   Part 2: mass-balance floor — carry fraction × reservoir liquid rate.
    //     If cell[0] is empty but cells below have liquid, draw the liquid
    //     upward through the column (accounts for the fact that intercell
    //     transport in Step B may not have fully propagated this step).
    //     The floor prevents the "liquid invisible at surface" failure mode.
    var rG_top2  = gasDen(P_top, TR_top, p.sg);
    var qGs_top  = qG_out * 1e6 / 86400;
    var qLs_top  = ((p.wgr || 0) + (p.cgr || 0)) * qG_out * 5.615 / 86400;
    var Z_top2   = papayZ(P_top, TR_top, p.sg);
    var vsg_top  = Math.max(0.001, Math.min(40,
      qGs_top * Z_top2 * (TR_top / 520) * (14.7 / P_top) / Ap));
    var vsl_top  = Math.max(0.001, Math.min(8, qLs_top / Ap));
    var gr_top   = grayCorrelation(vsg_top, vsl_top, rhoL, rG_top2, lp.sig, D_ft, lp.muL);
    var vT_top   = (p.turner_const || 5.62) * Math.pow(lp.sig * Math.max(rhoL - rG_top2, 0.1) /
                   Math.max(rG_top2 * rG_top2, 0.01), 0.25);
    var tr_top   = vsg_top / Math.max(vT_top, 0.01);
    var vG_top   = gr_top.C0 * (vsg_top + vsl_top) + gr_top.Vd;
    // Part 1: velocity-based transport from cell[0]
    //
    // v3.4.5 FIX: Hybrid model covering three regimes:
    //
    //   tr ≥ 1.0 (mist/annular flow):
    //     Gas velocity exceeds Turner critical; droplets are carried at the
    //     terminal velocity vT. This is the classic dry-gas unloading branch.
    //
    //   0.3 ≤ tr < 1.0 (slug/churn flow):
    //     Gas slugs push liquid slugs upward. The empirical slip-corrected
    //     velocity vL ≈ min(1, vsl/vG) × vG ≈ vsl (which is what the old
    //     pre-v3.4.2 code computed). This is physically reasonable — at
    //     these velocities the gas structure is slug/churn, liquid pistons
    //     are actively pushed up the well.
    //
    //   tr < 0.3 (below-critical / film-reversal):
    //     Gas velocity too low to sustain upward flow. Use carryFractionMech
    //     which correctly drops to zero. This is the regime where the v3.4.2
    //     scenario (Turner = 0.008) sat and where the old formula was wrong.
    //
    // v3.4.2 replaced the slip formula with cf_mech × vsl *everywhere* below
    // critical, which crashed carry to ~0.01 at Turner 0.5 — wrong for slug
    // flow. The hybrid below recovers slug/churn physics while keeping the
    // correct near-zero behaviour in the film-reversal regime.
    var vL_eff_top;
    if (tr_top >= 1.0) {
      vL_eff_top = vT_top;
    } else if (tr_top >= 0.3) {
      // Slug/churn: slip-corrected liquid velocity
      var cf_slip = Math.min(1.0, vsl_top / Math.max(vG_top, 0.001));
      vL_eff_top = cf_slip * Math.max(vG_top, vsl_top);
    } else {
      // Below-critical film-reversal: mechanistic carry fraction → 0
      var cf_mech = carryFractionMech(vsg_top, vsl_top, rhoL, rG_top2, lp.sig, D_ft, p.turner_const || 5.62);
      vL_eff_top = cf_mech * vsl_top;
    }
    var HL_top   = st.VL[0] / cellVol;
    var dVL_out  = Math.min(vL_eff_top * Ap * HL_top * dt, st.VL[0] * 0.90);
    // Part 2: mass-balance floor
    // Liquid that should exit based on reservoir delivery × carry fraction.
    // cf_floor uses the overall Turner ratio at current conditions.
    var cf_floor = tr_top >= 1.0 ? 1.0 :
                   Math.min(1.0, carryFractionMech(vsg_top, vsl_top, rhoL, rG_top2, lp.sig, D_ft, p.turner_const || 5.62));
    var dVL_floor = cf_floor * ((p.wgr||0) + (p.cgr||0)) * qG_out * 5.615 / 86400 * dt;
    // If cell[0] can't supply the floor, draw from top few cells combined
    var VL_top3 = st.VL[0] + (NC > 1 ? st.VL[1] : 0) + (NC > 2 ? st.VL[2] : 0);
    dVL_out = Math.min(Math.max(dVL_out, dVL_floor * 0.8), VL_top3 * 0.70);
    // Remove liquid proportionally from top cells if cell[0] alone can't supply
    var dVL_remain = dVL_out;
    for (var tc = 0; tc < Math.min(3, NC) && dVL_remain > 0; tc++) {
      var take = Math.min(dVL_remain, st.VL[tc] * 0.90);
      st.VL[tc]   = Math.max(0, st.VL[tc] - take);
      dVL_remain -= take;
    }
    st.mG[0]   = Math.max(0, st.mG[0] - dmG_out);
    st.qLiqOut = dVL_out / Math.max(dt, 1) * 86400 / 5.615;
  } else {
    st.qLiqOut = 0;
  }
  // Only update st.qG from the nodal solve when flowing.
  // When shut-in, Step C is skipped and qG_out == 0; assigning it here was the
  // root cause of q_shutin collapsing to the 0.1 MMscfd fallback and m_horner
  // being ~10,000x too small.  During shut-in we leave st.qG untouched so that
  // the state-label block (and any diagnostic reads) still see the last flowing rate.
  if (!st.isShutIn) {
    st.qG = qG_out;
  }

  // ── D. PRESSURE UPDATE ────────────────────────────────────
  var Vliq_total = 0;
  for (var k = 0; k < NC; k++) {
    st.VL[k]  = Math.min(st.VL[k], cellVol * 0.99);
    Vliq_total += st.VL[k];
    st.HL[k]  = st.VL[k] / cellVol;
  }
  st.Vliq = Vliq_total / 5.615;

  // v3.4: route dead flowing wells (qG=0) to the column solver too.
  // A well with qG=0 and an open choke behaves physically like a shut-in
  // well for mass-balance purposes — no gas exits through the top.  The
  // only difference is that WHP doesn't float freely during "dead-flowing";
  // but since we don't enforce a surface flow constraint in the solver,
  // the solution is identical.  This catches the dead-well case detected
  // by the hydrostatic gate in Step C and avoids the broken flowing-state
  // cascade (which hits its 14.7 psi floor when column weight > BHP from IPR).
  var useColumnSolver = st.isShutIn || st.qG < 0.001;

  if (useColumnSolver) {
    // v3.4: cell-by-cell compressible column equilibration.
    // Replaces the lumped-tank + hydrostatic-cascade + mass-rebuild pattern
    // (which had a Z double-count bug and used single-P/single-T averages)
    // with a self-consistent solve: reservoir inflow adds mass to the gas
    // column, then we find the unique hydrostatic profile containing that
    // mass via bisection on BHP.  Gas density uses local P and T per cell.
    //
    // Mass balance: mG_total_new = mG_total_old + ρ_sc · q_res · dt
    //   q_res [MMscfd] × 1e6/86400 [scf/s] × ρ_sc [lb/scf] × dt [s]
    //   where ρ_sc = gasDen(14.7, 520, sg_dry)  (surface conditions)

    // Precompute per-cell absolute temperature
    var T_arr = new Array(NC);
    for (var it = 0; it < NC; it++) {
      var z_it  = (it + 0.5) * dz;
      T_arr[it] = p.T_surf + (p.geo_grad / 100) * z_it + 459.67;
    }

    // Current total gas mass in column (use existing P[k])
    var mG_total_old = 0;
    for (var ic = 0; ic < NC; ic++) {
      var Vg_ic = Math.max(cellVol - st.VL[ic], cellVol * 0.005);
      var rG_ic = gasDen(Math.max(st.P[ic], 14.7), T_arr[ic], p.sg);
      mG_total_old += rG_ic * Vg_ic;
    }

    // Mass added by afterflow this step (no Z here — ρ_sc is surface density,
    // so this is genuinely the lb-mass added)
    var rho_sc  = gasDen(14.7, 520, p.sg);   // lb/scf at standard conditions
    var dmG_in  = q_res * 1e6 / 86400 * rho_sc * dt;  // lb over dt
    var mG_total_new = Math.max(0, mG_total_old + dmG_in);

    // Liquid density for hydrostatic mix
    var rhoL_col = liquidProps(p).rL;

    // Solve for BHP that matches total mass, with distributed hydrostatics
    var sol = solveColumnBHP(mG_total_new, st, p, T_arr, rhoL_col, cellVol);

    // v3.4.4: Dead-flowing-with-open-choke relaxation.
    //
    // When the well is "dead-flowing" (qG ≈ 0 but isShutIn=false and choke
    // is open), the wellhead is connected to the separator through the
    // choke.  Gas in the top of the tubing bleeds through the choke until
    // WHP equals P_sep (plus a small pressure margin).  The closed-top
    // mass-balance solve would otherwise leave WHP pinned at whatever
    // hydrostatic profile the current mass implies — typically far above
    // P_sep, which is physically wrong with an open choke.
    //
    // Physical justification for instant pinning: even a small choke (4/64")
    // bleeds the wellbore down to P_sep within seconds-to-minutes for typical
    // wellbore gas inventories (tens of lb), much faster than the engine's
    // typical dt of 10-60s.  So to first order, WHP = P_sep + margin as soon
    // as afterflow stops.  A more refined model would compute choke mass
    // flux from computeWHP2 inverted each step, but that requires a nested
    // iteration and the faster relaxation is a reasonable approximation.
    var isDeadFlowing = !st.isShutIn && st.qG < 0.001 && (p.choke_64 || 0) > 0;
    if (isDeadFlowing) {
      var WHP_target = (p.P_sep || 250) + 3;  // small margin above separator
      // Cascade from pinned top to get the equilibrated profile for current HL
      var pinnedTop = columnCascadeFromTop(WHP_target, st, p, T_arr, rhoL_col, cellVol);
      // Only apply if the pinned-top solve gives LESS mass than the closed-top
      // mass-balance solve (i.e. mass can vent through choke).  If somehow the
      // pinned solve requires MORE mass (pathological — means column is actually
      // under-pressurized relative to P_sep), keep the closed-top solve.
      if (pinnedTop.mG_tot < mG_total_new) {
        // Limit bleed to at most 50% of gas inventory per step (rate cap to
        // avoid single-step blowdown of partially-loaded columns; this is
        // well inside normal choke bleed rates for dt ≤ 60s)
        var dmG_bleed_want = mG_total_new - pinnedTop.mG_tot;
        var dmG_bleed_cap  = 0.5 * mG_total_new;
        var dmG_bleed      = Math.max(0, Math.min(dmG_bleed_want, dmG_bleed_cap));
        if (dmG_bleed > 0) {
          // Apply the top-pinned profile proportionally based on how much bled.
          // If we can vent all the excess mass (common case), use pinned profile.
          // Otherwise interpolate between closed-top and pinned-top solutions.
          if (dmG_bleed >= dmG_bleed_want * 0.99) {
            sol.BHP = pinnedTop.P[NC - 1];
            sol.P   = pinnedTop.P;
          } else {
            // Partial bleed: re-solve mass-conservation but with reduced total
            var mG_after_bleed = mG_total_new - dmG_bleed;
            var partialSol = solveColumnBHP(mG_after_bleed, st, p, T_arr, rhoL_col, cellVol);
            sol.BHP = partialSol.BHP;
            sol.P   = partialSol.P;
          }
        }
      }
    }

    // Safety cap: BHP cannot exceed near-well reservoir cell pressure
    // (retained as numerical safeguard only — physically q_res → 0 as
    // BHP → P_cell[0] so this rarely fires; keeps single-step overshoot
    // from blowing past the reservoir source)
    var BHP_cap = (resGrid && resGrid.P) ? resGrid.P[0] : p.Pr;
    if (sol.BHP > BHP_cap) {
      // Re-solve with BHP pinned at cap: compute what mass that implies
      // and update mG bookkeeping so next step is self-consistent
      var pinned = columnGasMassGivenBHP(BHP_cap, st, p, T_arr, rhoL_col, cellVol);
      sol.BHP = BHP_cap;
      sol.P   = pinned.P;
    }

    // Write back to state
    st.BHP = sol.BHP;
    for (var kw = 0; kw < NC; kw++) {
      st.P[kw]  = sol.P[kw];
      var Vg_kw = Math.max(cellVol - st.VL[kw], cellVol * 0.005);
      var rG_kw = gasDen(Math.max(st.P[kw], 14.7), T_arr[kw], p.sg);
      st.mG[kw] = rG_kw * Vg_kw;
      st.vm[kw] = 0;
    }
    st.WHP = st.P[0];
  } else {
    var Pwf_ipr_f = st.qG > 0.001 ?
      Math.max(14.7, iprPwf(st.qG, p.Pr, A_eff, B_eff)) :
      Math.max(14.7, p.Pr - 10);
    st.P[NC - 1] = Pwf_ipr_f;
    for (var kf = NC - 2; kf >= 0; kf--) {
      var z_kf  = (kf + 0.5) * dz;
      var TR_kf = p.T_surf + (p.geo_grad / 100) * z_kf + 459.67;
      var rG_kf = gasDen(Math.max(st.P[kf + 1], 14.7), TR_kf, p.sg);
      var rM_kf = liquidProps(p).rL * st.HL[kf] + rG_kf * (1 - st.HL[kf]);
      var vm_kf = st.vm[kf] || 0;
      var ff_kf = 0.015;
      var dPfric_kf = ff_kf * rM_kf * vm_kf * Math.abs(vm_kf) / (2 * GC * D_ft * 144);
      st.P[kf] = Math.max(14.7, st.P[kf + 1] - (rM_kf / 144 + dPfric_kf) * dz);
    }
    // FIX-F: post-cascade energy check.
    // When the transient column is loaded enough that the integrated hydrostatic
    // weight consumes all available drawdown, st.P[0] lands at or below P_sep.
    // The previous floor (Math.max(P_sep+3, P[0])) papered over this by raising
    // WHP while keeping qG flowing — a phantom flow state.
    // Threshold P_sep+5 (5 psi above back-pressure) gives a small numerical
    // margin; tighter than the old +3 floor but generous enough to avoid
    // false-positive kills on normal choke-pressure transients.
    var _P_sep_f = p.P_sep || 250;
    if (st.P[0] < _P_sep_f + 5) {
      // Column weight has consumed available drawdown — collapse rate.
      st.WHP  = Math.max(14.7, st.P[0]);   // show actual hydrostatic WHP
      st.P[0] = st.WHP;
      st.BHP  = st.P[NC - 1];
      st.qG   = 0;
      for (var _kz = 0; _kz < NC; _kz++) st.vm[_kz] = 0;
    } else {
      st.WHP  = Math.max(_P_sep_f + 3, st.P[0]);
      st.P[0] = st.WHP;
      st.BHP  = st.P[NC - 1];
    }
    var qGs_f = st.qG * 1e6 / 86400;
    var qLs_f = ((p.wgr||0)+(p.cgr||0)) * st.qG * 5.615 / 86400;
    for (var kfm = 0; kfm < NC; kfm++) {
      var z_kfm  = (kfm + 0.5) * dz;
      var TR_kfm = p.T_surf + (p.geo_grad / 100) * z_kfm + 459.67;
      var Vg_kfm = Math.max(cellVol - st.VL[kfm], cellVol * 0.005);
      var rG_kfm = gasDen(Math.max(st.P[kfm], 14.7), TR_kfm, p.sg);
      st.mG[kfm] = rG_kfm * Vg_kfm;
      var Z_kfm   = papayZ(Math.max(st.P[kfm], 14.7), TR_kfm, p.sg);
      var vsg_kfm = qGs_f * Z_kfm * (TR_kfm / 520) * (14.7 / Math.max(st.P[kfm], 14.7)) / Ap;
      st.vm[kfm]  = Math.min(30, vsg_kfm + qLs_f / Ap);
    }
  }

  // ── STATE LABELS + DIAGNOSTICS ────────────────────────────
  var TR_w  = p.T_surf + 459.67;
  var rG_w  = gasDen(Math.max(st.WHP, 50), TR_w, p.sg);
  var effD  = (p.vs_on && p.vs_id > 0) ? (p.vs_id / 12) : D_ft;
  var effAp = Math.PI * (effD / 2) * (effD / 2);
  var Z_w   = papayZ(Math.max(st.WHP, 50), TR_w, p.sg);
  var vsg_w = st.qG * 1e6 / 86400 * Z_w * (TR_w / 520) * (14.7 / Math.max(st.WHP, 50)) / effAp;
  var qLs_w = ((p.wgr || 0) + (p.cgr || 0)) * st.qG * 5.615 / 86400;
  var vsl_w = qLs_w / effAp;
  var vT_w  = (p.turner_const || 5.62) * Math.pow(lp.sig * Math.max(rhoL - rG_w, 1) / Math.max(rG_w * rG_w, 0.01), 0.25);
  st.turnerRatio = vsg_w / Math.max(vT_w, 0.01);
  st.carryFrac   = carryFractionMech(vsg_w, vsl_w, rhoL, rG_w, lp.sig, effD, p.turner_const || 5.62);

  var nTop = Math.min(6, NC), sTop = 0, cTop = 0, bTop = 0, wSum = 0;
  for (var ti = 0; ti < nTop; ti++) {
    var wi  = (nTop - ti) / nTop; wSum += wi;
    var hl_ti = st.HL[ti], vm_ti = st.vm[ti] || 0;
    var rG_ti = gasDen(Math.max(st.P[ti], 14.7), TR_w, p.sg);
    var gr_ti = grayCorrelation(
      Math.max(vm_ti * Math.max(1 - hl_ti, 0.005), 0.001),
      Math.max(vm_ti * hl_ti, 0.001),
      rhoL, rG_ti, lp.sig, D_ft, lp.muL);
    if (gr_ti.regime === 'slug')   sTop += wi;
    if (gr_ti.regime === 'churn')  cTop += wi;
    if (gr_ti.regime === 'bubble') bTop += wi;
  }
  st.slugTopFrac   = sTop / Math.max(wSum, 1e-9);
  st.churnTopFrac  = cTop / Math.max(wSum, 1e-9);
  st.bubbleTopFrac = bTop / Math.max(wSum, 1e-9);

  var km_slug   = Math.floor(NC / 2);
  var z_slug    = (km_slug + 0.5) * dz;
  var TR_slug   = p.T_surf + (p.geo_grad / 100) * z_slug + 459.67;
  var P_slug    = Math.max(st.P[km_slug], 14.7);
  var se_slug   = wetGasSG(p.sg, p.cgr, P_slug, p.P_dew || 0);
  var Z_slug    = papayZ(P_slug, TR_slug, se_slug);
  var rG_slug   = gasDen(P_slug, TR_slug, se_slug);
  var qGs_slug  = st.qG * 1e6 / 86400;
  var qLs_slug  = ((p.wgr || 0) + (p.cgr || 0)) * st.qG * 5.615 / 86400;
  var vsg_slug  = Math.max(0.001, Math.min(40,
    qGs_slug * Z_slug * (TR_slug / 520) * (14.7 / P_slug) / effAp));
  var vsl_slug  = Math.max(0.001, Math.min(8, qLs_slug / effAp));
  var HL_slug_mid = st.HL[km_slug];
  st.slugFreqHz = slugFreq(vsl_slug, vsg_slug, effD, lp.rL, rG_slug, lp.sig);
  st.HL_mid     = HL_slug_mid;
  st.qSlugExtra = 0;

  var Vwb  = Ap * p.TD / 5.615;
  var fill = st.Vliq / Math.max(Vwb, 0.01);
  var dVdt = st.qLiqIn - st.qLiqOut;

  if (st.isShutIn) {
    if (st.t_shutin === 0 || st.t_shutin > st.simTime) {
      st.t_shutin   = st.simTime;
      // Use qG_prev (captured before Step C zeroed st.qG) so that q_shutin
      // carries the actual flowing rate.  The old code read st.qG which was
      // already 0 here, forcing the || 0.1 fallback and collapsing m_horner
      // by ~4 orders of magnitude.  Also preserve any previously stored value
      // (step where well was already shut-in on init) rather than defaulting
      // to 0.1; fall back only if genuinely no rate history exists at all.
      st.q_shutin   = qG_prev > 0.001 ? qG_prev
                    : (st.q_shutin > 0.001 ? st.q_shutin : 1.0);
      st.Pwf_shutin = st.BHP;
      // v3.1: Horner slope uses p.h_net if available, else heuristic
      var TR_hor  = p.T_surf + (p.geo_grad / 100) * p.TD + 459.67;
      var muG_hor = leeGonzMuG(Math.max(p.Pr, 100), TR_hor, p.sg);
      var Z_hor   = papayZ(Math.max(p.Pr, 100), TR_hor, p.sg);
      var Bg_hor  = Z_hor * (TR_hor / 520) * (14.7 / Math.max(p.Pr, 100)) * 1000 / 5.615;
      var h_hor   = Math.max(5, p.h_net || Math.min(100, Math.max(20, p.TD * 0.01)));
      var q_hor   = st.q_shutin * 1000;  // MMscfd → Mscfd
      st.m_horner = 162.6 * q_hor * muG_hor * Bg_hor /
                    Math.max((p.k_md || 5) * h_hor, 0.01);
    }
    st.stateLabel = st.qG > 0.01 ? 'shutting-in' : 'equalizing';
  } else if (st.qG < 0.01) {
    st.stateLabel = (st.BHP > 14.7 && st.BHP < p.Pr * 0.99 && fill > 0.1) ? 'percolating' : 'dead';
  } else if (st.turnerRatio >= 1.1 && dVdt <= 0) {
    st.t_shutin = 0;
    st.stateLabel = 'stable';
  } else if (dVdt < -1) {
    st.t_shutin = 0;
    st.stateLabel = 'unloading';
  } else if (st.turnerRatio >= 0.7 && st.turnerRatio < 1.1) {
    st.t_shutin = 0;
    st.stateLabel = 'marginal';
  } else if (dVdt > 1) {
    st.t_shutin = 0;
    st.stateLabel = 'loading';
  } else {
    st.t_shutin = 0;
    st.stateLabel = 'recovering';
  }

  // v3.1: material-balance equivalent producing time
  // tp_eq [hr] = Gp_cum [MMscf] × 24 [hr/day] / q_current [MMscfd]
  // Ref: Agarwal (1979), SPE 8279
  // At stable rate: tp_eq = actual clock time (identical to v3.0 result)
  // After rate history: shorter/longer as appropriate for Horner superposition
  if (!st.isShutIn && st.qG > 0.001) {
    st.Gp_cum = (st.Gp_cum || 0) + st.qG * dtHr / 24;
    st.tp_hr  = st.Gp_cum * 24 / Math.max(st.qG, 1e-6);
  }

  st.simTime += dtHr;

  // v3.4.5: exponential moving average of rates for slug-flow display stability.
  // In slug flow, instantaneous qLiqOut and qG swing violently over the slug
  // cycle (2-60 seconds), making the Production/Liquid-Balance UI panels
  // unreadable and misleading. τ = 60 s matches typical slug cycle periods
  // for 3-4" tubing so the display reflects the cycle-averaged behaviour
  // (which at quasi-steady state equals the reservoir delivery).
  var tau_ema = 60;                              // seconds
  var alpha   = 1 - Math.exp(-dt / tau_ema);     // 0.155 at dt=10s; 0.63 at dt=60s
  st.qLiqIn_ema  = (st.qLiqIn_ema  || 0) * (1 - alpha) + (st.qLiqIn  || 0) * alpha;
  st.qLiqOut_ema = (st.qLiqOut_ema || 0) * (1 - alpha) + (st.qLiqOut || 0) * alpha;
  st.qG_ema      = (st.qG_ema      || 0) * (1 - alpha) + (st.qG      || 0) * alpha;
}

// -------------------------------------------------------
// REOPEN FLUSH (FIX-C) — minimal pressure relief only
// -------------------------------------------------------
// Purpose: prevent the well dying on the very first step.
// When BHP≫Pwf_vlp the nodal solve finds a valid rate even
// with a full liquid column — no flush needed at all.
// When BHP is only slightly above Pwf_vlp the first step
// would see the loaded VLP above IPR and kill qG to zero.
//
// The flush is intentionally SMALL (cap 0.12) so the visual
// unloading happens gradually via the transient engine's
// intercell transport (FIX-A/B), not as a single-step jump.
// This gives the realistic slug-by-slug unloading sequence:
//   liquid column rises → slug reaches surface → rate builds
//   → annular flow develops → stable production.
//
// Physics: only remove liquid from the BOTTOM few cells.
// Gas from the reservoir enters at the bottom and compresses
// the liquid upward — the bottom cells become gas-dominated
// first (as observed in real well tests). Top cells remain
// liquid until the front reaches the surface.
// -------------------------------------------------------
function reopenFlush(st, p) {
  var NC   = st.NC;
  var lp   = liquidProps(p);
  var D_ft = p.id_in / 12;
  var Ap   = Math.PI * (D_ft / 2) * (D_ft / 2);
  var dz   = p.TD / NC, cellVol = Ap * dz;
  var rw   = 0.354, lnReRw = Math.log(Math.max((p.r_e || 1000), 10) / rw);
  var skinMult = 1 + (p.skin || 0) / Math.max(lnReRw, 1);
  var A_eff = (p.A_F || 1) * skinMult, B_eff = p.B_F || 0;

  var BHP_cur = st.BHP || p.Pr;

  // Check if the engine can find a rate without any flush:
  // If BHP > Pwf_vlp at even a tiny rate the first step is fine.
  var Pwf_vlp_min = outflowPwf(0.1, p, 0);
  if (BHP_cur > Pwf_vlp_min * 1.05) return;  // engine will find a rate, no flush needed

  // Only reach here if BHP is borderline — remove a small fraction
  // from bottom cells only to give the engine a starting pressure margin.
  // Cap at 0.12 (12%) — enough to avoid the zero-rate trap, small enough
  // that the wellbore visual still shows mostly liquid at open time.
  var qAOF = computeAOF(p.Pr, A_eff, B_eff);
  var Pwf_vlp_aof = outflowPwf(Math.max(qAOF * 0.5, 0.1), p, 0);
  var dP_lift = Math.max(0, BHP_cur - Pwf_vlp_aof);
  var h_lift  = dP_lift * 144 / Math.max(lp.rL, 50);
  var flush   = Math.min(0.12, h_lift / Math.max(p.TD, 1));

  if (flush < 0.02) return;

  // Remove from bottom third of wellbore only (reservoir gas entry zone)
  var bottomCells = Math.max(1, Math.floor(NC / 3));
  var totalToRemove = flush * st.Vliq * 5.615;
  var remaining     = totalToRemove;
  for (var j = NC - 1; j >= NC - bottomCells && remaining > 0; j--) {
    var remove = Math.min(remaining, st.VL[j] * 0.80);
    st.VL[j]  = Math.max(0, st.VL[j] - remove);
    remaining -= remove;
  }

  // Recompute derived quantities
  var Vliq_new = 0;
  for (var k = 0; k < NC; k++) {
    st.VL[k] = Math.min(st.VL[k], cellVol * 0.99);
    st.HL[k] = st.VL[k] / cellVol;
    Vliq_new += st.VL[k];
  }
  st.Vliq = Vliq_new / 5.615;
}

// -------------------------------------------------------
// RUN TRANSIENT — 20 s max sub-step for CFL stability
// -------------------------------------------------------
// v3.4.6: removed the nSub <= 60 cap. At very high UI speed multipliers
// (2kx or when frames drop and simDt grows beyond ~1200s), the old cap
// forced dtSub above 20s, which violated CFL on the explicit transport
// scheme and produced chaotic limit cycles (qG spikes to 120 MMscfd with
// WHP > BHP — numerically unstable, not physical). Now nSub grows as needed
// to always keep dtSub ≤ 20s. The maxSub argument is retained for callers
// that want an upper bound (e.g. to prevent runaway when simDt is huge),
// but defaults to a safely high value.
function runTransient(st, p, simDt, maxSub) {
  if (simDt <= 0) return 0;
  var dtMax = 20;
  var nSub_need = Math.max(1, Math.ceil(simDt / dtMax));
  var nSub  = maxSub ? Math.min(maxSub, nSub_need) : nSub_need;
  var dtSub = simDt / nSub;
  for (var s = 0; s < nSub; s++) { stepTransient(st, p, dtSub); }
  return nSub;
}

// -------------------------------------------------------
// TRANSIENT → SEGMENT ARRAY
// -------------------------------------------------------
function transientToSegs(st, p) {
  var NC = st.NC, dz = p.TD / NC, D_ft = p.id_in / 12;
  var lp = liquidProps(p), Ap = Math.PI * (D_ft / 2) * (D_ft / 2);
  var segs = [];
  for (var j = 0; j < NC; j++) {
    var z   = (j + 0.5) * dz;
    var TR  = p.T_surf + (p.geo_grad / 100) * z + 459.67;
    var Pj  = Math.max(st.P[j] || 14.7, 14.7);
    var se  = wetGasSG(p.sg, p.cgr, Pj, p.P_dew || 0);
    var rGj = gasDen(Pj, TR, se);
    var HLj = st.HL[j];
    var vm  = st.vm[j] || 0;
    var vsg = Math.max(0, vm * Math.max(1 - HLj, 0.005));
    var vsl = Math.max(0, vm * HLj);
    var gr  = grayCorrelation(Math.max(vsg, 0.001), Math.max(vsl, 0.001), lp.rL, rGj, lp.sig, D_ft, lp.muL);
    var vT  = (p.turner_const || 5.62) * Math.pow(lp.sig * Math.max(lp.rL - rGj, 1) / Math.max(rGj * rGj, 0.01), 0.25);
    var regime = gr.regime;

    if (st.isShutIn) {
      regime = HLj < 0.15 ? 'gas_zone' : HLj > 0.55 ? 'liquid_zone' : 'segregating';
    } else if (st.stateLabel === 'dead') {
      regime = 'liquid_zone';
    } else if (st.stateLabel === 'percolating') {
      regime = 'bubble';
    }

    segs.push({ depth: z, P: Pj, rG: rGj, vsg: vsg, vsl: vsl, HL: HLj,
      regime: regime, siPhase: regime, Ngv: gr.Ngv, KuG: gr.KuG,
      C0: gr.C0, Vd: gr.Vd, vT: vT, vTR: vsg / Math.max(vT, 0.01), sg_eff: se,
      Gamma: (st.Gamma && st.Gamma[j]) ? st.Gamma[j] : 0 });
  }
  // FIX-E: display-only monotonicity pass.
  // Re-label any annular/churn cell that lies below a liquid-dominated cell
  // (HL > 0.55) as bubble.  Scans top-to-bottom in a single O(n) pass.
  // No holdup or pressure values are touched.
  var _liqEnc = false;
  for (var _k = 0; _k < segs.length; _k++) {
    if (segs[_k].HL > 0.55) {
      _liqEnc = true;
    } else if (_liqEnc &&
               (segs[_k].regime === 'annular' || segs[_k].regime === 'churn')) {
      segs[_k].regime  = 'bubble';
      segs[_k].siPhase = 'bubble';
    }
  }

  return segs;
}

function transientSurfaceData(st, p) {
  var cf = st.carryFrac || 0, qG = st.qG, WHP = st.WHP || (p.P_sep || 250);
  var wRes = (p.wgr || 0) * qG;
  var cRes = (p.cgr || 0) * qG;

  var wgr = p.wgr || 0, cgr = p.cgr || 0;
  var liqTotal = wgr + cgr;
  var wFrac = liqTotal > 0 ? wgr / liqTotal : 0;
  var cFrac = liqTotal > 0 ? cgr / liqTotal : 1;
  // v3.4.5: use exponentially-smoothed qLiqOut for display, so slug-flow
  // cycles don't cause the Production panel to flicker between 0 and peak.
  // The EMA over τ=60s approximates what an actual surface measurement would
  // read at normal sampling rates.
  var qLiqSurf = st.qLiqOut_ema || st.qLiqOut || 0;

  var waterSurf = qLiqSurf * wFrac;

  var Pd = p.P_dew || 0;
  var cSurf;
  if (Pd <= 0 || WHP >= Pd) {
    cSurf = cRes;
  } else {
    var lf = Math.min(1, Math.max(0, 1 - WHP / Math.max(Pd, 1)));
    cSurf = qLiqSurf * cFrac * lf + cRes * (1 - lf);
  }

  return {
    gasRate: qG, waterRate: waterSurf, condRate: cSurf,
    waterRate_reservoir: wRes, condRate_reservoir: cRes,
    WHP: WHP, BHP: st.BHP || p.Pr, turnerRatio: st.turnerRatio || 0,
    vsg: 0, vT: 1, vm0: qG > 0.001 ? (st.vm[0] || 0) : 0,
    Vliq: st.Vliq, stateLabel: st.stateLabel, carryFrac: st.carryFrac,
    qSlugExtra: 0, slugTopFrac: st.slugTopFrac || 0,
    churnTopFrac: st.churnTopFrac || 0, bubbleTopFrac: st.bubbleTopFrac || 0,
    slugFreqHz: st.slugFreqHz || 0, slugLiquidVol_bbl: 0,
    qLiqIn: st.qLiqIn_ema || st.qLiqIn || 0, qLiqOut: st.qLiqOut_ema || st.qLiqOut || 0, VliqEquil: 0,
    qLiqDrain: st.qLiqDrain || 0,
    HL_mid: st.HL_mid || 0,
    rL: 0, rG_mid: 0,
    // PBU diagnostics
    m_horner:   st.m_horner   || 0,
    tp_hr:      st.tp_hr      || 0,   // material-balance equiv time [hr]
    Gp_cum:     st.Gp_cum     || 0,   // cumulative gas [MMscf]
    Pwf_shutin: st.Pwf_shutin || 0,
    Dt_pbu: st.isShutIn && st.t_shutin > 0 ? Math.max(0, st.simTime - st.t_shutin) : 0
  };
}

// -------------------------------------------------------
// LEGACY STUBS — interface compatibility with app.js
// -------------------------------------------------------
function computeHydrostatic(st, p) {
  var NC = st.NC, dz = p.TD / NC, lp = liquidProps(p);
  st.P[NC - 1] = p.Pr;
  for (var j = NC - 2; j >= 0; j--) {
    var z  = (j + 0.5) * dz, TR = p.T_surf + (p.geo_grad / 100) * z + 459.67;
    var rG = gasDen(Math.max(st.P[j + 1], 14.7), TR, p.sg);
    var rM = lp.rL * st.HL[j] + rG * (1 - st.HL[j]);
    st.P[j] = Math.max(14.7, st.P[j + 1] - rM * dz / 144);
  }
  st.WHP = st.P[0]; st.BHP = st.P[NC - 1];
}

function computeEquilibriumVliq(p) {
  var D_ft = p.id_in / 12, Ap = Math.PI * (D_ft / 2) * (D_ft / 2), Vwb = Ap * p.TD / 5.615;
  var TR_avg = p.T_surf + (p.geo_grad / 100) * p.TD * 0.5 + 459.67;
  var rG_avg = gasDen(p.Pr * 0.85, TR_avg, p.sg), rhoL = liquidProps(p).rL;
  var WHP_ag = p.Pr - rG_avg * p.TD / 144;
  if (WHP_ag > 50) return 0.02 * Vwb;
  var hL = Math.min(Math.max(0, (p.Pr * 144 - rG_avg * p.TD) / Math.max(rhoL - rG_avg, 1)), p.TD * 0.8);
  return hL * Ap / 5.615;
}

function findLoadedOP(p, Vliq) { return findLoadedOP_skin(p, Vliq, p.A_F || 1, p.B_F || 0); }

function findLoadedOP_skin(p, Vliq, A_eff, B_eff) {
  var D_ft = p.id_in / 12, Ap = Math.PI * (D_ft / 2) * (D_ft / 2), Vwb = Ap * p.TD / 5.615;
  var fill = Math.min(0.98, Vliq / Math.max(Vwb, 0.01)), hLiq = fill * p.TD;
  var lp = liquidProps(p), hGas = p.TD - hLiq, Tr = p.T_surf + 459.67;
  var rGt = gasDen(Math.max((p.P_sep || 250), 50), Tr, p.sg);
  var rGb = gasDen(Math.max((p.P_sep || 250) + rGt * hGas / 144, 50),
              p.T_surf + (p.geo_grad / 100) * hGas + 459.67, p.sg);
  var rGa = (rGt + rGb) / 2;
  var BHP_est = (p.P_sep || 250) + rGa * hGas / 144 + lp.rL * hLiq / 144;
  if (BHP_est >= p.Pr * 0.97) return { q_op: 0, pwf_op: p.Pr, noFlow: true };
  var dP  = (lp.rL - rGa) * hLiq / 144;
  var eHL = Math.max(0, Math.min(0.92, dP * 144 / (Math.max(lp.rL - rGa, 1) * p.TD)));
  return findOperatingPoint(p, A_eff, B_eff, eHL);
}

function mechanisticSlugSurfaceTransport(st, p, qLiqIn_bpd, qLiqCarry_bpd, dtHr) {
  return { qLiqOut_bpd: qLiqCarry_bpd, qSlugExtra_bpd: 0,
    slugTopFrac: st.slugTopFrac || 0, churnTopFrac: st.churnTopFrac || 0,
    bubbleTopFrac: st.bubbleTopFrac || 0, slugFreqHz: st.slugFreqHz || 0, slugLiquidVol_bbl: 0 };
}

// -------------------------------------------------------
// foamSigma — Langmuir-CMC surface tension model
// Used by liquidProps batch treatment branch.
// sig_base: baseline σ dyn/cm | conc_pct: wt%
// type: 'anionic' | 'nonionic' | 'cationic'
// -------------------------------------------------------
function foamSigma(sig_base, conc_pct, type, T_F, sal_ppm) {
  var s_min = (type === 'nonionic') ? 24 : (type === 'cationic') ? 26 : 22;
  var cmc   = (type === 'nonionic') ? 0.12 : (type === 'cationic') ? 0.15 : 0.08;
  if (type !== 'nonionic') cmc = cmc * (1 + 0.4 * ((sal_ppm || 0) / 100000));
  s_min = Math.max(15, s_min - 0.07 * Math.max(0, (T_F || 85) - 70));
  var theta = conc_pct / (conc_pct + cmc);
  return sig_base * (1 - theta) + s_min * theta;
}

// -------------------------------------------------------
// FOAM BATCH RECOMMENDATION v3.5 — compatibility wrapper
// Bridges WM.foam.foamRecommendation (foam.js, Sessions A–D)
// to the existing app.js call signature:
//   M.foamRecommendation(tsState, p, batchConc, foamType)
// Returns foamResult with both legacy field names (for the
// existing UI) and extended fields (for future panels).
// Safe no-op when foam.js is not loaded.
// -------------------------------------------------------
function foamRecommendation(st, p, batchConc, foamType) {
  if (!window.WM || !window.WM.foam) { return null; }

  var fm    = window.WM.foam;
  var D_ft  = p.id_in / 12;
  var Ap    = Math.PI * (D_ft / 2) * (D_ft / 2);

  // Liquid column geometry from live transient state
  var Vliq_bbl = st.Vliq || 0;
  var H_liq    = Vliq_bbl * 5.615 / Math.max(Ap, 1e-6);
  var topLiq   = Math.max(0, p.TD - H_liq);

  // SIWHP: use current WHP when shut-in; estimate from BHP when flowing
  var lp_wr = liquidProps(p);
  var SIWHP;
  if (st.isShutIn) {
    SIWHP = Math.max(50, st.WHP || st.P[0] || p.Pr * 0.5);
  } else {
    var BHP_wr = st.BHP || p.Pr;
    SIWHP = Math.max(50, BHP_wr
      - lp_wr.rL * H_liq / 144
      - gasDen(Math.max(BHP_wr, 50), p.T_surf + 459.67, p.sg) * topLiq / 144);
  }

  var p_foam = Object.assign({}, p, {
    topLiq: topLiq,  SIWHP: SIWHP,
    ftype:  foamType  || 'anionic',
    conc:   batchConc || 0.10,
    P_sep:  p.P_sep   || 250,
  });

  var rec = fm.foamRecommendation(p_foam, p.A_F || 1, p.B_F || 0);

  // Likelihood verdict for existing UI traffic-light
  var likelihood, likColor;
  if (!rec.success) {
    likelihood = 'NOT LIKELY'; likColor = '#f87171';
  } else {
    var mrg = (rec.stages && rec.stages[0]) ? (rec.stages[0].margin_pct || 0) : 0;
    if (mrg >= 15) { likelihood = 'LIKELY';   likColor = '#4ade80'; }
    else           { likelihood = 'MARGINAL'; likColor = '#fbbf24'; }
  }

  // Flatten stages → legacy array format expected by existing chokeStages display
  var chokeStages = [], chokeHold = [];
  if (rec.stages && rec.stages.length > 0) {
    rec.stages.forEach(function(s) {
      chokeStages.push(s.choke_64    || 16);
      chokeHold.push(Math.round(s.t_hold_min || 30));
    });
  } else {
    chokeStages = [0]; chokeHold = [0];   // infeasible — placeholder
  }

  return {
    // ── Legacy fields — consumed by existing app.js UI ──
    sig_base:      +(rec.sig_base      || 0).toFixed(1),
    sig_foam:      +(rec.sig_foam      || 0).toFixed(1),
    vT_before:     +(rec.vT_before_fts || 0),
    vT_after:      +(rec.vT_after_fts  || 0),
    V_liq_bbl:     +(rec.Vliq_bbl || Vliq_bbl).toFixed(1),
    V_neat_gal:    +(rec.Vneat_gal || 0).toFixed(1),
    V_rec_gal:     +(rec.Vrec_gal  || 0).toFixed(1),
    t_contact_min: rec.contact_time_min || 45,
    likelihood:    likelihood,
    likColor:      likColor,
    chokeStages:   chokeStages,
    chokeHold:     chokeHold,
    // ── Extended fields — available for future UI expansion ──
    success:           rec.success,
    stages:            rec.stages || [],
    vsg_perc_fts:      +(rec.vsg_perc_fts || 0).toFixed(4),
    vsg_ch_fts:        +(rec.vsg_ch_fts   || 0).toFixed(3),
    margin_pct:        (rec.stages && rec.stages[0]) ? rec.stages[0].margin_pct : -999,
    total_time_min:    rec.total_time_min  || 0,
    restriction_stage: rec.restriction_stage || null,
    final_WHP_psi:     rec.final_WHP_psi   || 0,
    final_q_Mscfd:     rec.final_q_Mscfd   || 0,
    Psep_min_psi:      rec.Psep_min_psi    || 0,
    Pr_psi:            rec.Pr_psi          || p.Pr,
  };
}

// -------------------------------------------------------
// EXPORTS — identical interface to v3.0
// -------------------------------------------------------
window.WM = {
  GC: GC, G_SI: G_SI, FT2M: FT2M, TNC: TNC, NS: NS,
  gasMassToP: gasMassToP,
  papayZ: papayZ, gasDen: gasDen, leeGonzMuG: leeGonzMuG,
  moodyFF: moodyFF, waterProps: waterProps, liquidProps: liquidProps,
  grayCorrelation: grayCorrelation, pressureGrads: pressureGrads,
  carryFractionMech: carryFractionMech,
  computeWHP: computeWHP, computeWHP2: computeWHP2,
  wetGasSG: wetGasSG,
  iprPwf: iprPwf, computeAOF: computeAOF,
  outflowPwf: outflowPwf,
  findOperatingPoint: findOperatingPoint,
  buildNodalCurves: buildNodalCurves,
  computeProfile: computeProfile,
  slugFreq: slugFreq, surfFluct: surfFluct,
  createTransientState: createTransientState,
  initTransientState: initTransientState,
  initTransientStatic: initTransientState,
  computeHydrostatic: computeHydrostatic,
  findLoadedOP: findLoadedOP,
  findLoadedOP_skin: findLoadedOP_skin,
  computeEquilibriumVliq: computeEquilibriumVliq,
  stepTransient: stepTransient,
  runTransient: runTransient,
  reopenFlush: reopenFlush,
  transientToSegs: transientToSegs,
  mechanisticSlugSurfaceTransport: mechanisticSlugSurfaceTransport,
  transientSurfaceData: transientSurfaceData,
  // v3.3: radial reservoir grid (proper PBU/drawdown dynamics)
  createReservoirState: createReservoirState,
  initReservoirSteady: initReservoirSteady,
  stepReservoir: stepReservoir,
  reservoirIPR: reservoirIPR,
  reservoirAinner: reservoirAinner,
  // v3.5: foam batch treatment (requires foam.js loaded before model.js)
  foamSigma: foamSigma,
  foamRecommendation: foamRecommendation
};
// foam.js saves its API to window._wm_foam before model.js runs.
// Restore it now that window.WM has been replaced with the new object.
if (window._wm_foam) { window.WM.foam = window._wm_foam; }
