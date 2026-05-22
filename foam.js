// =============================================================================
// foam.js — Foam Batch Treatment Module
// wellmodel.app v3.4.x — Phase 2 standalone implementation
//
// Sessions A–D physics. No runtime dependency on model.js.
// All units are Imperial internally (psi, ft, lb/ft³, ft/s, Mscfd, °F, dyn/cm).
//
// Public API (exposed as WM.foam.*):
//   Session A — thresholds:
//     percolationThreshold(sig, rhoL, rhoG, ftype)  → ft/s
//     channelingCeiling(D_ft, rhoL, rhoG, ftype)    → ft/s
//   Session B — dynamics:
//     foamQualityStep(Gamma, vsg, vsg_perc, ftype, dt_s) → Gamma_new
//     foamFrontVelocity(vsg, ftype)                 → ft/s
//   Session C — modified properties:
//     foamDensity(Gamma, rhoL, rhoG)                → lb/ft³
//     foamViscosity(Gamma, muL)                     → cp
//     foamDriftFlux(Gamma, Vd_liq, ftype)           → {C0, Vd}
//     foamTurner(Gamma, rhoL, rhoG, sig_foam)       → ft/s
//     foamModifyProps(baseProps, Gamma, rhoG_cell)  → modifiedProps
//   Session D — open-up simulation:
//     openUpStep(state, fp, dt_s)   → {state, d}
//     chokeSequence(p, A_F, B_F)    → {success, stages, ...}
//   Recommendation wrapper:
//     foamRecommendation(p, A_F, B_F) → extended result object
//   Constants:
//     FOAM, GAMMA_C
//
// Integration with model.js (Phase 4):
//   - foamModifyProps() slots between liquidProps() and grayCorrelation()
//   - foamQualityStep() runs per cell in step() loop after vsg is known
//   - Add Gamma: new Float64Array(N) to createTransientState()
//   - Pass C0_override / Vd_fraction from foamModifyProps into grayCorrelation()
// =============================================================================

