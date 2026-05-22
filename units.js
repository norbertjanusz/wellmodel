// wellmodel.app — units.js
// ──────────────────────────────────────────────────────────────────────
// Unit conversion layer between Imperial (engine internal) and SI (display).
//
// Design: model.js is unchanged.  All physics happens in Imperial.  This
// module provides:
//   1. WM.units.toSI(value, kind)        → for displays
//   2. WM.units.fromSI(value, kind)      → for slider inputs
//   3. WM.units.label(kind)              → unit suffix string
//   4. WM.units.system  ∈ {'imperial','si'}  ← global toggle state
//   5. WM.units.set(system)              → flip the toggle, fires onChange
//   6. WM.units.onChange(fn)             → register listener
//
// Integration (in app.js):
//   - On every render, wrap displayed values with toSI(...)
//   - On every slider input, run fromSI(...) before assigning to p.*
//   - Add a button/toggle that calls WM.units.set('si' | 'imperial')
//   - Subscribe to onChange to re-render labels
//
// "kind" values cover everything the UI displays:
//   'pressure'   psi  ↔  bar          (1 bar = 14.5038 psi)
//   'depth'      ft   ↔  m            (1 m = 3.2808 ft)
//   'tubingID'   in   ↔  mm           (1 in = 25.4 mm)
//   'gasRate'    MMscfd ↔ 10³ Sm³/d   (1 MMscfd ≈ 28.317 ×10³ Sm³/d)
//   'liqRate'    bpd  ↔  m³/d         (1 m³/d ≈ 6.290 bpd)
//   'inventory'  bbl  ↔  m³           (1 m³ ≈ 6.290 bbl)
//   'wgr'        bbl/MMscf ↔ m³/10³Sm³  (see notes)
//   'cgr'        bbl/MMscf ↔ m³/10³Sm³
//   'density'    lb/ft³ ↔ kg/m³        (1 kg/m³ ≈ 0.0624 lb/ft³)
//   'viscosity'  cp   ↔  cp            (no change)
//   'tension'    dyn/cm ↔ mN/m          (no change — same unit)
//   'temperature' °F  ↔  °C            (offset + scale)
//   'salinity'   kppm ↔ kppm           (no change — mass fraction)
//   'permeability' mD ↔  mD             (no change — common in SI usage)
//   'porosity'   frac ↔ frac            (no change)
//   'A_F'        psi²/Mscfd ↔ bar²/(10³Sm³/d)
//   'B_F'        psi²/Mscfd² ↔ bar²/(10³Sm³/d)²
//
// Notes on rates and ratios:
//   Standard m³ (Sm³) is at 15°C / 1.01325 bar.  Standard cf (scf) is at
//   60°F / 14.696 psia.  Conversion factor between standard volumes:
//     1 scf at 60°F/14.696psia ≈ 0.02832 Sm³ at 15°C/1.01325bar
//   So 1 MMscfd ≈ 28.32 ×10³ Sm³/d.
//
//   Liquid: 1 bbl = 0.158987 m³, so 1 bpd = 0.158987 m³/d.
//
//   GLR/WGR/CGR ratios:
//     1 bbl/MMscf = 0.158987 m³ / 28316.8 Sm³ = 5.6146 m³ / 10³Sm³
//     i.e. multiply bbl/MMscf by 5.6146 to get m³/10³Sm³
//
// ──────────────────────────────────────────────────────────────────────

(function (root) {
  // Conversion factors: Imperial → SI (multiply Imperial value by factor)
  // Pressure handled explicitly because of bar
  var TO_SI = {
    pressure:   0.0689476,         // psi  → bar
    depth:      0.3048,            // ft   → m
    tubingID:   25.4,              // in   → mm
    gasRate:    28.31685,          // MMscfd → 10³ Sm³/d  (×10³ implied in the unit)
    liqRate:    0.158987,          // bpd  → m³/d
    inventory:  0.158987,          // bbl  → m³
    wgr:        5.61458,           // bbl/MMscf → m³/(10³ Sm³)
    cgr:        5.61458,           // bbl/MMscf → m³/(10³ Sm³)
    density:    16.0185,           // lb/ft³ → kg/m³
    viscosity:  1.0,               // cp ↔ cp
    tension:    1.0,               // dyn/cm ≡ mN/m
    salinity:   1.0,               // kppm ≡ kppm
    permeability: 1.0,             // mD ≡ mD
    porosity:   1.0,               // dimensionless
    // A and B IPR coefficients require special handling — not pure scalar
    // Pr² is in psi², q is in MMscfd.  In SI: bar² and (10³Sm³/d).
    //   A_SI = A_imp × (bar/psi)² / ((10³Sm³/d) / MMscfd)
    //        = A_imp × 0.0689476² / 28.31685
    //        = A_imp × 1.6786e-4
    A_F:        1.6786e-4,         // psi²/MMscfd → bar²/(10³Sm³/d)
    //   B_SI = B_imp × (bar/psi)² / ((10³Sm³/d) / MMscfd)²
    //        = B_imp × 0.0689476² / 28.31685²
    //        = B_imp × 5.929e-6
    B_F:        5.929e-6,          // psi²/MMscfd² → bar²/(10³Sm³/d)²
    // UI variants — sliders display A in psi²/Mscfd, B in psi²/Mscfd²
    //   A in psi²/Mscfd → bar²/(10³ Sm³/d):
    //     × (bar/psi)² × (Mscfd / (10³ Sm³/d)) = 0.0689476² × (1/28.31685×1000)
    //     × 0.0689476² / 0.02832 = 0.1678
    A_F_Mscfd:  0.1678,            // psi²/Mscfd → bar²/(10³ Sm³/d)
    //   B in psi²/Mscfd² → bar²/(10³ Sm³/d)²:
    //     × 0.0689476² / 0.02832² = 5.929
    B_F_Mscfd:  5.929              // psi²/Mscfd² → bar²/(10³ Sm³/d)²
  };

  var LABEL_IMP = {
    pressure:    'psi',
    depth:       'ft',
    tubingID:    'in',
    gasRate:     'MMscfd',
    liqRate:     'bpd',
    inventory:   'bbl',
    wgr:         'bbl/MMscf',
    cgr:         'bbl/MMscf',
    density:     'lb/ft³',
    viscosity:   'cp',
    tension:     'dyn/cm',
    temperature: '°F',
    salinity:    'kppm',
    permeability: 'mD',
    porosity:    'frac',
    A_F:         'psi²/Mscfd',
    B_F:         'psi²/Mscfd²',
    A_F_Mscfd:   'psi²/Mscfd',
    B_F_Mscfd:   'psi²/Mscfd²'
  };

  var LABEL_SI = {
    pressure:    'bar',
    depth:       'm',
    tubingID:    'mm',
    gasRate:     '10³ Sm³/d',
    liqRate:     'm³/d',
    inventory:   'm³',
    wgr:         'm³/10³Sm³',
    cgr:         'm³/10³Sm³',
    density:     'kg/m³',
    viscosity:   'cP',
    tension:     'mN/m',
    temperature: '°C',
    salinity:    'kppm',
    permeability: 'mD',
    porosity:    'frac',
    A_F:         'bar²/(10³Sm³/d)',
    B_F:         'bar²/(10³Sm³/d)²',
    A_F_Mscfd:   'bar²/(10³Sm³/d)',
    B_F_Mscfd:   'bar²/(10³Sm³/d)²'
  };

  var listeners = [];
  var system = (function () {
    try {
      var saved = (typeof localStorage !== 'undefined') && localStorage.getItem('wm_unit_system');
      return saved === 'si' ? 'si' : 'imperial';
    } catch (e) { return 'imperial'; }
  })();

  function toSI(val, kind) {
    if (val === null || val === undefined || isNaN(val)) return val;
    if (kind === 'temperature') return (val - 32) * 5 / 9;
    var f = TO_SI[kind];
    return f === undefined ? val : val * f;
  }

  function fromSI(val, kind) {
    if (val === null || val === undefined || isNaN(val)) return val;
    if (kind === 'temperature') return val * 9 / 5 + 32;
    var f = TO_SI[kind];
    return f === undefined ? val : val / f;
  }

  // High-level helpers: format value with unit, applying current display system.
  function display(val, kind, decimals) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    var v = (system === 'si') ? toSI(val, kind) : val;
    var d = decimals === undefined ? defaultDecimals(kind, v) : decimals;
    var label = (system === 'si') ? LABEL_SI[kind] : LABEL_IMP[kind];
    return v.toFixed(d) + (label ? ' ' + label : '');
  }

  // Reverse: take a UI-input value (in current system) and return Imperial
  // for direct assignment to engine parameters.
  function userToImperial(val, kind) {
    return (system === 'si') ? fromSI(val, kind) : val;
  }

  // Forward: take an Imperial engine value and return what the UI shows.
  function engineToUser(val, kind) {
    return (system === 'si') ? toSI(val, kind) : val;
  }

  function label(kind) {
    return (system === 'si') ? LABEL_SI[kind] : LABEL_IMP[kind];
  }

  function defaultDecimals(kind, val) {
    // Sensible decimal places for typical magnitudes
    switch (kind) {
      case 'pressure':    return Math.abs(val) >= 100 ? 0 : 1;
      case 'depth':       return 0;
      case 'tubingID':    return system === 'si' ? 1 : 2;
      case 'gasRate':     return Math.abs(val) >= 10 ? 1 : 2;
      case 'liqRate':     return 0;
      case 'inventory':   return 1;
      case 'wgr':         return 0;
      case 'cgr':         return 0;
      case 'density':     return 1;
      case 'viscosity':   return 2;
      case 'tension':     return 1;
      case 'temperature': return 0;
      case 'salinity':    return 0;
      case 'permeability':return 1;
      case 'porosity':    return 3;
      case 'A_F':         return system === 'si' ? 3 : 0;
      case 'B_F':         return system === 'si' ? 6 : 3;
      default:            return 2;
    }
  }

  function set(newSystem) {
    if (newSystem !== 'si' && newSystem !== 'imperial') return;
    if (system === newSystem) return;
    system = newSystem;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('wm_unit_system', system);
      }
    } catch (e) {}
    listeners.forEach(function (fn) { try { fn(system); } catch (e) {} });
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function get() { return system; }

  // Expose
  root.WM = root.WM || {};
  root.WM.units = {
    toSI: toSI,
    fromSI: fromSI,
    display: display,
    userToImperial: userToImperial,
    engineToUser: engineToUser,
    label: label,
    set: set,
    get: get,
    onChange: onChange,
    LABEL_IMP: LABEL_IMP,
    LABEL_SI: LABEL_SI
  };
  // Backwards-compatible alias
  Object.defineProperty(root.WM.units, 'system', {
    get: function () { return system; }
  });
})(typeof window !== 'undefined' ? window : globalThis);