(function (root) {
  'use strict';

  // ── Physical constants ────────────────────────────────────────────────────
  var G_SI   = 9.806;      // m/s²  (used in channeling ceiling conversion)
  var FT2M   = 0.3048;     // ft → m
  var BBL2FT3 = 5.615;     // bbl → ft³

  // ── Foam type parameters ──────────────────────────────────────────────────
  // K          : percolation threshold multiplier           [Session A, Eq.1]
  // fch        : channeling ceiling multiplier              [Session A, Eq.2]
  // Kmin       : σ reduction factor floor (above CMC)       [σ_foam/σ_base]
  // cmc        : critical micelle concentration, wt%
  // Gs         : steady-state foam quality Γ_s              [Session B, Eq.3]
  // kgen       : foam generation rate constant, s⁻¹         [Session B, Eq.5]
  // kdec       : foam decay rate constant, s⁻¹              [Session B, Eq.5]
  // mu0_bulk   : apparent foam viscosity at zero shear [cP]  [Session C, lab]
  // mu_slope   : shear-thinning slope [cP per 1/s]          [Session C, lab]
  // r_bubble_m : mean bubble radius [m]                     [Session C, lab]
  //
  // ── Anionic calibration source (lab data, N₂ foam at 250°F) ──────────────
  //   Gs   = 0.65  : Fig.6 dynamic stability plateau at 250°F / 1500 psi
  //   kdec = 8.88e-5: Fig.5 static half-life = 130 min at 250°F / 500 psi
  //                   k = ln(2) / (130 × 60) = 8.88 × 10⁻⁵ s⁻¹
  //   mu0_bulk/mu_slope: Fig.7 rheometer, y = −0.0846x + 77.328 [cP, 1/s]
  //   r_bubble_m : Fig.5b mean bubble area 26760 μm² → r = √(A/π) = 92 μm
  var FOAM = {
    anionic: {
      K: 0.634, fch: 3.5, Kmin: 0.58, cmc: 0.05,
      Gs:   0.65,     // ← was 0.70; lab Fig.6 plateau
      kgen: 2.00e-3,
      kdec: 8.88e-5,  // ← was 2.00e-4; lab Fig.5 t_half = 130 min
      mu0_bulk:    77.3,    // lab Fig.7: apparent viscosity intercept [cP]
      mu_slope:    0.0846,  // lab Fig.7: shear-thinning slope [cP / (1/s)]
      r_bubble_m:  92e-6,   // lab Fig.5b: mean bubble radius [m]
    },
    nonionic: { K:0.750, fch:2.8, Kmin:0.65, cmc:0.04, Gs:0.65, kgen:1.50e-3, kdec:2.50e-4 },
    cationic: { K:0.900, fch:2.0, Kmin:0.72, cmc:0.08, Gs:0.58, kgen:1.00e-3, kdec:3.83e-4 },
  };

  // Percolation threshold void fraction (universal — from bubbly flow theory)
  var GAMMA_C = 0.36;

  // ── PRIVATE: Fluid physics ────────────────────────────────────────────────

  // Z-factor: modified Papay for Ppr ≤ 6, linear S-K extension above.
  // Standalone version — no 1.2 cap present in model.js papayZ().
  // Handles the high-pressure regime (Ppr > 6) that papayZ() underestimates.
  function _calcZ(P, T_R, sg) {
    if (P <= 0) return 1.0;
    var Ppc = 677 + 15 * sg - 37.5 * sg * sg;
    var Tpc = 168 + 325 * sg - 12.5 * sg * sg;
    var Ppr = Math.max(0.01, Math.min(P / Ppc, 15));
    var Tpr = Math.max(T_R / Tpc, 1.05);
    var ex1 = Math.pow(10, 0.9813 * Tpr);
    var ex2 = Math.pow(10, 0.8157 * Tpr);
    var Zpap = 1 - 3.52 * Ppr / ex1 + 0.274 * Ppr * Ppr / ex2;
    if (Ppr <= 6) return Math.max(0.4, Zpap);
    // Ppr > 6: Z6 from Papay + linear slope calibrated to Standing-Katz at Tpr≈1.9
    var Z6    = 1 - 3.52 * 6 / ex1 + 0.274 * 36 / ex2;
    var slope = 0.12 * (Tpr / 1.9);
    return Math.max(0.4, Z6 + (Ppr - 6) * slope);
  }

  // Gas density lb/ft³
  function _gasDen(P, T_R, sg) {
    return 28.97 * sg * P / (10.73 * _calcZ(P, T_R, sg) * T_R);
  }

  // Water surface tension dyn/cm (Vargaftik 1983 fit)
  function _waterSig(T_F) {
    var TC = (T_F - 32) * 5 / 9;
    return Math.max(25, 75.6 - 0.1766 * TC - 2.67e-4 * TC * TC);
  }

  // Water density lb/ft³ (with salinity correction, matches model.js waterProps)
  function _waterRho(T_F, sal_kppm) {
    var sal = sal_kppm || 0;
    var TC  = (T_F - 32) * 5 / 9;
    return 62.4 * (1 + 0.695e-6 * sal)
                * (1 - Math.max(-0.02, Math.min(0.05, (TC - 15) * 3.6e-4)));
  }

  // Water viscosity cp (matches model.js waterProps)
  function _waterMu(T_F, sal_kppm) {
    var sal = sal_kppm || 0;
    return Math.max(0.3, Math.exp(1.003 - 1.479e-2 * T_F + 1.982e-5 * T_F * T_F)
                        * (1 + 1.5e-5 * sal));
  }

  // Base liquid properties at average wellbore temperature
  function _liqBase(p) {
    var Tavg = p.T_surf + (p.geo_grad / 100) * p.TD / 2;
    var sal  = p.salinity || 0;
    var wgr  = p.wgr || 0, cgr = p.cgr || 0;
    var wV   = (wgr + cgr) > 0 ? wgr / (wgr + cgr) : 0.5;
    var rhoW = _waterRho(Tavg, sal);
    var muW  = _waterMu(Tavg, sal);
    var sigW = _waterSig(Tavg);
    return {
      rhoL:    wV * rhoW + (1 - wV) * 49.9,
      muL:     wV * muW  + (1 - wV) * 0.5,
      sigBase: wV * sigW + (1 - wV) * 20.0,
      wV:      wV,
      Tavg:    Tavg,
    };
  }

  // Surfactant sigma reduction: CMC-based exponential approach
  function _sigFoam(sigBase, ftype, conc) {
    var fm  = FOAM[ftype] || FOAM.anionic;
    var fac = fm.Kmin + (1 - fm.Kmin) * Math.exp(-Math.max(0, conc) / fm.cmc);
    return sigBase * fac;
  }

  // IPR backpressure quadratic: Pr² - BHP² = A·q + B·q²  [q in Mscfd]
  function _ipr(Pr, BHP, A_F, B_F) {
    var LHS = Math.max(0, Pr * Pr - BHP * BHP);
    if (B_F <= 0) return A_F > 0 ? LHS / A_F : 0;
    var disc = A_F * A_F + 4 * B_F * LHS;
    return Math.max(0, (-A_F + Math.sqrt(Math.max(0, disc))) / (2 * B_F));
  }

  // Build internal foam-params object (fp) from a well params object p
  // fp is the single argument all Session D functions expect
  function _buildFP(p, A_F, B_F) {
    var ftype  = p.ftype || p.foam_type || 'anionic';
    var conc   = p.conc  != null ? p.conc : (p.foam_conc != null ? p.foam_conc : 0.10);
    var topLiq = p.topLiq != null ? p.topLiq : (p.top_liq != null ? p.top_liq : 0);
    var H_liq  = Math.max(0, p.TD - topLiq);
    var dtop   = Math.max(0, p.TD - H_liq);
    var fm     = FOAM[ftype] || FOAM.anionic;
    var lb     = _liqBase(p);
    var sigF   = _sigFoam(lb.sigBase, ftype, conc);
    var TbotF  = p.T_surf + (p.geo_grad / 100) * p.TD;
    var TbotR  = TbotF + 459.67;
    var TsurfR = p.T_surf + 459.67;
    var Apipe  = Math.PI * (p.id_in / 12) * (p.id_in / 12) / 4;
    // Gas cap gradient: representative pressure ≈ 0.70 × SIWHP
    var SIWHP  = p.SIWHP || 1000;
    var Pgcap  = Math.max(50, SIWHP * 0.70);
    var TcapR  = TsurfR + (p.geo_grad / 100) * dtop / 2;
    var rhoGcap = _gasDen(Pgcap, TcapR, p.sg);
    var gG     = rhoGcap / 144;
    var gL     = lb.rhoL / 144;
    // Equilibrium reservoir pressure
    var Pr     = SIWHP + gG * dtop + gL * H_liq;
    var Psep   = p.P_sep != null ? p.P_sep : (p.Psep != null ? p.Psep : 250);
    return {
      TD: p.TD, id_in: p.id_in, H_liq: H_liq, dtop: dtop,
      SIWHP: SIWHP, Pr: Pr, Psep: Psep,
      A_F: A_F || p.A_F || 1, B_F: B_F || p.B_F || 0,
      sg: p.sg, TbotR: TbotR, TsurfR: TsurfR, geo_grad: p.geo_grad,
      rhoL: lb.rhoL, muL: lb.muL, sigBase: lb.sigBase, sigFoam: sigF,
      gG: gG, gL: gL, Apipe: Apipe,
      ftype: ftype, conc: conc, fm: fm,
      Gs: fm.Gs, kgen: fm.kgen, kdec: fm.kdec,
    };
  }

  // Forward model (Session D, Eq.15):
  // Given WHP and h_front → {BHP, q, vsg, v_front, rhoG, rhoFoam, Z}
  function _forward(WHP, h_front, fp) {
    var h_rem  = Math.max(0, fp.H_liq - h_front);

    // First-pass BHP estimate (ignoring foam zone density variation with P)
    var BHP1   = WHP + fp.gG * fp.dtop + fp.gL * h_rem + 0.15 * fp.rhoL / 144 * h_front;
    BHP1       = Math.max(fp.Psep + 1, BHP1);

    // Foam zone density using first-pass BHP for rhoG
    var rhoGfm = _gasDen(BHP1, fp.TbotR, fp.sg);
    var rhoFm  = (1 - fp.Gs) * fp.rhoL + fp.Gs * rhoGfm;
    var gFm    = rhoFm / 144;

    // Refined BHP
    var BHP    = WHP + fp.gG * fp.dtop + fp.gL * h_rem + gFm * h_front;
    BHP        = Math.max(fp.Psep + 1, BHP);

    // Refine once more (single Picard iteration — sufficient for h_front << TD)
    rhoGfm = _gasDen(BHP, fp.TbotR, fp.sg);
    rhoFm  = (1 - fp.Gs) * fp.rhoL + fp.Gs * rhoGfm;
    gFm    = rhoFm / 144;
    BHP    = WHP + fp.gG * fp.dtop + fp.gL * h_rem + gFm * h_front;
    BHP    = Math.max(fp.Psep + 1, BHP);

    // Reservoir inflow [Mscfd]
    var q      = _ipr(fp.Pr, BHP, fp.A_F, fp.B_F);

    // In-situ vsg at perforations [ft/s] (Eq.15)
    // Derivation: q_std[scf/s] × (14.7/P) × (T_R/520) × Z / A_pipe
    //           = q[Mscfd] × 0.011574 × 14.7/520 × T_R × Z / (P × A_pipe)
    //           = q × 3.2712e-4 × T_R × Z / (P × A_pipe)
    var Z      = _calcZ(BHP, fp.TbotR, fp.sg);
    var vsg    = q > 0 ? q * 3.2712e-4 * fp.TbotR * Z / (BHP * fp.Apipe) : 0;

    // Gas density at perforations and foam front velocity
    var rhoG   = _gasDen(BHP, fp.TbotR, fp.sg);
    var dRho   = Math.max(0.1, fp.rhoL - rhoG);
    var vfront = vsg / Math.max(fp.Gs, 0.01);

    return {
      BHP: BHP, q: q, vsg: vsg, v_front: vfront,
      Z: Z, rhoG: rhoG, dRho: dRho, rhoFoam: rhoFm, gFoam: gFm,
    };
  }

  // Inverse solver (Session D, Eq.16): WHP for a target vsg via bisection.
  // vsg is monotonically decreasing in WHP, so bisection always converges.
  function _solveWHP(vsg_target, h_front, fp) {
    var lo = fp.Psep, hi = fp.SIWHP;
    if (_forward(lo, h_front, fp).vsg < vsg_target) return lo;  // infeasible
    if (_forward(hi, h_front, fp).vsg > vsg_target) return hi;  // zero drawdown
    for (var i = 0; i < 40; i++) {
      var mid = (lo + hi) / 2;
      if (_forward(mid, h_front, fp).vsg > vsg_target) lo = mid;
      else hi = mid;
      if (hi - lo < 0.5) break;
    }
    return (lo + hi) / 2;
  }

  // Adaptive vsg target (Session D, Eq.17)
  // Hat profile: ramps up to 84% of window mid-unloading, restricts above φ=0.75
  function _vsgTarget(phi, vperc, vch) {
    var f = phi < 0.75
      ? 0.35 + 0.65 * phi
      : Math.max(0, 0.84 - 2.8 * (phi - 0.75));
    return vperc + Math.max(0, f) * (vch - vperc);
  }

  // Estimate choke size (n/64") for given WHP and q (API 14B critical-flow inversion)
  function _chokeN64(q_Mscfd, WHP, T_F, Z_wh, sg) {
    var k  = 1.28, Cd = 0.85;
    var sf = k * Math.pow(2 / (k + 1), (k + 1) / (k - 1));
    var TR = T_F + 459.67;
    var Cc = 879 * Cd * Math.sqrt(sf);  // constant factor (without area)
    // q_Mscfd = Cc × A_in2 × WHP / sqrt(TR × Z × sg)
    // A_in2 = q × sqrt(TR×Z×sg) / (Cc × WHP)
    var A  = q_Mscfd * Math.sqrt(TR * Z_wh * sg) / (Cc * WHP);
    // n/64 where A = π/4 × (n/64)²
    var n  = 64 * Math.sqrt(4 * A / Math.PI);
    return Math.max(2, Math.round(n));
  }

  // Minimum Psep for 15%-above-threshold feasibility (approximate, linear IPR)
  function _minPsep(fp) {
    var BHP_ref = fp.Psep + fp.gG * fp.dtop + fp.gL * fp.H_liq;
    var Z_ref   = _calcZ(Math.max(50, BHP_ref), fp.TbotR, fp.sg);
    var rhoG    = _gasDen(Math.max(50, BHP_ref), fp.TbotR, fp.sg);
    var dRho    = Math.max(0.1, fp.rhoL - rhoG);
    var vp      = percolationThreshold(fp.sigFoam, fp.rhoL, rhoG, fp.ftype);
    var q_need  = 1.15 * vp * BHP_ref * fp.Apipe / (3.2712e-4 * fp.TbotR * Z_ref);
    var lhs     = fp.A_F * q_need + fp.B_F * q_need * q_need;
    var dP_need = lhs / Math.max(1, fp.Pr + BHP_ref);
    return Math.max(0, fp.SIWHP - dP_need);
  }

  // ── SESSION A: Thresholds (Equations 1–2) ────────────────────────────────

  // Eq.1 — Percolation threshold vsg_perc [ft/s]
  // Minimum gas superficial velocity at liquid column base for foam to form.
  // Derived from drift-flux void fraction at Γ_c = 0.36 (random loose packing).
  // Field-unit form: K × 0.790 × (σ·Δρ / ρL²)^0.25
  //   σ [dyn/cm], ρ [lb/ft³], output [ft/s]
  //   Harmathy (1960) converted to field units: Vd_harmathy = 0.790·(σ·Δρ/ρL²)^0.25
  //   K_type: Blauer (1974) / Duerksen (1986) calibration per foamer class
  function percolationThreshold(sig_foam, rhoL, rhoG, ftype) {
    var fm   = FOAM[ftype] || FOAM.anionic;
    var dRho = Math.max(0.1, rhoL - rhoG);
    return fm.K * 0.790 * Math.pow(sig_foam * dRho / Math.max(0.01, rhoL * rhoL), 0.25);
  }

  // Eq.2 — Channeling ceiling vsg_channel [ft/s]
  // Maximum gas flux before Taylor slug formation destroys foam.
  // Diameter-dependent (Taylor bubble speed scales with √D).
  //   vch = f_ch × 0.934 × √(D_ft × Δρ/ρL)
  //   f_ch: surfactant suppression factor (anionic best)
  function channelingCeiling(D_ft, rhoL, rhoG, ftype) {
    var fm   = FOAM[ftype] || FOAM.anionic;
    var dRho = Math.max(0.1, rhoL - rhoG);
    return fm.fch * 0.934 * Math.sqrt(Math.max(0, D_ft * dRho / Math.max(0.01, rhoL)));
  }

  // ── SESSION B: Foam Dynamics (Equations 3–8) ─────────────────────────────

  // Eq.5 — Local foam quality ODE step (explicit Euler, dt in seconds)
  // Building: dΓ/dt = kgen·max(0,vsg/vperc−1)·(Γ_s−Γ)/Γ_s
  // Decaying: dΓ/dt = −kdec·Γ
  // Returns updated Gamma clamped to [0, Γ_s]
  function foamQualityStep(Gamma, vsg, vsg_perc, ftype, dt_s) {
    var fm = FOAM[ftype] || FOAM.anionic;
    var G  = Math.max(0, Math.min(fm.Gs, Gamma));
    var dG;
    if (vsg >= vsg_perc) {
      // Foam building: first-order approach to Γ_s
      var excess = Math.max(0, vsg / Math.max(vsg_perc, 1e-6) - 1);
      dG = fm.kgen * excess * (fm.Gs - G) / Math.max(fm.Gs, 0.01) * dt_s;
    } else {
      // Foam decaying: exponential drainage
      dG = -fm.kdec * G * dt_s;
    }
    return Math.max(0, Math.min(fm.Gs, G + dG));
  }

  // Eq.4 — Foam front propagation velocity [ft/s]
  // From mass balance at the sharp front:
  //   v_front × Γ_s = vsg  →  v_front = vsg / Γ_s
  function foamFrontVelocity(vsg, ftype) {
    var fm = FOAM[ftype] || FOAM.anionic;
    return vsg / Math.max(fm.Gs, 0.01);
  }

  // Eq.8 — Stage hold time [seconds]
  // Time for foam front to travel Δh ft at average vsg
  function foamHoldTime(delta_h_ft, vsg_start, vsg_end, ftype) {
    var vsg_avg = (vsg_start + vsg_end) / 2;
    var fm      = FOAM[ftype] || FOAM.anionic;
    return vsg_avg > 0 ? delta_h_ft * fm.Gs / vsg_avg : Infinity;
  }

  // ── SESSION C: Modified Fluid Properties (Equations 9–14) ────────────────

  // Eq.6+9 — Effective density [lb/ft³]
  function foamDensity(Gamma, rhoL, rhoG) {
    var G = Math.max(0, Math.min(1, Gamma));
    return (1 - G) * rhoL + G * rhoG;
  }

  // Eq.10 — Effective viscosity for SLIP velocity / Hirasaki-Lawson (Blauer 1974 fit)
  // μ_foam/μL = 1 + 2.5Γ + 7.5Γ²
  //   Γ=0:    1.00×  (pure liquid)
  //   Γ=0.36: 1.87×  (at percolation threshold)
  //   Γ=0.65: 5.79×  (anionic Γ_s — ~6× more viscous than liquid at bubble scale)
  //
  // NOTE: this is the bubble-scale (film) viscosity used in drift-flux Vd correction.
  // It is NOT the bulk rheological viscosity measured by a rheometer (see foamViscosityBulk).
  function foamViscosity(Gamma, muL) {
    var G = Math.max(0, Math.min(0.99, Gamma));
    return muL * (1 + 2.5 * G + 7.5 * G * G);
  }

  // Lab-calibrated bulk (rheological) foam viscosity for FRICTION PRESSURE GRADIENT [cP].
  // Source: Fig.7 — N₂ foam rheometer at 250°F / 1500 psi, Γ ≈ 65%.
  // Regression: μ = 77.3 − 0.0846 × γ̇  [cP, γ̇ in 1/s]
  //
  // This is distinct from foamViscosity() (slip velocity, bubble-scale).
  // The rheometer measures the resistance of the polyhedral foam structure to bulk shear
  // (~300× water), while the slip-velocity viscosity is the liquid film viscosity (~6×).
  // Use this value as muL when computing the Darcy/friction component of the pressure
  // gradient in grayCorrelation — pass as muL_friction in baseProps.
  //
  // Returns null if no lab data available for ftype (caller should fall back to foamViscosity).
  function foamViscosityBulk(Gamma, ftype, gamma_dot_s) {
    var fm = FOAM[ftype] || FOAM.anionic;
    if (!fm.mu0_bulk) return null;                        // no lab data for this type
    var G   = Math.max(0, Math.min(1, Gamma));
    var gd  = Math.max(0, gamma_dot_s || 0);
    var mu  = fm.mu0_bulk - fm.mu_slope * gd;
    // Blend toward base value below percolation threshold (no foam network yet)
    var w   = Math.max(0, Math.min(1, (G - GAMMA_C) / Math.max(0.01, (fm.Gs || 0.65) - GAMMA_C)));
    return Math.max(1.0, w * mu);                         // floor at 1 cP
  }

  // Eqs.11–13 — Modified drift-flux coefficients
  // C0_foam = 1.0 + 0.2·(1−Γ)    [plug-like at high quality, approaches 1.0]
  // Vd_foam = Vd_liquid·(1−Γ)²·(μL/μ_foam)^(1/3) [hindered bubble rise]
  // Blend linearly from standard values between Γ_c and Γ_s
  function foamDriftFlux(Gamma, Vd_liquid, ftype) {
    var fm  = FOAM[ftype] || FOAM.anionic;
    var G   = Math.max(0, Math.min(fm.Gs, Gamma));
    var w   = Math.max(0, Math.min(1, (G - GAMMA_C) / Math.max(0.01, fm.Gs - GAMMA_C)));
    var C0std = 1.20;          // standard bubble value (matches model.js grayCorrelation)
    var C0fm  = 1.0 + 0.2 * (1 - G);
    var muRatio = 1 / Math.max(0.01, 1 + 2.5 * G + 7.5 * G * G);  // μL/μ_foam
    var VdFm  = Vd_liquid * Math.pow(1 - G, 2) * Math.pow(muRatio, 1 / 3);
    return {
      C0: (1 - w) * C0std + w * C0fm,
      Vd: (1 - w) * Vd_liquid + w * VdFm,
    };
  }

  // Eq.14 — Turner velocity in foam zone [ft/s]
  // Uses foam effective density instead of liquid density.
  // σ_foam already reduced by surfactant (from liquidProps / _sigFoam).
  function foamTurner(Gamma, rhoL, rhoG, sig_foam) {
    var rhoEff = foamDensity(Gamma, rhoL, rhoG);
    var dRho   = Math.max(0.1, rhoEff - rhoG);
    return 5.62 * Math.pow(sig_foam * dRho / Math.max(0.01, rhoG * rhoG), 0.25);
  }

  // Session C integration wrapper: modify base props for a foam cell.
  // Called per cell in model.js step() between liquidProps() and grayCorrelation().
  //
  // baseProps  — output of liquidProps(p): {rL, muL, sig, ftype, ...}
  //              Optional: {vsg, D_ft} for shear-rate-dependent friction viscosity.
  // Gamma      — current cell foam quality [0, Γ_s]
  // rhoG_cell  — gas density in this cell [lb/ft³]
  //
  // Returns modified props with two distinct viscosity paths:
  //   muL          — slip-velocity viscosity (Hirasaki-Lawson, ~6× muL at Γ_s)
  //   muL_friction — bulk rheological viscosity (lab data, ~300× muL at Γ_s)
  // The caller (model.js grayCorrelation) should use muL_friction for friction
  // pressure gradient and the Vd_fraction/C0_override for drift-flux slip.
  function foamModifyProps(baseProps, Gamma, rhoG_cell) {
    if (!Gamma || Gamma <= 0.001) return baseProps;
    var ftype = baseProps.ftype || 'anionic';
    var fm    = FOAM[ftype] || FOAM.anionic;
    var G     = Math.min(fm.Gs, Gamma);
    var w     = Math.max(0, Math.min(1, (G - GAMMA_C) / Math.max(0.01, fm.Gs - GAMMA_C)));

    // Session C Eq.6+9: effective density
    var rhoEff = foamDensity(G, baseProps.rL, rhoG_cell);

    // Session C Eq.10: slip-velocity viscosity (Hirasaki-Lawson, bubble-scale)
    var muEff  = foamViscosity(G, baseProps.muL);

    // Lab-calibrated bulk friction viscosity (Fig.7 rheometer data).
    // Shear rate estimated from vsg and tubing diameter if available.
    var gamma_dot = 100;  // default 100 1/s if geometry unknown
    if (baseProps.vsg != null && baseProps.D_ft) {
      gamma_dot = Math.max(1, 8 * baseProps.vsg / Math.max(baseProps.D_ft, 0.01));
    }
    var muBulk = foamViscosityBulk(G, ftype, gamma_dot);

    // Session C Eqs.11–13: drift-flux — Vd_liquid from Harmathy formula
    var dRho_liq = Math.max(0.1, baseProps.rL - rhoG_cell);
    var Vd_liq   = 1.53 * Math.pow(
      G_SI * baseProps.sig * 1e-3 * dRho_liq * 16.018 /
      Math.max(0.01, Math.pow(baseProps.rL * 16.018, 2)), 0.25) / FT2M;
    var df     = foamDriftFlux(G, Vd_liq, ftype);

    return Object.assign({}, baseProps, {
      rL:           rhoEff,                                // density for hydrostatic + Gray
      muL:          muEff,                                 // slip-velocity viscosity
      muL_friction: muBulk != null ? muBulk : muEff,      // friction gradient viscosity
      C0_override:  df.C0,
      Vd_fraction:  df.Vd / Math.max(Vd_liq, 1e-9),
      Gamma:        G,
    });
  }

  // ── SESSION D: Open-Up Simulation (Equations 15–20) ──────────────────────

  // Single timestep of the foam open-up simulation.
  // state  — { WHP [psi], h_front [ft], t [s] }
  // fp     — foam params from _buildFP()
  // dt_s   — timestep in seconds
  // Returns { state: new_state, d: diagnostics }
  function openUpStep(state, fp, dt_s) {
    var WHP     = state.WHP;
    var h_front = state.h_front;

    // ── Eq.15: forward model ─────────────────────────────────────────────
    var op      = _forward(WHP, h_front, fp);

    // ── Session A checks on current vsg ──────────────────────────────────
    var vperc   = percolationThreshold(fp.sigFoam, fp.rhoL, op.rhoG, fp.ftype);
    var vch     = channelingCeiling(fp.id_in / 12, fp.rhoL, op.rhoG, fp.ftype);

    // ── Verdict ───────────────────────────────────────────────────────────
    var verdict;
    if      (h_front >= fp.H_liq)    verdict = 'unloaded';
    else if (op.vsg > vch)           verdict = 'channeling';
    else if (op.vsg < vperc)         verdict = 'below_threshold';
    else                             verdict = 'foaming';

    // ── Eq.17: adaptive target vsg ────────────────────────────────────────
    var phi     = Math.max(0, Math.min(1, h_front / Math.max(1, fp.H_liq)));
    var vsg_tgt = _vsgTarget(phi, vperc, vch);

    // ── Eq.20: restriction trigger ────────────────────────────────────────
    var WHP_next;
    if (op.vsg > 0.88 * vch) {
      // Above 88% of channeling ceiling — raise WHP (restrict choke)
      WHP_next = _solveWHP(0.80 * vch, h_front, fp);
      WHP_next = Math.max(WHP, WHP_next);
    } else {
      WHP_next = _solveWHP(vsg_tgt, h_front, fp);
      WHP_next = Math.max(fp.Psep, Math.min(fp.SIWHP, WHP_next));
    }

    // ── State advance ─────────────────────────────────────────────────────
    var h_new = Math.min(fp.H_liq, h_front + op.v_front * dt_s);

    return {
      state: { WHP: WHP_next, h_front: h_new, t: state.t + dt_s },
      d: {
        BHP: op.BHP, q: op.q, vsg: op.vsg,
        vsg_perc: vperc, vsg_ch: vch, vsg_tgt: vsg_tgt,
        v_front: op.v_front, phi: phi, verdict: verdict,
        WHP_next: WHP_next,
      },
    };
  }

  // Full open-up choke sequence (Session D main deliverable).
  // p_or_fp — well params object p, or pre-built fp from _buildFP
  // Returns { success, stages, ... } — see header comment for schema
  function chokeSequence(p_or_fp, A_F, B_F) {
    var fp = (p_or_fp.Apipe && p_or_fp.Pr) ? p_or_fp : _buildFP(p_or_fp, A_F, B_F);

    // ── Pre-check (Session A, Eq.16 feasibility) ─────────────────────────
    var op0    = _forward(fp.Psep, 0, fp);
    var vp0    = percolationThreshold(fp.sigFoam, fp.rhoL, op0.rhoG, fp.ftype);
    var vch0   = channelingCeiling(fp.id_in / 12, fp.rhoL, op0.rhoG, fp.ftype);
    var margin = vp0 > 0 ? (op0.vsg - vp0) / vp0 * 100 : -999;

    if (op0.vsg < vp0) {
      return {
        success:        false,
        reason:         'below_threshold_at_max_drawdown',
        vsg_max_fts:    +op0.vsg.toFixed(4),
        vsg_perc_fts:   +vp0.toFixed(4),
        vsg_ch_fts:     +vch0.toFixed(4),
        margin_pct:     +margin.toFixed(1),
        dP_available:   fp.SIWHP - fp.Psep,
        Psep_min_psi:   +_minPsep(fp).toFixed(0),
        Pr_psi:         +fp.Pr.toFixed(0),
        H_liq_ft:       fp.H_liq,
      };
    }

    // ── Forward simulation ────────────────────────────────────────────────
    var DT      = 60;               // 60-second timestep
    var TIMEOUT = 72 * 3600;        // 72-hour hard stop

    // Compute first WHP from Session D Eq.17 adaptive target at φ=0,
    // so Stage 1 is logged with the correct operating vsg (not zero drawdown).
    var vp_i    = percolationThreshold(fp.sigFoam, fp.rhoL, op0.rhoG, fp.ftype);
    var vc_i    = channelingCeiling(fp.id_in / 12, fp.rhoL, op0.rhoG, fp.ftype);
    var vt_i    = _vsgTarget(0, vp_i, vc_i);
    var WHP0    = _solveWHP(vt_i, 0, fp);

    var state   = { WHP: WHP0, h_front: 0, t: 0 };
    var stages  = [];
    var prev_WHP = WHP0;
    var stg_n   = 1;
    var stg_h0  = 0, stg_t0 = 0;
    var last_d  = null;

    while (state.h_front < fp.H_liq && state.t < TIMEOUT) {
      var step  = openUpStep(state, fp, DT);
      var d     = step.d;
      var s1    = step.state;
      last_d    = d;

      // ── Eq.19: stage completion — WHP shifted > 15 psi or column unloaded ──
      var ΔWHP = Math.abs(s1.WHP - prev_WHP);
      if (ΔWHP > 15 || s1.h_front >= fp.H_liq) {
        var Zwh  = _calcZ(Math.max(50, prev_WHP), fp.TsurfR, fp.sg);
        var ck64 = _chokeN64(d.q, Math.max(50, prev_WHP), fp.TsurfR - 459.67, Zwh, fp.sg);
        stages.push({
          stage:        stg_n++,
          WHP_psi:      Math.round(prev_WHP),
          choke_64:     ck64,
          q_Mscfd:      +d.q.toFixed(1),
          vsg_fts:      +d.vsg.toFixed(3),
          vsg_perc_fts: +d.vsg_perc.toFixed(3),
          vsg_ch_fts:   +d.vsg_ch.toFixed(3),
          margin_pct:   +((d.vsg - d.vsg_perc) / Math.max(d.vsg_perc, 0.01) * 100).toFixed(1),
          BHP_psi:      +d.BHP.toFixed(0),
          h_start_ft:   Math.round(stg_h0),
          h_end_ft:     Math.round(s1.h_front),
          t_start_min:  +(stg_t0 / 60).toFixed(1),
          t_end_min:    +(s1.t / 60).toFixed(1),
          t_hold_min:   +((s1.t - stg_t0) / 60).toFixed(1),
          restricting:  s1.WHP > prev_WHP + 15,   // choke raised = restriction
        });
        stg_h0   = s1.h_front;
        stg_t0   = s1.t;
        prev_WHP = s1.WHP;
      }

      if (d.verdict === 'unloaded') { state = s1; break; }
      state = s1;
    }

    // ── Post-treatment flowing state ──────────────────────────────────────
    var op_f   = _forward(state.WHP, fp.H_liq, fp);
    var Vliq   = fp.Apipe * fp.H_liq / BBL2FT3;
    var Vneat  = Vliq * 42 * (fp.rhoL / 62.4) * fp.conc / (8.5 / 7.48);
    var rst_stg = null;
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].restricting) { rst_stg = stages[i].stage; break; }
    }

    return {
      success:           true,
      stages:            stages,
      total_time_min:    +(state.t / 60).toFixed(0),
      final_WHP_psi:     Math.round(state.WHP),
      final_choke_64:    _chokeN64(op_f.q, Math.max(50, state.WHP),
                           fp.TsurfR - 459.67, _calcZ(state.WHP, fp.TsurfR, fp.sg), fp.sg),
      final_q_Mscfd:     +op_f.q.toFixed(1),
      final_vsg_fts:     +op_f.vsg.toFixed(3),
      final_BHP_psi:     +op_f.BHP.toFixed(0),
      restriction_stage: rst_stg,
      Vliq_bbl:          +Vliq.toFixed(1),
      Vneat_gal:         +Vneat.toFixed(1),
      Vrec_gal:          +(Vneat * 1.30).toFixed(1),
      Pr_psi:            +fp.Pr.toFixed(0),
      SIWHP_psi:         +fp.SIWHP.toFixed(0),
      dP_available:      fp.SIWHP - fp.Psep,
    };
  }

  // ── Extended foam recommendation ──────────────────────────────────────────
  // Wraps chokeSequence and adds contact-time and surfactant-volume estimates.
  // Designed to replace/extend foamRecommendation() in model.js for Phase 4.
  function foamRecommendation(p, A_F, B_F) {
    var fp  = _buildFP(p, A_F, B_F);
    var seq = chokeSequence(fp);

    // Contact time: allow surfactant to distribute through liquid column.
    // Rough estimate: diffusion + natural percolation at reservoir ΔP.
    // Min 45 min; scale with H_liq.
    var contact_min = Math.max(45, Math.round(fp.H_liq / 200));

    // Turner velocity before and after (for comparison with existing display)
    var op0      = _forward(fp.Psep, 0, fp);
    var vT_before = 5.62 * Math.pow(
      fp.sigBase * Math.max(0.1, fp.rhoL - op0.rhoG) /
      Math.max(0.01, op0.rhoG * op0.rhoG), 0.25);
    var vT_after  = foamTurner(fp.Gs, fp.rhoL, op0.rhoG, fp.sigFoam);

    return Object.assign({}, seq, {
      // Foam properties summary
      ftype:          fp.ftype,
      conc_wt_pct:    fp.conc,
      sig_base:       +fp.sigBase.toFixed(1),
      sig_foam:       +fp.sigFoam.toFixed(1),
      Gamma_s:        fp.Gs,
      vT_before_fts:  +vT_before.toFixed(3),
      vT_after_fts:   +vT_after.toFixed(3),

      // Operational
      contact_time_min: contact_min,

      // Session A thresholds at initial conditions
      vsg_perc_fts:   +percolationThreshold(fp.sigFoam, fp.rhoL, op0.rhoG, fp.ftype).toFixed(4),
      vsg_ch_fts:     +channelingCeiling(fp.id_in / 12, fp.rhoL, op0.rhoG, fp.ftype).toFixed(3),
    });
  }

  // ── MANUAL SIMULATION API ────────────────────────────────────────────────
  //
  // Usage pattern:
  //   var fp    = WM.foam.buildFoamParams(p, A_F, B_F);   // once
  //   var state = WM.foam.initialState(fp);               // starting point
  //   var r     = WM.foam.manualStep(900, state, fp);     // operator sets WHP
  //   // inspect r.diagnostics, r.advice
  //   state = r.state;
  //   var r2    = WM.foam.manualStep(780, state, fp);     // open more
  // ─────────────────────────────────────────────────────────────────────────

  // Expose _buildFP publicly so manual simulations can construct fp once
  // and pass it to initialState / manualStep without rebuilding each call.
  function buildFoamParams(p, A_F, B_F) {
    return _buildFP(p, A_F, B_F);
  }

  // Return the correct opening state for a manual simulation session.
  // h_front = 0 (full liquid column).
  // WHP is pre-set to the first-stage target from Eq.17 at φ=0 — so the
  // very first manualStep call shows foam-window conditions, not zero drawdown.
  function initialState(fp) {
    var op0  = _forward(fp.Psep, 0, fp);
    var vp0  = percolationThreshold(fp.sigFoam, fp.rhoL, op0.rhoG, fp.ftype);
    var vc0  = channelingCeiling(fp.id_in / 12, fp.rhoL, op0.rhoG, fp.ftype);
    var vtgt = _vsgTarget(0, vp0, vc0);
    return {
      WHP:     _solveWHP(vtgt, 0, fp),  // first-stage WHP (not SIWHP)
      h_front: 0,
      t:       0,
    };
  }

  // Single manual timestep — operator supplies WHP, module reports and advises.
  // Unlike openUpStep, this does NOT override WHP via the adaptive algorithm.
  // The operator remains in control; the module provides diagnostic feedback.
  //
  // WHP   [psi]  : wellhead pressure chosen by operator
  // state        : { WHP, h_front, t } from initialState() or previous manualStep()
  // fp           : from buildFoamParams()
  // dt_s  [s]   : time to advance; default 1800 s (30 min) — typical hold interval
  //
  // Returns:
  //   state        — new state after dt_s; pass to next manualStep call
  //   diagnostics  — full picture of what is happening at this WHP
  //   advice       — one of: 'open_more' | 'hold' | 'restrict' | 'complete'
  //
  // Advice semantics (actionable — tells operator what to do next):
  //   'open_more'  : vsg < vsg_perc — foam not forming, reduce WHP (more drawdown)
  //   'hold'       : vsg in foam window — foam developing, stay here
  //   'restrict'   : vsg > 85% of vsg_channel — raise WHP before channeling
  //   'complete'   : foam front has reached top of liquid — column unloaded
  function manualStep(WHP, state, fp, dt_s) {
    dt_s = (dt_s != null) ? dt_s : 1800;
    WHP  = Math.max(fp.Psep, Math.min(fp.SIWHP, WHP));

    // ── Forward model at operator-supplied WHP (Eq.15) ──────────────────
    var op     = _forward(WHP, state.h_front, fp);

    // ── Session A thresholds at current bottomhole conditions ────────────
    var vperc  = percolationThreshold(fp.sigFoam, fp.rhoL, op.rhoG, fp.ftype);
    var vch    = channelingCeiling(fp.id_in / 12, fp.rhoL, op.rhoG, fp.ftype);
    var margin = vperc > 0 ? (op.vsg - vperc) / vperc * 100 : 0;
    var phi    = Math.max(0, Math.min(1, state.h_front / Math.max(1, fp.H_liq)));

    // ── Verdict: what is happening now ───────────────────────────────────
    var verdict;
    if      (state.h_front >= fp.H_liq) verdict = 'unloaded';
    else if (op.vsg > vch)              verdict = 'channeling';
    else if (op.vsg < vperc)            verdict = 'below_threshold';
    else                                verdict = 'foaming';

    // ── Foam front advance ────────────────────────────────────────────────
    // Front only moves when gas is percolating in the foam window.
    // Outside the window (too slow or channeling) the front is stationary.
    var foam_active = (op.vsg >= vperc) && (op.vsg <= vch);
    var h_new       = foam_active
      ? Math.min(fp.H_liq, state.h_front + op.v_front * dt_s)
      : state.h_front;

    // ── Advice: what to do next ───────────────────────────────────────────
    var advice;
    if      (h_new >= fp.H_liq)   advice = 'complete';
    else if (op.vsg > vch * 0.85) advice = 'restrict';
    else if (op.vsg < vperc)      advice = 'open_more';
    else                          advice = 'hold';

    // Optimal WHP for reference — what the automated algorithm would select
    var WHP_opt = _solveWHP(_vsgTarget(phi, vperc, vch), state.h_front, fp);

    return {
      state: {
        WHP:     WHP,
        h_front: h_new,
        t:       state.t + dt_s,
      },
      diagnostics: {
        BHP_psi:         +op.BHP.toFixed(0),
        q_Mscfd:         +op.q.toFixed(1),
        vsg_fts:         +op.vsg.toFixed(4),
        vsg_perc_fts:    +vperc.toFixed(4),
        vsg_ch_fts:      +vch.toFixed(3),
        margin_pct:      +margin.toFixed(1),
        v_front_fts:     +op.v_front.toFixed(4),
        h_front_ft:      +h_new.toFixed(0),
        foam_pct:        +(h_new / Math.max(1, fp.H_liq) * 100).toFixed(1),
        t_hr:            +((state.t + dt_s) / 3600).toFixed(2),
        verdict:         verdict,
        WHP_optimal_psi: +WHP_opt.toFixed(0),
        foam_active:     foam_active,
      },
      advice: advice,
    };
  }

  // ── Expose on WM namespace (same pattern as units.js) ────────────────────
  root.WM = root.WM || {};
  var _foam_api = {
    // Session A
    percolationThreshold:  percolationThreshold,
    channelingCeiling:     channelingCeiling,
    // Session B
    foamQualityStep:       foamQualityStep,
    foamFrontVelocity:     foamFrontVelocity,
    foamHoldTime:          foamHoldTime,
    // Session C
    foamDensity:           foamDensity,
    foamViscosity:         foamViscosity,
    foamViscosityBulk:     foamViscosityBulk,
    foamDriftFlux:         foamDriftFlux,
    foamTurner:            foamTurner,
    foamModifyProps:       foamModifyProps,
    // Session D
    openUpStep:            openUpStep,
    chokeSequence:         chokeSequence,
    // Manual simulation
    buildFoamParams:       buildFoamParams,
    initialState:          initialState,
    manualStep:            manualStep,
    // Recommendation wrapper
    foamRecommendation:    foamRecommendation,
    // Constants (exposed for test_foam.js)
    FOAM:                  FOAM,
    GAMMA_C:               GAMMA_C,
  };
  root.WM.foam = _foam_api;
  // Backup: model.js replaces window.WM entirely on load.
  // Storing here lets model.js re-attach foam after its WM assignment.
  root._wm_foam = _foam_api;

})(typeof window !== 'undefined' ? window : globalThis);
