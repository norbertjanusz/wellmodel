// =======================================================
// WELLMODEL.APP — MAIN APPLICATION
// React state machine, animation loop, UI layout
// Depends on: WM (model.js), WM_Draw (draw.js), WM_Charts (charts.js)
// =======================================================

var useState = React.useState;
var useMemo = React.useMemo;
var useRef = React.useRef;
var useEffect = React.useEffect;

var M = window.WM;           // Physics engine
// ── Viewport meta tag — required for mobile layout; inject if missing ────────
(function() {
  if (!document.querySelector('meta[name="viewport"]')) {
    var vm = document.createElement('meta');
    vm.name = 'viewport';
    vm.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(vm);
  }
}());
// ── Mobile scroll unlock — inject <style> tag so it wins over !important in styles.css ──
(function() {
  if (Math.min(screen.width, screen.height) < 768) {
    var s = document.createElement('style');
    s.id = 'wm-mob';
    s.textContent = 'html,body,#root{overflow-x:hidden!important;overflow-y:auto!important;height:auto!important;}';
    document.head.appendChild(s);
  }
}());
var D = window.WM_Draw;      // Canvas drawing
var C = window.WM_Charts;    // Chart components
var FN = C.FN;               // Font constant

// =======================================================
// SCENARIO PRESETS
// =======================================================
var SCENARIOS = {
  'custom': { label: 'Custom', desc: 'Manual input' },
  'stable': { label: 'Stable Gas Well', desc: 'Normal producing well, flowing above Turner',
    v: { TD: 9000, Pr: 4500, T_surf: 85, geo_grad: 1.8, wgr: 5, cgr: 5, id_in: 2.441, sg: 0.65, choke_64: 32, P_sep: 250, A_F: 300000, B_F: 30000, k_md: 10, phi: 0.15, r_e: 1000, P_dew: 1500, skin: 0, h_net: 50,salinity: 10000 } },
  'marginal': { label: 'Marginal (Near Turner)', desc: 'Gas velocity near critical - watch it load',
    v: { TD: 10000, Pr: 2800, T_surf: 90, geo_grad: 1.6, wgr: 80, cgr: 25, id_in: 2.992, sg: 0.68, choke_64: 28, P_sep: 250, A_F: 600000, B_F: 80000, k_md: 5, phi: 0.12, r_e: 800, P_dew: 2000, skin: 3, h_net: 50,salinity: 50000 } },
  'loading': { label: 'Loading (Drowning)', desc: 'High WGR, small choke - well will die',
    v: { TD: 12000, Pr: 8000, T_surf: 85, geo_grad: 1.8, wgr: 400, cgr: 155, id_in: 3.6, sg: 0.65, choke_64: 22, P_sep: 250, A_F: 1500000, B_F: 100000, k_md: 5, phi: 0.15, r_e: 1000, P_dew: 5200, skin: 5, h_net: 50, salinity: 80000 } },
  'condensate': { label: 'Rich Gas Condensate', desc: 'High CGR, wet gas SG effects',
    v: { TD: 11000, Pr: 5500, T_surf: 95, geo_grad: 2.0, wgr: 30, cgr: 180, id_in: 3.5, sg: 0.72, choke_64: 36, P_sep: 300, A_F: 500000, B_F: 60000, k_md: 8, phi: 0.18, r_e: 1200, P_dew: 4800, skin: 2,h_net: 50, salinity: 15000 } },
  'highwater': { label: 'High Water Gas Well', desc: 'Depleting reservoir, rising WGR',
    v: { TD: 8000, Pr: 1800, T_surf: 80, geo_grad: 1.5, wgr: 350, cgr: 5, id_in: 2.441, sg: 0.62, choke_64: 24, P_sep: 200, A_F: 300000, B_F: 40000, k_md: 3, phi: 0.10, r_e: 600, P_dew: 800, skin: 8, h_net: 50, salinity: 150000 } },
};

var DEFS = { TD: 9000, Pr: 3200, T_surf: 85, geo_grad: 1.8, wgr: 20, cgr: 15, id_in: 2.992, sg: 0.65, choke_64: 32, P_sep: 250,
  iprMode: true, A_F: 800000, B_F: 100000, k_md: 5, phi: 0.15, r_e: 1000, P_dew: 2500, skin: 0, h_net: 50,
  vs_on: false, vs_id: 1.98, vs_depth: 6000, foam_rate: 0, foam_type: '', foam_Vliq0: 0,
  foam_efficiency: 70, foam_depth_ft: 0, foam_batch_active: false, foam_batch_conc: 0.10, turner_const: 5.62, salinity: 30000 };

// =======================================================
// UI WIDGET COMPONENTS
// =======================================================
// UNIT SYSTEM — toggle between Imperial (engine internal) and SI (display)
// =======================================================
// If units.js loaded successfully, window.WM.units is already populated.
// If not (e.g. file missing/404), define a minimal fallback inline so the
// toggle still works.  This way the user always gets a functional button
// regardless of deployment state.
(function () {
  if (window.WM && window.WM.units && typeof window.WM.units.set === 'function') return;

  var TO_SI = {
    pressure: 0.0689476, depth: 0.3048, tubingID: 25.4,
    gasRate: 28.31685, liqRate: 0.158987, inventory: 0.158987,
    wgr: 5.61458, cgr: 5.61458, density: 16.0185,
    viscosity: 1.0, tension: 1.0, salinity: 1.0, permeability: 1.0, porosity: 1.0,
    A_F: 1.6786e-4, B_F: 5.929e-6, A_F_Mscfd: 0.1678, B_F_Mscfd: 5.929
  };
  var L_IMP = { pressure:'psi', depth:'ft', tubingID:'in', gasRate:'MMscfd', liqRate:'bpd',
    inventory:'bbl', wgr:'bbl/MMscf', cgr:'bbl/MMscf', density:'lb/ft\u00B3',
    viscosity:'cp', tension:'dyn/cm', temperature:'\u00B0F', salinity:'kppm',
    permeability:'mD', porosity:'frac', A_F:'psi\u00B2/Mscfd', B_F:'psi\u00B2/Mscfd\u00B2',
    A_F_Mscfd:'psi\u00B2/Mscfd', B_F_Mscfd:'psi\u00B2/Mscfd\u00B2' };
  var L_SI  = { pressure:'bar', depth:'m', tubingID:'mm', gasRate:'10\u00B3 Sm\u00B3/d',
    liqRate:'m\u00B3/d', inventory:'m\u00B3', wgr:'m\u00B3/10\u00B3Sm\u00B3', cgr:'m\u00B3/10\u00B3Sm\u00B3',
    density:'kg/m\u00B3', viscosity:'cP', tension:'mN/m', temperature:'\u00B0C',
    salinity:'kppm', permeability:'mD', porosity:'frac',
    A_F:'bar\u00B2/(10\u00B3Sm\u00B3/d)', B_F:'bar\u00B2/(10\u00B3Sm\u00B3/d)\u00B2',
    A_F_Mscfd:'bar\u00B2/(10\u00B3Sm\u00B3/d)', B_F_Mscfd:'bar\u00B2/(10\u00B3Sm\u00B3/d)\u00B2' };
  var listeners = [];
  var sys = (function(){ try { return localStorage.getItem('wm_unit_system') === 'si' ? 'si' : 'imperial'; } catch(e){ return 'imperial'; } })();

  window.WM = window.WM || {};
  window.WM.units = {
    toSI: function(v, k) {
      if (v == null || isNaN(v)) return v;
      if (k === 'temperature') return (v - 32) * 5/9;
      var f = TO_SI[k]; return f === undefined ? v : v * f;
    },
    fromSI: function(v, k) {
      if (v == null || isNaN(v)) return v;
      if (k === 'temperature') return v * 9/5 + 32;
      var f = TO_SI[k]; return f === undefined ? v : v / f;
    },
    label: function(k) { return sys === 'si' ? (L_SI[k] || '') : (L_IMP[k] || ''); },
    get: function() { return sys; },
    set: function(s) {
      if (s !== 'si' && s !== 'imperial' || s === sys) return;
      sys = s;
      try { localStorage.setItem('wm_unit_system', sys); } catch(e){}
      listeners.forEach(function(fn){ try { fn(sys); } catch(e){} });
    },
    onChange: function(fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();

// Lazy access — re-read on every use so even a delayed-load units.js works.
function _U() { return (window.WM && window.WM.units) ? window.WM.units : null; }
function useUnitSys() {
  var U0 = _U();
  var _u = useState(U0 ? U0.get() : 'imperial'); var sys = _u[0], setSys = _u[1];
  useEffect(function () {
    var Ux = _U();
    if (!Ux) return;
    Ux.onChange(function (s) { setSys(s); });
  }, []);
  return sys;
}

function Sl(props) {
  var sys = useUnitSys();
  var U = _U();
  var c = props.color || '#f59e0b';
  var kind = props.kind;
  var inSI = (sys === 'si') && U && kind;
  var dispVal = inSI ? U.toSI(props.value, kind) : props.value;
  var dispMin = inSI ? U.toSI(props.min, kind) : props.min;
  var dispMax = inSI ? U.toSI(props.max, kind) : props.max;
  var dispStep;
  if (inSI) {
    if (kind === 'temperature') { dispStep = props.step * 5 / 9; }
    else if (kind === 'pressure') { dispStep = props.step * 0.0689476; }
    else if (kind === 'depth') { dispStep = props.step * 0.3048; }
    else if (kind === 'tubingID') { dispStep = props.step * 25.4; }
    else if (kind === 'gasRate') { dispStep = props.step * 28.31685; }
    else if (kind === 'liqRate' || kind === 'inventory') { dispStep = props.step * 0.158987; }
    else if (kind === 'wgr' || kind === 'cgr') { dispStep = props.step * 5.61458; }
    else if (kind === 'A_F') { dispStep = props.step * 1.6786e-4; }
    else if (kind === 'B_F') { dispStep = props.step * 5.929e-6; }
    else if (kind === 'A_F_Mscfd') { dispStep = props.step * 0.1678; }
    else if (kind === 'B_F_Mscfd') { dispStep = props.step * 5.929; }
    else { dispStep = props.step; }
    if (dispStep > 0) { var mag = Math.pow(10, Math.floor(Math.log10(dispStep))); var snapped = Math.round(dispStep / mag) * mag; if (snapped > 0) dispStep = snapped; }
  } else { dispStep = props.step; }
  var unitLabel = inSI ? U.label(kind) : (props.unit || '');
  var fmt = dispStep < 0.001 ? dispVal.toFixed(4) : dispStep < 0.01 ? dispVal.toFixed(3) : dispStep < 0.1 ? dispVal.toFixed(2) : dispStep < 1 ? dispVal.toFixed(1) : String(Math.round(dispVal));
  var _ed = useState({ editing: false, inpVal: '' }); var ed = _ed[0]; var setEd = _ed[1];
  var handleFocus = function() { setEd({ editing: true, inpVal: fmt }); };
  var handleInputChange = function(e) { setEd({ editing: true, inpVal: e.target.value }); };
  var handleCommit = function() {
    var raw = parseFloat(ed.inpVal);
    if (!isNaN(raw)) { var clamped = Math.max(dispMin, Math.min(dispMax, raw)); var final = inSI ? U.fromSI(clamped, kind) : clamped; props.onChange(final); }
    setEd({ editing: false, inpVal: '' });
  };
  var handleKeyDown = function(e) { if (e.key === 'Enter') { e.target.blur(); } if (e.key === 'Escape') { setEd({ editing: false, inpVal: '' }); } };
  var handle = function(e) { var v = parseFloat(e.target.value); if (inSI) v = U.fromSI(v, kind); props.onChange(v); };
  var inputDisplayVal = ed.editing ? ed.inpVal : fmt;
  return React.createElement('div', { style: { marginBottom: 9 } },
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 } },
      React.createElement('span', { style: { fontSize: 14, color: '#6a8aa8', fontFamily: FN, flexShrink: 0 } }, props.label),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 3 } },
        React.createElement('input', {
          type: 'text', inputMode: 'decimal', value: inputDisplayVal,
          onChange: handleInputChange, onFocus: handleFocus, onBlur: handleCommit, onKeyDown: handleKeyDown,
          style: { width: 72, background: ed.editing ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)', border: ed.editing ? '1px solid ' + c : '1px solid rgba(255,255,255,0.10)', borderRadius: 4, color: c, fontSize: 14, fontFamily: FN, fontWeight: 700, textAlign: 'right', padding: '2px 5px', outline: 'none', transition: 'border-color 0.15s, background 0.15s', boxSizing: 'border-box' }
        }),
        React.createElement('span', { style: { fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: FN, minWidth: 28 } }, unitLabel)
      )
    ),
    React.createElement('input', { type: 'range', min: dispMin, max: dispMax, step: dispStep, value: dispVal, onChange: handle, style: { width: '100%', height: 6, accentColor: c } })
  );
}

function Sec(props) {
  var _o = useState(props.open !== false); var o = _o[0], setO = _o[1];
  return React.createElement('div', { style: { marginBottom: 6 } },
    React.createElement('div', { onClick: function() { setO(!o); }, style: { display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' } },
      React.createElement('span', { style: { fontSize: 10, color: props.color || '#4a6a88', transform: o ? 'rotate(90deg)' : 'none', transition: 'transform .15s' } }, '\u25B6'),
      React.createElement('span', { style: { fontSize: 13, color: props.color || '#4a6a88', letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 700 } }, props.title)
    ),
    o && React.createElement('div', { style: { paddingTop: 6 } }, props.children)
  );
}

function Ch(props) {
  var sys = useUnitSys();
  var U = _U();
  var kind = props.kind;
  var inSI = (sys === 'si') && U && kind;

  // For Ch, props.value can be either a string (already-formatted, e.g. "0.00")
  // or a number.  If we have a kind and a numeric value, convert + reformat;
  // otherwise pass through.
  var displayValue = props.value;
  var displayUnit  = props.unit || '';
  if (typeof props.value === 'number' && !isNaN(props.value)) {
    var v = inSI ? U.toSI(props.value, kind) : props.value;
    var dec = props.decimals;
    if (dec === undefined) {
      var abs = Math.abs(v);
      dec = (abs >= 100) ? 0 : (abs >= 10) ? 1 : (abs >= 1) ? 2 : 3;
    }
    displayValue = v.toFixed(dec);
    if (inSI) displayUnit = U.label(kind);
  } else if (inSI && kind && typeof props.value === 'string') {
    var n = parseFloat(props.value);
    if (!isNaN(n)) {
      var v2 = U.toSI(n, kind);
      var dec2 = props.decimals;
      if (dec2 === undefined) {
        var ab = Math.abs(v2);
        dec2 = (ab >= 100) ? 0 : (ab >= 10) ? 1 : (ab >= 1) ? 2 : 3;
      }
      displayValue = v2.toFixed(dec2);
      displayUnit = U.label(kind);
    }
  }

  return React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.025)' } },
    React.createElement('span', { style: { fontSize: 17, color: '#4a6a88', fontFamily: FN } }, props.label),
    React.createElement('span', { style: { fontSize: 21, fontWeight: 600, color: props.color || '#94a3b8', fontFamily: FN } }, displayValue, displayUnit && React.createElement('span', { style: { fontSize: 15, opacity: 0.4 } }, ' ', displayUnit))
  );
}

function Modal(props) {
  if (!props.open) return null;
  return React.createElement('div', { onClick: props.onClose, style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(3,8,16,0.94)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: '16px' } },
    React.createElement('div', { onClick: function(e) { e.stopPropagation(); }, style: { background: '#07101c', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 10, padding: '14px 20px 14px', boxShadow: '0 24px 80px rgba(0,0,0,0.8)', width: '96vw', maxWidth: 1400, maxHeight: '94vh', overflow: 'auto', cursor: 'default' } },
      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
        React.createElement('span', { style: { fontSize: 10, color: '#4a6a88', fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase' } }, props.title),
        React.createElement('button', { onClick: props.onClose, style: { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, color: '#94a3b8', fontSize: 13, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, 'x')
      ),
      props.children
    )
  );
}

function CBox(props) {
  return React.createElement('div', { onClick: props.onClick, style: { marginBottom: 4, background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: 4, padding: 5, cursor: 'pointer', position: 'relative' } },
    React.createElement('div', { style: { position: 'absolute', top: 4, right: 4, zIndex: 2, width: 18, height: 18, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 } },
      React.createElement('svg', { viewBox: '0 0 12 12', width: 10, height: 10, fill: 'none', stroke: '#4a6a88', strokeWidth: 1.5 }, React.createElement('path', { d: 'M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8' }))
    ),
    props.children
  );
}

// =======================================================
// MAIN APP COMPONENT
// =======================================================
var CW = 100, CH = 420;

// ── Saved Cases (localStorage) ─────────────────────────────────────────────
function lsCases() { try { return JSON.parse(localStorage.getItem('wm_cases') || '[]'); } catch(e) { return []; } }
function lsSave(name, params) {
  var all = lsCases(); var entry = { name: name, ts: Date.now(), params: params };
  var idx = -1; for (var i = 0; i < all.length; i++) { if (all[i].name === name) { idx = i; break; } }
  if (idx >= 0) { all[idx] = entry; } else { all.push(entry); }
  try { localStorage.setItem('wm_cases', JSON.stringify(all)); } catch(e) {} return all;
}
function lsDelete(name) {
  var all = lsCases().filter(function(c) { return c.name !== name; });
  try { localStorage.setItem('wm_cases', JSON.stringify(all)); } catch(e) {} return all;
}
function lsLastPar() { try { var s = localStorage.getItem('wm_last'); return s ? Object.assign({}, DEFS, JSON.parse(s)) : null; } catch(e) { return null; } }

// ── Calibration CSV helpers ─────────────────────────────────────────────────
function parseCSV(text) {
  var lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  var delim = (lines[0].split(';').length > lines[0].split(',').length) ? ';' : ',';
  var headers = lines[0].split(delim).map(function(h) { return h.trim().replace(/['"]/g, '').toLowerCase(); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim(); if (!line) continue;
    var vals = line.split(delim);
    var row = {};
    headers.forEach(function(h, j) { row[h] = parseFloat((vals[j] || '').trim()); });
    rows.push(row);
  }
  return rows.length ? { headers: headers, rows: rows } : null;
}
function detectCol(headers, candidates) {
  for (var ci = 0; ci < candidates.length; ci++) {
    for (var hi = 0; hi < headers.length; hi++) {
      if (headers[hi].indexOf(candidates[ci]) > -1) return headers[hi];
    }
  }
  return null;
}
function calCols(headers) {
  return {
    qG:   detectCol(headers, ['qg','gas','rate','flow','mmscfd','mscfd','q_g']),
    WHP:  detectCol(headers, ['whp','thp','tubing_head','wellhead','wh_p','wh ']),
    BHP:  detectCol(headers, ['bhp','pwf','bottomhole','bh_p','sandface','bottom']),
    time: detectCol(headers, ['time','elapsed','hours','hour','t_hr','t ','hrs'])
  };
}
function snapRead(slot) { try { var s = localStorage.getItem('wm_snap_'+slot); return s ? JSON.parse(s) : null; } catch(e) { return null; } }
function snapWrite(slot, data) { try { localStorage.setItem('wm_snap_'+slot, JSON.stringify(data)); } catch(e) {} }
function snapErase(slot) { try { localStorage.removeItem('wm_snap_'+slot); } catch(e) {} }
function snapInitial() { return [snapRead(0), snapRead(1), snapRead(2)]; }

function App() {
  var _par = useState(function() { return lsLastPar() || DEFS; }); var par = _par[0], setPar = _par[1];
  var _playing = useState(false); var playing = _playing[0], setPlaying = _playing[1];
  var _speed = useState(1); var speed = _speed[0], setSpeed = _speed[1];
  var _mode = useState('static'); var mode = _mode[0], setMode = _mode[1];
  var _gasH = useState([]); var gasH = _gasH[0], setGasH = _gasH[1];
  var _whpH = useState([]); var whpH = _whpH[0], setWhpH = _whpH[1];
  var _bhpH = useState([]); var bhpH = _bhpH[0], setBhpH = _bhpH[1];
  var _liveR = useState(null); var liveR = _liveR[0], setLiveR = _liveR[1];
  var _expanded = useState(null); var expanded = _expanded[0], setExpanded = _expanded[1];
  var _scenario = useState('custom'); var scenario = _scenario[0], setScenario = _scenario[1];
  var _liveOp = useState(null); var liveOp = _liveOp[0], setLiveOp = _liveOp[1];
  var _extraHLState = useState(0); var extraHLState = _extraHLState[0], setExtraHLState = _extraHLState[1];
  var _surfData = useState(null); var surfData = _surfData[0], setSurfData = _surfData[1];
  var _winW = useState(Math.min(screen.width, screen.height)); var winW = _winW[0], setWinW = _winW[1];
  var _showCharts = useState(false); var showCharts = _showCharts[0], setShowCharts = _showCharts[1];
  // Edit-params modal state
  var _editMode = useState(false); var editMode = _editMode[0], setEditMode = _editMode[1];
  var _draftPar = useState(DEFS); var draftPar = _draftPar[0], setDraftPar = _draftPar[1];
  var _cases = useState(lsCases); var cases = _cases[0], setCases = _cases[1];
  var _saveName = useState(''); var saveName = _saveName[0], setSaveName = _saveName[1];
  var _configTab = useState('well'); var configTab = _configTab[0], setConfigTab = _configTab[1];
  var _snaps = useState(snapInitial); var snaps = _snaps[0], setSnaps = _snaps[1];
  // Calibration data — session-only, not persisted
  var _calSteady = useState(null); var calSteady = _calSteady[0], setCalSteady = _calSteady[1];
  var _calTime   = useState(null); var calTime   = _calTime[0],   setCalTime   = _calTime[1];
  var _calTOff   = useState(0);    var calTOff   = _calTOff[0],   setCalTOff   = _calTOff[1];
  // Batch foam state
  var _foamResult = useState(null); var foamResult = _foamResult[0], setFoamResult = _foamResult[1];
  var _foamType = useState('anionic'); var foamType = _foamType[0], setFoamType = _foamType[1];
  var _batchConc = useState(0.10); var batchConc = _batchConc[0], setBatchConc = _batchConc[1];
  // v3.4.7: SI/Imperial toggle — bumping this in onChange forces App to re-render
  // so all inline displays (op readout, fluid props, chart axes) reflect the new system.
  var unitSys = useUnitSys();
  var U = _U();

  var cRef = useRef(null);
  var phR = useRef(0), plR = useRef(false), spR = useRef(1);
  var parR = useRef(par), segR = useRef([]), ltR = useRef(null), lpR = useRef(0), rafR = useRef(null);
  var mdR = useRef('static');
  var ghR = useRef([]), whR = useRef([]), bhR = useRef([]), shR = useRef(0);
  var tsRef = useRef(M.createTransientState(M.TNC));
  var wasPlayingR = useRef(false);
  var foamCumulProdR = useRef(0);  // cumulative liquid produced since foam staging (bbl)
  // Slug amplitude smoothing: 5-min sim-time rolling buffer of fG/fL values
  var fluctBufR = useRef([]);       // { simTime, fG, fL }
  // State label debounce: only update display after label stable for 3s sim-time
  var stLabelR = useRef('static');  // last committed label
  var stLabelTR = useRef(0);        // sim-time when current candidate started

  useEffect(function() { parR.current = par; }, [par]);
  useEffect(function() { plR.current = playing; }, [playing]);
  useEffect(function() { spR.current = speed; }, [speed]);
  useEffect(function() { mdR.current = mode; }, [mode]);

  useEffect(function() {
    M.initTransientState(tsRef.current, parR.current);
    segR.current = M.transientToSegs(tsRef.current, parR.current);
  }, []);

  useEffect(function() {
    if (mdR.current === 'static') {
      M.initTransientState(tsRef.current, par);
      segR.current = M.transientToSegs(tsRef.current, par);
    }
  }, [par]);

  var nc = useMemo(function() { return M.buildNodalCurves(par, par.A_F || 1, par.B_F || 0, 0); }, [par]);
  var ncLive = useMemo(function() { if (extraHLState > 0.005) return M.buildNodalCurves(par, par.A_F || 1, par.B_F || 0, extraHLState); return null; }, [par, extraHLState]);
  var op = useMemo(function() { return M.findOperatingPoint(par, par.A_F || 1, par.B_F || 0); }, [par]);
  var fp = useMemo(function() { return M.computeProfile(par, 0); }, [par]);
  // Live IPR/VLP for the params popup — recomputes on every draftPar change
  var draftOp     = useMemo(function() { return M.findOperatingPoint(draftPar, draftPar.A_F || 1, draftPar.B_F || 0); }, [draftPar]);
  var draftCurves = useMemo(function() { return M.buildNodalCurves(draftPar, draftPar.A_F || 1, draftPar.B_F || 0, 0); }, [draftPar]);

  var set = function(k) { return function(v) { setPar(function(p2) { var n = {}; n[k] = v; return Object.assign({}, p2, n); }); }; };
  var clrHist = function() { ghR.current = []; setGasH([]); whR.current = []; setWhpH([]); bhR.current = []; setBhpH([]); };

  var loadScenario = function(key) {
    setScenario(key);
    if (key === 'custom') return;
    var sv = SCENARIOS[key];
    if (sv && sv.v) {
      setPar(function(p2) { return Object.assign({}, p2, sv.v, { vs_on: false, foam_rate: 0, foam_type: '', foam_Vliq0: 0, foam_efficiency: 70, foam_depth_ft: 0, foam_batch_active: false, foam_batch_conc: 0.10 }); });
      setPlaying(false); plR.current = false;
      setMode('static'); mdR.current = 'static';
      clrHist(); shR.current = 0; setLiveOp(null); setExtraHLState(0); setSurfData(null); setLiveR(null);
      setFoamResult(null); setEditMode(false); foamCumulProdR.current = 0;
    }
  };

  // =======================================================
  // ANIMATION LOOP
  // =======================================================
  useEffect(function() {
    var cv = cRef.current; if (!cv) return;
    var dpr = window.devicePixelRatio || 1;
    var resizeCanvas = function() {
      var h = cv.clientHeight || CH, w = cv.clientWidth || CW;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
        cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    resizeCanvas();

    var loop = function(ts) {
      if (!ltR.current) ltR.current = ts;
      var dt = Math.min((ts - ltR.current) / 1000, 0.05); ltR.current = ts; phR.current += dt;
      resizeCanvas();

      if (plR.current && mdR.current !== 'static') {
        var simDt = dt * spR.current;
        M.runTransient(tsRef.current, parR.current, simDt, 30);
        shR.current = tsRef.current.simTime;

        // Accumulate foam consumption every frame — surfactant leaves with produced liquid.
        // qLiqOut (bbl/day) × simDt (hours) / 24 = bbl produced this step.
        // Only count when foam is staged and well is open (not shut in).
        if (parR.current.foam_type && parR.current.foam_Vliq0 > 0 && !tsRef.current.isShutIn) {
          foamCumulProdR.current += (tsRef.current.qLiqOut || 0) * simDt / 24;
        }

        if (ts - lpR.current > 55) {
          lpR.current = ts;
          var pp = parR.current;
          segR.current = M.transientToSegs(tsRef.current, pp);
          var sd = M.transientSurfaceData(tsRef.current, pp);

          // --- SLUG/CHURN SURFACE RATE FLUCTUATION with 5-min rolling average ---
          var nSegs = segR.current.length || 1;
          var slugFr = 0, churnFr = 0, bubbleFr = 0;
          segR.current.forEach(function(seg) {
            var r = seg.siPhase || seg.regime;
            if (r === 'slug') slugFr++;
            else if (r === 'churn') churnFr++;
            else if (r === 'bubble') bubbleFr++;
          });
          slugFr /= nSegs; churnFr /= nSegs; bubbleFr /= nSegs;

          var s0seg = segR.current.length > 0 ? segR.current[0] : null;
          var vsl_surf = s0seg ? (s0seg.vsl || 0) : 0;
          var vsg_surf = s0seg ? (s0seg.vsg || 0) : 0;
          var D_ft_sf = pp.id_in / 12;
          var simPhase = shR.current * 3600;
          var fluct = M.surfFluct(simPhase, slugFr, churnFr, bubbleFr, vsl_surf, vsg_surf, D_ft_sf);

          // Rolling average over last 5 sim-minutes (0.0833 hr)
          // Push instant fG/fL, trim entries older than 5 min sim-time
          var fb = fluctBufR.current;
          fb.push({ t: shR.current, fG: fluct.fG || 1, fL: fluct.fL || 1 });
          var cutoff = shR.current - 5 / 60;  // 5 minutes in hours
          while (fb.length > 1 && fb[0].t < cutoff) fb.shift();
          var fGavg = fb.reduce(function(s, e) { return s + e.fG; }, 0) / fb.length;
          var fLavg = fb.reduce(function(s, e) { return s + e.fL; }, 0) / fb.length;

          var gasRate_display, waterRate_display, condRate_display, WHP_display, BHP_display;
          if (tsRef.current.isShutIn) {
            gasRate_display = 0; waterRate_display = 0; condRate_display = 0;
            WHP_display = sd.WHP || 0; BHP_display = sd.BHP || 0;
          } else {
            gasRate_display = sd.gasRate * fGavg;
            waterRate_display = sd.waterRate * fLavg;
            condRate_display = sd.condRate * fLavg;
            var whpFluct = 1 + (fGavg - 1) * 0.15;
            WHP_display = (sd.WHP || 0) * whpFluct;
            var bhpFluct = 1 + (fLavg - 1) * 0.03;
            BHP_display = (sd.BHP || 0) * bhpFluct;
          }

          setSurfData(sd);
          setLiveR({ gasRate: gasRate_display, condRate: condRate_display, waterRate: waterRate_display, liveWHP: WHP_display });

          // Auto-clear batch foam when cumulative liquid produced ≥ 85% of original treated volume.
          // Correct physics: foamer is carried out with produced water, not tied to wellbore inventory.
          if (parR.current.foam_type && (parR.current.foam_Vliq0 || 0) > 0) {
            if (foamCumulProdR.current >= parR.current.foam_Vliq0 * 0.85) {
              // Clear foam_type so liquidProps returns to baseline σ
              setPar(function(p2) { return Object.assign({}, p2, { foam_type: '', foam_Vliq0: 0 }); });
              foamCumulProdR.current = 0;
              // Zero the per-cell Gamma array so foam.js drift-flux corrections stop immediately
              if (tsRef.current.Gamma && tsRef.current.Gamma.fill) {
                tsRef.current.Gamma.fill(0);
              }
            }
          }

          // Mode: only switch on meaningful transitions, not rapid oscillations
          var label = sd.stateLabel || 'static';
          if (label === 'stable' || label === 'recovering') { setMode('flowing'); mdR.current = 'flowing'; }
          else if (label === 'unloading') { setMode('unloading'); mdR.current = 'unloading'; }
          else if (label === 'marginal') { setMode('flowing'); mdR.current = 'flowing'; }
          else if (label === 'loading' || label === 'dead') { setMode('loading'); mdR.current = 'loading'; }
          else if (label === 'equalizing' || label === 'shutting-in') { setMode('shutin'); mdR.current = 'shutin'; }

          var D_ft2 = pp.id_in / 12, Af2 = Math.PI * (D_ft2 / 2) * (D_ft2 / 2);
          var Vwb = Af2 * pp.TD / 5.615;
          var fillFr = Math.min(0.98, (sd.Vliq || 0) / Math.max(Vwb, 0.01));
          var hLiq2 = fillFr * pp.TD;
          var lp2 = M.liquidProps(pp);
          var TR_avg2 = pp.T_surf + (pp.geo_grad / 100) * pp.TD * 0.5 + 459.67;
          var rG_avg2 = M.gasDen(Math.max(pp.Pr * 0.6, 100), TR_avg2, pp.sg);
          var deltaP2 = (lp2.rL - rG_avg2) * hLiq2 / 144;
         var eHL = deltaP2 * 144 / (Math.max(lp2.rL - rG_avg2, 1) * pp.TD);
eHL = Math.max(0, Math.min(0.92, eHL));
// Do not carry loaded-VLP state through shut-in into re-open
setExtraHLState(tsRef.current.isShutIn ? 0 : eHL);

          // Debounce stateLabel: only update display after label stable for 3 sim-min
          // Prevents rapid oscillation between e.g. "marginal"/"loading"/"stable"
          // causing header badge to flicker every frame
          var newLabel = sd.stateLabel || 'static';
          if (newLabel !== stLabelR.current) {
            // Label candidate changed — start timing
            if (newLabel !== (stLabelTR._cand || stLabelR.current)) {
              stLabelTR._cand = newLabel;
              stLabelTR.current = shR.current;
            } else if (shR.current - stLabelTR.current >= 3 / 60) {
              // Stable for 3 sim-minutes — commit
              stLabelR.current = newLabel;
            }
          }

          if (!tsRef.current.isShutIn && sd.gasRate > 0.001) {
            setLiveOp({ q: gasRate_display, pwf: BHP_display });
          }

          // Record FLUCTUATED values to history so charts show oscillations
          ghR.current = ghR.current.slice(-3000).concat([{ t: shR.current, val: gasRate_display }]);
          whR.current = whR.current.slice(-3000).concat([{ t: shR.current, val: WHP_display }]);
          bhR.current = bhR.current.slice(-3000).concat([{ t: shR.current, val: BHP_display }]);
          setGasH([].concat(ghR.current)); setWhpH([].concat(whR.current)); setBhpH([].concat(bhR.current));
        }
      }

      // Foam overlay state — computed each frame from live liquid volume
      var _pp = parR.current;
      var _D_foam = _pp.id_in / 12, _Ap_foam = Math.PI * (_D_foam/2) * (_D_foam/2);
      var _liqColH = (tsRef.current.Vliq || 0) * 5.615 / Math.max(_Ap_foam, 0.001);
      var _liqTopFr = Math.max(0, (_pp.TD - _liqColH)) / Math.max(_pp.TD, 1);
      var _foamBotFr = Math.min(1, (_pp.foam_depth_ft || _pp.TD) / Math.max(_pp.TD, 1));
      var _foamIntensity = _pp.foam_Vliq0 > 0 ? Math.max(0, 1 - foamCumulProdR.current / _pp.foam_Vliq0) : 0;
      var foamDraw = (_pp.foam_type && _pp.foam_Vliq0 > 0) ? {
        active: true, topFrac: _liqTopFr, bottomFrac: _foamBotFr, intensity: _foamIntensity
      } : null;
      D.drawWB(cv, segR.current, phR.current, parR.current.cgr > parR.current.wgr ? 'condensate' : 'water', foamDraw);
      rafR.current = requestAnimationFrame(loop);
    };
    rafR.current = requestAnimationFrame(loop);
    return function() { cancelAnimationFrame(rafR.current); };
  }, []);

  // =======================================================
  // ACTIONS
  // =======================================================
  var reset = function() {
    setPlaying(false); plR.current = false;
    setMode('static'); mdR.current = 'static';
    M.initTransientState(tsRef.current, parR.current);
    segR.current = M.transientToSegs(tsRef.current, parR.current);
    clrHist(); shR.current = 0; setLiveOp(null); setExtraHLState(0); setSurfData(null); setLiveR(null);
    fluctBufR.current = []; stLabelR.current = 'static'; stLabelTR.current = 0; foamCumulProdR.current = 0;
  };

  var shutIn = function() {
    tsRef.current.isShutIn = true;
    setMode('shutin'); mdR.current = 'shutin';
  };

  // Edit-params modal: pause → edit draft → apply/cancel → resume
  var setD = function(k) { return function(v) { setDraftPar(function(p2) { var n = {}; n[k] = v; return Object.assign({}, p2, n); }); }; };
  var openEdit = function() {
    wasPlayingR.current = plR.current;
    setPlaying(false); plR.current = false;
    setDraftPar(Object.assign({}, par));
    setConfigTab('well');
    setEditMode(true);
  };
  var applyEdit = function() {
    var finalPar = Object.assign({}, draftPar);
    // Stage batch foam only when checkbox is active, well is shut in, and concentration is set.
    // foam_rate is NEVER modified here — it belongs exclusively to the continuous foamer.
    if (finalPar.foam_batch_active && (finalPar.foam_batch_conc || 0) > 0 && mdR.current === 'shutin') {
      finalPar.foam_type = 'anionic';
      finalPar.foam_Vliq0 = tsRef.current.Vliq || 0;
      foamCumulProdR.current = 0;  // reset production counter at staging
    } else {
      finalPar.foam_type = '';
      finalPar.foam_Vliq0 = 0;
    }
    setPar(finalPar);
    try { localStorage.setItem('wm_last', JSON.stringify(finalPar)); } catch(e) {}
    setEditMode(false);
    setFoamResult(null);
    if (wasPlayingR.current && mdR.current !== 'static') { setPlaying(true); plR.current = true; }
  };
  var cancelEdit = function() {
    setEditMode(false);
    if (wasPlayingR.current && mdR.current !== 'static') { setPlaying(true); plR.current = true; }
  };

  // ── Snapshot actions ────────────────────────────────────────────────────────
  var saveSnap = function(slot) {
    var tsClone;
    try { tsClone = JSON.parse(JSON.stringify(tsRef.current)); } catch(e) { return; }
    var parClean = Object.assign({}, par, { foam_type: '', foam_Vliq0: 0, foam_batch_active: false, foam_efficiency: par.foam_efficiency || 70 });
    var data = { ts: tsClone, par: parClean, sh: shR.current, Vliq: tsRef.current.Vliq || 0, WHP: tsRef.current.WHP || 0, BHP: tsRef.current.BHP || 0, savedAt: Date.now() };
    snapWrite(slot, data);
    setSnaps(function(prev) { var next = prev.slice(); next[slot] = data; return next; });
  };

  var loadSnap = function(slot) {
    // Always re-read from localStorage — JSON.parse produces fresh arrays each
    // time, preventing the simulation from mutating the in-memory snapshot.
    var data = snapRead(slot); if (!data || !data.ts) return;
    var fresh = M.createTransientState(M.TNC);
    Object.assign(fresh, data.ts);
    var live = tsRef.current;
    Object.keys(live).forEach(function(k) { delete live[k]; });
    Object.assign(live, fresh);
    live.isShutIn = true;
    var restoredPar = Object.assign({}, DEFS, data.par, { foam_type: '', foam_Vliq0: 0, foam_batch_active: false });
    setPar(restoredPar);
    shR.current = data.sh || 0;
    foamCumulProdR.current = 0;
    clrHist();
    segR.current = M.transientToSegs(live, restoredPar);
    fluctBufR.current = []; stLabelR.current = 'static'; stLabelTR.current = 0;
    setMode('shutin'); mdR.current = 'shutin';
    setPlaying(true); plR.current = true;
    setLiveOp(null); setExtraHLState(0); setSurfData(null);
    setFoamResult(null); setEditMode(false);
  };

  var eraseSnap = function(slot) {
    snapErase(slot);
    setSnaps(function(prev) { var next = prev.slice(); next[slot] = null; return next; });
  };

  var openW = function() {
    if (mdR.current === 'static') {
      M.initTransientStatic(tsRef.current, parR.current);
      clrHist(); shR.current = 0;
    }
    tsRef.current.isShutIn = false;
    // Clear loaded-VLP state immediately on re-open
    setExtraHLState(0);
    setLiveOp(null);
    fluctBufR.current = []; stLabelR.current = 'static'; stLabelTR.current = 0; foamCumulProdR.current = 0;
    // Minimal flush only — preserves liquid for gradual visual unloading.
    // The transient engine's intercell transport lifts liquid step by step.
    M.reopenFlush(tsRef.current, parR.current);
    // Seed qG=0: stepTransient surface BC will find the rate against the
    // actual loaded wellbore on the first step. Rate builds gradually as
    // liquid is expelled — realistic slug-by-slug unloading sequence.
    tsRef.current.qG = 0;
    setPlaying(true); plR.current = true;
    setMode('unloading'); mdR.current = 'unloading';
  };

  useEffect(function() {
    var onR = function() { setWinW(Math.min(window.innerWidth, screen.width)); };
    window.addEventListener('resize', onR);
    return function() { window.removeEventListener('resize', onR); };
  }, []);
  useEffect(function() {
    var tag = document.getElementById('wm-mob');
    if (mob) {
      if (!tag) {
        tag = document.createElement('style');
        tag.id = 'wm-mob';
        document.head.appendChild(tag);
      }
      tag.textContent = 'html,body,#root{overflow-x:hidden!important;overflow-y:auto!important;height:auto!important;}';
    } else {
      if (tag) tag.textContent = '';
    }
  }, [mob]);

  // === DERIVED STATE ===
  var sd = surfData || { gasRate: 0, waterRate: 0, condRate: 0, WHP: 0, BHP: 0, turnerRatio: 0, vsg: 0, vT: 0, vm0: 0, Vliq: 0, stateLabel: 'static', carryFrac: 1, qLiqIn: 0, qLiqOut: 0, VliqEquil: 0 };
  var isFlow = mode === 'unloading' || mode === 'flowing' || mode === 'loading';
  var BHP = sd.BHP || fp.Pwf || 0;
  var WHP = sd.WHP || fp.WHP_t || 0;
  var stLabel = stLabelR.current || 'static';  // debounced — no flicker
  var mC = mode === 'shutin' ? '#f87171' : mode === 'static' ? '#94a3b8' : mode === 'loading' ? '#fbbf24' : '#4ade80';
  var dp = { segs: segR.current.length > 0 ? segR.current : fp.segs };
  var rC = {}; dp.segs.forEach(function(s) { var k = s.siPhase || s.regime; rC[k] = (rC[k] || 0) + 1; }); var rT = dp.segs.length || 1;
  var D_ft3 = par.id_in / 12, Af3 = Math.PI * (D_ft3 / 2) * (D_ft3 / 2), Vwb2 = Af3 * par.TD / 5.615;
  var liqVolEst = sd.Vliq || 0;
  var fillPct = liqVolEst / Math.max(Vwb2, 1) * 100;
  var sigEff = M.liquidProps(par).sig;
  var displayCurves = ncLive || nc;
  var hasLoadedVLP = ncLive !== null && (mode === 'flowing' || mode === 'loading');
  var fillColor = fillPct > 50 ? '#f87171' : fillPct > 20 ? '#fbbf24' : '#4ade80';
  var mob = winW < 768;
  // ── Turner critical rate (qT) — same reference pressure as LIFT tab ──────
  var _lpt  = M.liquidProps(par);
  // Reference: actual WHP + surface temp — matches model turnerRatio (line 1759-1768)
  // Falls back to 0.4×Pr only when WHP is unavailable (static mode startup)
  var _Pm   = Math.max(WHP > 10 ? WHP : par.Pr * 0.4, 50);
  var _Tm   = par.T_surf + 459.67;                           // surface temp only
  var _rGt  = M.gasDen(_Pm, _Tm, par.sg);
  var _vTt  = 5.62 * Math.pow(Math.max(_lpt.sig, 0.1) * Math.max(_lpt.rL - _rGt, 0.1) / Math.max(_rGt * _rGt, 0.001), 0.25);
  var _Apt  = Math.PI * Math.pow(par.id_in / 24, 2);
  var _Zt   = M.papayZ ? M.papayZ(_Pm, _Tm, par.sg) : 0.9;
  var qT_display = _vTt * _Apt * (_Pm / 14.7) * (520 / _Tm) / _Zt * 86400 / 1e6;
  var _curQ = isFlow ? (liveR ? liveR.gasRate : fp.qGmmscfd) : 0;
  var _trR  = qT_display > 0.001 ? _curQ / qT_display : 0;
  var qTCol = _trR > 1.1 ? '#4ade80' : _trR > 0.85 ? '#fbbf24' : '#f87171';

  // =======================================================
  // RENDER
  // =======================================================
  return React.createElement('div', { style: { minHeight: '100vh', background: '#030810', color: '#ccd8e8', userSelect: 'none' } },

    // HEADER
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', gap: 8 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
        React.createElement('img', { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAAF7ElEQVR42u3YW2gcZxUH8P853zd73/WuvbuetdfrS/All9ZR05SklxTRKqWINFUCCEQgolKEKoSQeGiBogoQ4qUU8QIqBFURbykPFFSpfan6hlC4pIIKCyeRArVrx1kn8TVr7853eJj1pUmAtrJBJuf3NPPtaHZ0vu87c84ASimllFJKKaWUUkoppZRSSimllFJKKaWU+t8igDQKN+ENjjKxd+/XqKU7PNH4bk6giSHORTLU8+BmzKIGeo0AbuRX1HOATQRw72EHwPD73jXNvUL8QbcdvcfBDWQ2OM5EmJ/kvodgonJ5BGQAufUMM5jJOYjgg2Z1uZ1fhQzA+Lvtp09zvBWgGzI1AYbXVk9r2jvyQFsiasP83ow4cXO1Eq0cMMiADQDbdb83+BibmLf7CY5kwr8IhQtz9e60bnx1wBhb8CvWeusvjsYSBb9rK6UOiAOxm3wTb5/h+54mCMCrC9YwCRA4EcFHdmdOf7v33Ontz3yh3RomQMQ1F6k4iAMAEYgDEcRBArgAIPHvdP6wmGgweEhsFBBIE4DVg9Xj1dNwAAS/3MvGrL84lkgWSlsr0OHjE8uZHyPeavacIAmImxkwcGKIn/h44c+ndvzye72Bw9FvXNxzYmR2cZnY2K57OZEHyBbvMIWdAHGqZDvuYRFT3m+Gjxv/LoJIsCSN6wCwNAvXiCdT8WRLW7Ez29bOxhb8SktrMXyQTLbNL/dlsvnwNJ5I+519mWwhaCw755ht0a+0l7rZWOeCoNHY1EDbTbinAAiCmnnjWXr0RzZYrr/5C0Cinjn2SOszx30m+unL1ZO/uVydra8mHHGOth/h6t/wp5N44GkK6vzyF3n4cwjqlMhT/0EZfZX2Psm/fU7qNUpYAYitC1yho5zKFa9cGi/55cX5maXFhY7KttG3rqcz2bb2cnVqvNw7UJ1IzFyr9u/cMzXxdjKZstZj4u6BnQuzV9nYSt/g9NTEZudUuyl3FQFxMD/hvf5NDB/rGGq/vrjwg6OZxw4Wn/3ZxMlfTzWcA2AMiYgLkwTEjb5Cg4cov0PmJoktFXZJuhN//DnuPiEzY1RfFAjK+7G8KMyANN+9InNXq5NjFxKpdG1x/p1/nI8lU8lUJlfwx/8+Ontteqm26Hf0RGKxudkrk2MXjPWSmVyqJRdLJKcvj1vjZfPF+ZlrIm4LBhqAOCauX7mAN76z71u7hPPPv1R76sWR6ZkaQNZyELggkLWJAeSdP2DoMO7+Ep1/TaJJ7PsKLVbdlfPkJUlEGjWcPYWr5zFwGI0axAkRGjWCNBr18KVWry8TEQTOOSJiNgCYuPmKJQpPiRgihhmC5eXaxdG/RGNxCG21HB1OIJET96me/NnHh3/3wsXXnh/5a+TA1fufi3bdw5BGw4mEFQWt1IUsy/NUPUf+Lhk/I2O/R3EnLr0lwRKdexX5Acl0kH8nxdt45qLp3GczXcY1uO8huAYxiwgRMbOIsGHn3OWJ8c7ufr/c19HdPz01Ub00nk5ly72Dpa4+z4vMz11bmJvJ5NqisUS6Jbe8VIunkpls23+hoN7gKAM41psPju/78lBHuKIssd32sD30gn34+6ZjL61vQJqFHziWNbl+AjEZ2zrIXrJZrhTvMDs+afoOcjRLZGx5v4nlTEvFtH0o4kW8aDws0bxIFEA0nrA2AiCVyRVKlVQ6G94kFk8WS5VEKhONJ8LCrjVfKviVZKolvDgWT26lStoQAXi0lJXPf/gzPUUA3CymCQBxxG4/Yj/xE/uxH/LQYY7n6NYfpt7dCqpbZqJtqdjCZ/c+OeAD8JhuaGfC3oS7D9iPftd7/EX731NsoyvBpbXGei2xrDQsN/xE9B/mIOxH3t2w3PT7ytfGLTSdBIRRPfPIrlP7t90Y5ZvDDXCq03Q/yBzRNfq+kgYAfHWoNHH0rpRd32n/i2ad+Hbb6xvXqAC9qdjXz47NNwL69199wj6b6LYK96akEbXpIdYoK6WUUkoppZRSSimllFJKKaWUUkoppZRSSiml1P+vfwLaOPPFHOcjHgAAAABJRU5ErkJggg==', alt: 'wellmodel', style: { height: 36, width: 'auto' } }),
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 15, fontWeight: 800, letterSpacing: '.04em' } }, 'WELLMODEL', React.createElement('span', { style: { fontSize: 9, color: '#3a5a78', fontWeight: 400, marginLeft: 6 } }, '.app')),
          React.createElement('div', { style: { fontSize: 8, color: '#2a4a60', fontFamily: FN } }, 'Gas Well Dynamics Simulator')
        )
      ),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('span', { style: { padding: '3px 10px', background: mC + '12', border: '1px solid ' + mC + '30', borderRadius: 4, fontSize: 10, color: mC, fontWeight: 700, fontFamily: FN } }, mode.toUpperCase())
      )
    ),

    // 3-COLUMN LAYOUT
    React.createElement('div', { style: { display: 'flex', flexDirection: mob ? 'column' : 'row', height: mob ? 'auto' : 'calc(100vh - 52px)', minHeight: 'calc(100vh - 52px)', overflow: mob ? 'visible' : 'hidden' } },

      // LEFT PANEL
      React.createElement('div', { style: { flex: mob ? '0 0 auto' : '0 0 24%', width: mob ? '100%' : undefined, minWidth: mob ? 0 : 180, maxWidth: mob ? 'none' : 270, borderRight: mob ? 'none' : '1px solid rgba(255,255,255,0.05)', borderBottom: mob ? '1px solid rgba(255,255,255,0.06)' : 'none', padding: '8px 10px', overflowY: mob ? 'visible' : 'auto', boxSizing: 'border-box' } },

        // ── STATIC MODE: scenario picker + OPEN WELL ──────────────────
        mode === 'static' && React.createElement('div', null,
          React.createElement('div', { style: { fontSize: 11, color: '#5a7a98', fontFamily: FN, letterSpacing: '.1em', fontWeight: 700, marginBottom: 6 } }, 'SELECT SCENARIO'),
          Object.entries(SCENARIOS).filter(function(e) { return e[0] !== 'custom'; }).map(function(e) {
            var k = e[0], v = e[1];
            return React.createElement('button', { key: k, onClick: function() { loadScenario(k); setTimeout(openW, 200); },
              style: { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4,
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 5, color: '#8aa8c0' } },
              React.createElement('div', { style: { fontSize: 13, fontWeight: 700, color: '#a0c0d8', marginBottom: 2 } }, v.label),
              React.createElement('div', { style: { fontSize: 10, color: '#4a6a88', lineHeight: 1.3 } }, v.desc)
            );
          }),
          React.createElement('div', { style: { textAlign: 'center', margin: '8px 0', fontSize: 10, color: '#2a4a60', fontFamily: FN } }, '— or configure manually —'),
          React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 10 } },
            React.createElement('button', { onClick: openW, style: { flex: 1, padding: '10px 0', background: 'rgba(74,222,128,0.08)', border: '1.5px solid rgba(74,222,128,0.3)', borderRadius: 5, color: '#4ade80', fontSize: 15, fontWeight: 800 } }, '\u25B6 OPEN WELL'),
            React.createElement('button', { onClick: reset, style: { padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 5, color: '#3d607a', fontSize: 12 } }, 'RST')
          ),
          React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center' } },
            React.createElement('span', { style: { fontSize: 10, color: '#4a6a88', fontFamily: FN, letterSpacing: '.1em', textTransform: 'uppercase', minWidth: 38 } }, 'Units'),
            React.createElement('button', { onClick: function() { _U().set('imperial'); }, style: { flex: 1, padding: '4px 0', background: unitSys==='imperial'?'rgba(74,222,128,0.10)':'transparent', border: '1px solid '+(unitSys==='imperial'?'rgba(74,222,128,0.25)':'rgba(255,255,255,0.04)'), borderRadius: 3, color: unitSys==='imperial'?'#4ade80':'#5a7088', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, 'Imperial'),
            React.createElement('button', { onClick: function() { _U().set('si'); }, style: { flex: 1, padding: '4px 0', background: unitSys==='si'?'rgba(74,222,128,0.10)':'transparent', border: '1px solid '+(unitSys==='si'?'rgba(74,222,128,0.25)':'rgba(255,255,255,0.04)'), borderRadius: 3, color: unitSys==='si'?'#4ade80':'#5a7088', fontSize: 11, fontWeight: 600, cursor: 'pointer' } }, 'SI')
          ),
          // Op point quick readout
          op && !op.noFlow && React.createElement('div', { style: { padding: '6px 10px', marginBottom: 8, background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.12)', borderRadius: 5 } },
            React.createElement('div', { style: { fontSize: 10, color: '#3a6a50', fontFamily: FN, letterSpacing: '.1em', marginBottom: 3 } }, 'OPERATING POINT'),
            React.createElement('div', { style: { fontSize: 13, color: '#4ade80', fontFamily: FN, fontWeight: 700 } },
              (U&&U.get()==='si'?U.toSI(op.q_op,'gasRate').toFixed(2)+' '+U.label('gasRate'):op.q_op.toFixed(2)+' MMscfd') +
              ' @ ' + (U&&U.get()==='si'?Math.round(U.toSI(op.pwf_op,'pressure'))+' '+U.label('pressure'):Math.round(op.pwf_op)+' psi'))
          ),
          op && op.noFlow && React.createElement('div', { style: { padding: '6px 10px', marginBottom: 8, background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.12)', borderRadius: 5, fontSize: 13, color: '#f87171', fontFamily: FN, fontWeight: 700 } }, '\u26A0 NO FLOW — check parameters'),
          // Single entry point for all parameters
          React.createElement('button', { onClick: openEdit,
            style: { display: 'block', width: '100%', padding: '11px 0', marginBottom: 10, background: 'rgba(148,163,184,0.06)', border: '1.5px solid rgba(148,163,184,0.20)', borderRadius: 6, color: '#94a3b8', fontSize: 13, fontWeight: 700, cursor: 'pointer', letterSpacing: '.04em' } },
            '\u2699\uFE0E  Well Parameters'),
          React.createElement('div', { style: { marginTop: 6, padding: '8px', background: 'rgba(255,255,255,0.015)', borderRadius: 4, fontSize: 10, color: '#1e3848', fontFamily: FN, lineHeight: 1.8 } }, 'Z: Papay \u2022 \u03BCg: Lee-Gonzalez', React.createElement('br'), 'HL: Gray 1974 \u2022 Choke: Perkins 3\u03C6', React.createElement('br'), 'IPR: Forchheimer \u2022 Load: Wallis-Turner'),
          React.createElement('div', { style: { marginTop: 8, textAlign: 'center', fontSize: 10, color: '#3a7a8a', fontFamily: FN } },
            React.createElement('a', { href: 'mailto:norbert@wellmodel.app', style: { color: '#3a9aaa', textDecoration: 'none' } }, 'norbert@wellmodel.app')
          )
        ),

        // ── OPERATE MODE: choke control + key actions ──────────────────
        mode !== 'static' && React.createElement('div', null,

          // Well state badge + timer
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
            React.createElement('span', { style: { padding: '3px 10px', background: mC+'14', border: '1px solid '+mC+'35', borderRadius: 4, fontSize: 11, color: mC, fontWeight: 800, fontFamily: FN, letterSpacing: '.08em' } }, stLabel.toUpperCase()),
            React.createElement('span', { style: { fontSize: 11, color: '#4a6a88', fontFamily: FN } },
              shR.current < 1 ? Math.round(shR.current*60)+'min' : shR.current < 48 ? shR.current.toFixed(1)+'hr' : (shR.current/24).toFixed(1)+'d')
          ),

          // Key live readouts — what the operator watches
          React.createElement('div', { style: { background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: '8px 10px', marginBottom: 12 } },
            React.createElement(Ch, { label: 'WHP', value: WHP, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fb923c' }),
            React.createElement(Ch, { label: 'Gas', value: isFlow?(liveR?liveR.gasRate:fp.qGmmscfd):0, unit: 'MMscfd', kind: 'gasRate', decimals: 2, color: '#4ade80' }),
            React.createElement(Ch, { label: 'Turner', value: (sd.turnerRatio||0).toFixed(2), color: (sd.turnerRatio||0)>1.2?'#4ade80':(sd.turnerRatio||0)>0.8?'#fbbf24':'#f87171' }),
            React.createElement(Ch, { label: 'Liq', value: liqVolEst, unit: 'bbl', kind: 'inventory', decimals: 0, color: fillColor })
          ),

          // Foam active badge
          par.foam_type && par.foam_Vliq0 > 0 && React.createElement('div', {
            style: { padding: '5px 8px', marginBottom: 10, background: 'rgba(34,211,238,0.06)', border: '1px solid rgba(34,211,238,0.30)', borderRadius: 4 }
          },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 } },
              React.createElement('span', { style: { fontSize: 10, color: '#22d3ee', fontFamily: FN, fontWeight: 800, letterSpacing: '.06em' } }, '\uD83D\uDEE2 FOAM ACTIVE'),
              React.createElement('span', { style: { fontSize: 10, color: '#22d3ee', fontFamily: FN } },
                Math.round(Math.max(0, 1 - foamCumulProdR.current / Math.max(par.foam_Vliq0, 0.001)) * 100) + '% remaining')
            ),
            React.createElement('div', { style: { fontSize: 9, color: '#0e8090', fontFamily: FN } },
              (par.foam_rate * 100).toFixed(1) + 'wt% \u2022 ' + Math.round(par.foam_depth_ft || 0) + 'ft \u2022 ' + Math.round(par.foam_efficiency || 70) + '% eff \u2022 ' +
              foamCumulProdR.current.toFixed(1) + '/' + par.foam_Vliq0.toFixed(1) + ' bbl prod.')
          ),

          // ── THE CHOKE (only meaningful control when flowing) ──
          mode !== 'shutin' && React.createElement('div', { style: { marginBottom: 14 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 } },
              React.createElement('span', { style: { fontSize: 11, color: '#fb923c', fontFamily: FN, letterSpacing: '.12em', fontWeight: 700, textTransform: 'uppercase' } }, 'Choke'),
              React.createElement('span', { style: { fontSize: 28, color: '#fb923c', fontFamily: FN, fontWeight: 800, lineHeight: 1 } }, par.choke_64,
                React.createElement('span', { style: { fontSize: 14, opacity: 0.5, marginLeft: 2 } }, '/64"'))
            ),
            React.createElement('input', { type: 'range', min: 4, max: 96, step: 2, value: par.choke_64,
              onChange: function(e) { set('choke_64')(+e.target.value); },
              style: { width: '100%', height: 10, accentColor: '#fb923c', cursor: 'pointer' }
            }),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#2a4050', fontFamily: FN, marginTop: 3 } },
              React.createElement('span', null, '4'),
              React.createElement('span', null, '96')
            )
          ),

          // Shut-in controls
          mode !== 'shutin' && React.createElement('button', { onClick: shutIn,
            style: { display: 'block', width: '100%', padding: '11px 0', marginBottom: 6, background: 'rgba(248,113,113,0.06)', border: '1.5px solid rgba(248,113,113,0.25)', borderRadius: 5, color: '#f87171', fontSize: 15, fontWeight: 800, cursor: 'pointer' } },
            '\u25A0 SHUT IN'),

          // Shut-in active panel
          mode === 'shutin' && React.createElement('div', { style: { marginBottom: 10, padding: '8px', background: 'rgba(248,113,113,0.03)', border: '1px solid rgba(248,113,113,0.12)', borderRadius: 5 } },
            React.createElement('div', { style: { fontSize: 11, color: '#a78bfa', fontFamily: FN, marginBottom: 6 } },
              U&&U.get()==='si'
                ? 'BHP: '+Math.round(U.toSI(BHP,'pressure'))+' bar \u2022 WHP: '+Math.round(U.toSI(WHP,'pressure'))+' bar'
                : 'BHP: '+Math.round(BHP)+' psi \u2022 WHP: '+Math.round(WHP)+' psi'),
            React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 8 } },
              React.createElement('button', { onClick: function(){var np=!playing;setPlaying(np);plR.current=np;},
                style: { flex:1, padding:'7px 0', background:'rgba(248,113,113,0.04)', border:'1px solid rgba(248,113,113,0.15)', borderRadius:4, color:'#f87171', fontSize:13, fontWeight:700, cursor:'pointer' } },
                playing?'\u275A\u275A PAUSE':'\u25B6 PBU'),
              React.createElement('button', { onClick: openW,
                style: { padding:'7px 12px', background:'rgba(74,222,128,0.06)', border:'1px solid rgba(74,222,128,0.15)', borderRadius:4, color:'#4ade80', fontSize:11, fontWeight:700, cursor:'pointer' } },
                'RE-OPEN')
            ),

            // ── Snapshot panel ──────────────────────────────────────────────
            React.createElement('div', { style: { borderTop: '1px solid rgba(34,211,238,0.10)', paddingTop: 7 } },
              React.createElement('div', { style: { fontSize: 9, color: '#0e6070', fontFamily: FN, letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 5 } }, 'Snapshots'),
              [0, 1, 2].map(function(slot) {
                var snap = snaps[slot];
                var hasData = !!(snap && snap.ts);
                return React.createElement('div', { key: slot, style: { display: 'flex', alignItems: 'center', gap: 3, marginBottom: slot < 2 ? 4 : 0 } },
                  React.createElement('span', { style: { fontSize: 10, color: hasData ? '#22d3ee' : '#1a3040', fontFamily: FN, fontWeight: 700, minWidth: 14, textAlign: 'center' } }, slot + 1),
                  hasData
                    ? React.createElement('div', { style: { flex: 1, fontSize: 9, color: '#3a8090', fontFamily: FN, lineHeight: 1.4 } },
                        (snap.Vliq || 0).toFixed(0) + ' bbl \u00B7 ' + Math.round(snap.WHP || 0) + ' psi',
                        React.createElement('br'),
                        (snap.sh || 0) < 1 ? Math.round((snap.sh || 0) * 60) + 'min' : (snap.sh || 0).toFixed(1) + 'hr shut-in')
                    : React.createElement('span', { style: { flex: 1, fontSize: 9, color: '#1e3040', fontFamily: FN, fontStyle: 'italic' } }, '\u2014 empty \u2014'),
                  React.createElement('button', { onClick: function() { saveSnap(slot); }, title: 'Save to slot ' + (slot + 1),
                    style: { padding: '3px 7px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.22)', borderRadius: 3, color: '#22d3ee', fontSize: 11, cursor: 'pointer', lineHeight: 1 } }, '\u21E9'),
                  hasData && React.createElement('button', { onClick: function() { loadSnap(slot); }, title: 'Restore snapshot ' + (slot + 1),
                    style: { padding: '3px 7px', background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.18)', borderRadius: 3, color: '#4ade80', fontSize: 11, cursor: 'pointer', lineHeight: 1 } }, '\u21E5'),
                  hasData && React.createElement('button', { onClick: function() { eraseSnap(slot); }, title: 'Clear slot ' + (slot + 1),
                    style: { padding: '3px 5px', background: 'transparent', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 3, color: '#2a4050', fontSize: 10, cursor: 'pointer', lineHeight: 1 } }, '\u00D7')
                );
              })
            )
          ),

          // Pause / Resume — visible in all flowing modes (shut-in has its own PBU button)
          mode !== 'shutin' && React.createElement('button', {
            onClick: function() { var np = !playing; setPlaying(np); plR.current = np; },
            style: { display: 'block', width: '100%', padding: '6px 0', marginBottom: 6,
              background: playing ? 'rgba(245,158,11,0.07)' : 'rgba(74,222,128,0.07)',
              border: '1px solid ' + (playing ? 'rgba(245,158,11,0.25)' : 'rgba(74,222,128,0.20)'),
              borderRadius: 4, color: playing ? '#f59e0b' : '#4ade80', fontSize: 12, fontWeight: 700, cursor: 'pointer' }
          }, playing ? '\u275A\u275A  PAUSE' : '\u25B6  RESUME'),

          // Speed
          React.createElement('div', { style: { display: 'flex', gap: 3, marginBottom: 10 } },
            [1,10,100,500,2000].map(function(s) {
              return React.createElement('button', { key: s, onClick: function(){setSpeed(s);},
                style: { flex:1, padding:'5px 0', background:speed===s?'rgba(245,158,11,0.1)':'transparent', border:'1px solid '+(speed===s?'rgba(245,158,11,0.2)':'rgba(255,255,255,0.04)'), borderRadius:3, color:speed===s?'#f59e0b':'#2a4055', fontSize:11, cursor:'pointer' } },
                s>=1000?s/1000+'k':s,'x');
            })
          ),

          // Liquid fill bar
          React.createElement('div', { style: { marginBottom: 12 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 3 } },
              React.createElement('span', { style: { fontSize: 11, color: '#4a6a88', fontFamily: FN } }, 'Wellbore fill'),
              React.createElement('span', { style: { fontSize: 11, color: fillColor, fontFamily: FN, fontWeight: 700 } }, fillPct.toFixed(0)+'%')
            ),
            React.createElement('div', { style: { height: 6, background: '#0c1828', borderRadius: 3 } },
              React.createElement('div', { style: { height: '100%', width: Math.min(fillPct,100)+'%', background: fillColor, borderRadius: 3, transition: 'width .5s, background 1s' } })
            )
          ),

          // Divider
          React.createElement('div', { style: { borderTop: '1px solid rgba(255,255,255,0.05)', marginBottom: 10 } }),

          // RST + Edit params
          React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 4 } },
            React.createElement('button', { onClick: reset,
              style: { padding:'7px 10px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:4, color:'#3d607a', fontSize:11, cursor:'pointer' } },
              'RST'),
            React.createElement('button', { onClick: openEdit,
              style: { flex:1, padding:'7px 0', background:'rgba(148,163,184,0.05)', border:'1px solid rgba(148,163,184,0.15)', borderRadius:4, color:'#94a3b8', fontSize:12, fontWeight:700, cursor:'pointer' } },
              '\u2699 Edit Parameters')
          ),

          // Units toggle
          React.createElement('div', { style: { display: 'flex', gap: 4, marginTop: 6, alignItems: 'center' } },
            React.createElement('span', { style: { fontSize: 10, color: '#4a6a88', fontFamily: FN, letterSpacing: '.1em', textTransform: 'uppercase', minWidth: 38 } }, 'Units'),
            React.createElement('button', { onClick: function(){_U().set('imperial');}, style: { flex:1, padding:'3px 0', background:unitSys==='imperial'?'rgba(74,222,128,0.10)':'transparent', border:'1px solid '+(unitSys==='imperial'?'rgba(74,222,128,0.25)':'rgba(255,255,255,0.04)'), borderRadius:3, color:unitSys==='imperial'?'#4ade80':'#5a7088', fontSize:10, cursor:'pointer' } }, 'Imperial'),
            React.createElement('button', { onClick: function(){_U().set('si');}, style: { flex:1, padding:'3px 0', background:unitSys==='si'?'rgba(74,222,128,0.10)':'transparent', border:'1px solid '+(unitSys==='si'?'rgba(74,222,128,0.25)':'rgba(255,255,255,0.04)'), borderRadius:3, color:unitSys==='si'?'#4ade80':'#5a7088', fontSize:10, cursor:'pointer' } }, 'SI')
          ),
          React.createElement('div', { style: { marginTop: 10, textAlign: 'center', fontSize: 10, fontFamily: FN } },
            React.createElement('a', { href: 'mailto:norbert@wellmodel.app', style: { color: '#3a9aaa', textDecoration: 'none' } }, 'norbert@wellmodel.app')
          )
        )
      )
    ,

    // ── WELL PARAMETERS POPUP — centered, two-column, IPR/VLP live right panel ──
    editMode && React.createElement('div', {
      style: { position:'fixed', inset:0, zIndex:9000, background:'rgba(3,8,16,0.90)', backdropFilter:'blur(8px)',
        display:'flex', alignItems: mob ? 'stretch' : 'center', justifyContent: mob ? 'stretch' : 'center' }
    },
      React.createElement('div', { onClick: cancelEdit, style: { position:'absolute', inset:0 } }),

      React.createElement('div', { onClick: function(e){e.stopPropagation();},
        style: { position:'relative', width: mob ? '100%' : '88vw', maxWidth: mob ? 'none' : 1140, height: mob ? '100%' : '86vh', background:'#07101c',
          border:'1px solid rgba(255,255,255,0.10)', borderRadius: mob ? 0 : 10, display:'flex', flexDirection:'column',
          boxShadow:'0 32px 96px rgba(0,0,0,0.85)', zIndex:1, overflow:'hidden' }
      },

        // ── Header: title + tabs + close ──
        React.createElement('div', { style: { padding:'12px 18px 0', borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 } },
          React.createElement('div', { style: { display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 } },
            React.createElement('span', { style:{ fontSize:10, color:'#4a6a88', letterSpacing:'.16em', textTransform:'uppercase', fontWeight:700, fontFamily:FN } },
              mode==='static' ? '\u2699\uFE0E  Well Parameters' : '\u2699\uFE0E  Edit Parameters — simulation paused'),
            React.createElement('button', { onClick:cancelEdit,
              style:{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:5, color:'#64748b', fontSize:14, width:28, height:28, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' } },
              '\u00D7')
          ),
          React.createElement('div', { style:{ display:'flex', gap:4, marginBottom:0 } },
            [['well','WELL & IPR'],['fluids','FLUIDS'],['lift','LIFT'],['cal','CALIBRATE']].map(function(t) {
              var act = configTab === t[0];
              return React.createElement('button', { key:t[0], onClick:function(){setConfigTab(t[0]);},
                style:{ padding:'7px 18px', fontSize:11, fontWeight:700, fontFamily:FN, cursor:'pointer',
                  background:'transparent', border:'none', borderBottom: act ? '2px solid #94a3b8' : '2px solid transparent',
                  color: act ? '#ccd8e8' : '#4a6a88', marginBottom:-1 } }, t[1]);
            })
          )
        ),

        // ── Two-column body ──
        React.createElement('div', { style:{ flex:1, display:'flex', overflow:'hidden' } },

          // LEFT COLUMN — sliders (scrollable)
          React.createElement('div', { style:{ width: mob ? '100%' : 340, flexShrink:0, overflowY:'auto', padding:'14px 16px', borderRight: mob ? 'none' : '1px solid rgba(255,255,255,0.06)', boxSizing:'border-box' } },

            // ── Saved Cases ──────────────────────────────────────────────
            React.createElement(Sec, { title:'Saved Cases', color:'#38bdf8', open: true },
              cases.length === 0
                ? React.createElement('div', { style:{ fontSize:11, color:'#2a4a60', fontFamily:FN, padding:'4px 0 2px' } }, 'No saved cases — type a name in the footer to save.')
                : React.createElement('div', null,
                    cases.map(function(c) {
                      var d = new Date(c.ts);
                      var ds = d.toLocaleDateString([], { day:'numeric', month:'short', year:'2-digit' }) + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
                      return React.createElement('div', { key: c.name, style:{ display:'flex', alignItems:'center', gap:5, marginBottom:4, padding:'5px 7px', background:'rgba(56,189,248,0.04)', border:'1px solid rgba(56,189,248,0.10)', borderRadius:4 } },
                        React.createElement('div', { style:{ flex:1, minWidth:0 } },
                          React.createElement('div', { style:{ fontSize:12, color:'#7ab8d8', fontFamily:FN, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' } }, c.name),
                          React.createElement('div', { style:{ fontSize:9, color:'#2a4a60', fontFamily:FN } }, ds)
                        ),
                        React.createElement('button', { onClick: function() { setDraftPar(Object.assign({}, DEFS, c.params)); }, style:{ padding:'3px 9px', background:'rgba(56,189,248,0.12)', border:'1px solid rgba(56,189,248,0.28)', borderRadius:3, color:'#38bdf8', fontSize:10, fontWeight:700, cursor:'pointer', fontFamily:FN } }, 'Load'),
                        React.createElement('button', { onClick: function() { setCases(lsDelete(c.name)); }, style:{ padding:'3px 7px', background:'rgba(248,113,113,0.07)', border:'1px solid rgba(248,113,113,0.18)', borderRadius:3, color:'#f87171', fontSize:11, fontWeight:700, cursor:'pointer', fontFamily:FN } }, '\u00D7')
                      );
                    })
                  )
            ),

            // WELL & IPR tab
            configTab === 'well' && React.createElement('div', null,
              React.createElement(Sec, { title:'IPR / Nodal', color:'#4ade80', open:true },
                React.createElement(Sl, { label:'A (Darcy)', value:+(draftPar.A_F/1000).toFixed(1), min:1, max:5000, step:1, unit:'psi\u00B2/Mscfd', kind:'A_F_Mscfd', onChange:function(v){setD('A_F')(v*1000);}, color:'#f87171' }),
                React.createElement(Sl, { label:'B (non-Darcy)', value:+(draftPar.B_F/1e6).toFixed(4), min:0, max:2, step:0.001, unit:'psi\u00B2/Mscfd\u00B2', kind:'B_F_Mscfd', onChange:function(v){setD('B_F')(v*1e6);}, color:'#fb923c' }),
                React.createElement(Sl, { label:'Pr', value:draftPar.Pr, min:500, max:12000, step:100, unit:'psi', kind:'pressure', onChange:setD('Pr'), color:'#4ade80' }),
                React.createElement(Sl, { label:'k', value:draftPar.k_md, min:0.1, max:200, step:0.1, unit:'md', kind:'permeability', onChange:setD('k_md'), color:'#a78bfa' }),
                React.createElement(Sl, { label:'\u03C6', value:draftPar.phi, min:0.02, max:0.4, step:0.01, onChange:setD('phi'), color:'#a78bfa' }),
                React.createElement(Sl, { label:'re', value:draftPar.r_e, min:100, max:5000, step:50, unit:'ft', onChange:setD('r_e'), color:'#a78bfa' }),
                React.createElement(Sl, { label:'Skin', value:draftPar.skin, min:-5, max:50, step:0.5, onChange:setD('skin'), color:'#f59e0b' }),
                React.createElement(Sl, { label:'h net', value:draftPar.h_net||50, min:5, max:300, step:5, unit:'ft', kind:'depth', onChange:setD('h_net'), color:'#a78bfa' }),
                // Turner constant — calibration parameter
                React.createElement(Sl, { label:'Turner C', value:+(draftPar.turner_const||5.62).toFixed(2), min:1.5, max:6.5, step:0.05, onChange:setD('turner_const'), color:'#fbbf24' }),
                React.createElement('div', { style:{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#3a5a70', fontFamily:FN, marginTop:-4, marginBottom:4, paddingLeft:2, paddingRight:2 } },
                  React.createElement('span', { title:'PROSPER / dimensionally consistent' }, '2.04 PROSPER'),
                  React.createElement('span', { title:'Coleman (1991) JPT correction' }, '4.45 Coleman'),
                  React.createElement('span', { title:"Turner (1969) original", style:{ color: (draftPar.turner_const||5.62) >= 5.5 ? '#fbbf24' : '#3a5a70' } }, '5.62 Turner')
                )
              ),
              React.createElement(Sec, { title:'Well Geometry', color:'#7a9ab8', open:true },
                React.createElement(Sl, { label:'Depth', value:draftPar.TD, min:2000, max:18000, step:500, unit:'ft', kind:'depth', onChange:setD('TD'), color:'#7a9ab8' }),
                React.createElement(Sl, { label:'ID', value:draftPar.id_in, min:1, max:5, step:0.1, unit:'in', kind:'tubingID', onChange:setD('id_in'), color:'#7a9ab8' }),
                React.createElement(Sl, { label:'SG', value:draftPar.sg, min:0.55, max:0.85, step:0.01, onChange:setD('sg'), color:'#7a9ab8' }),
                React.createElement(Sl, { label:'Tsurf', value:draftPar.T_surf, min:60, max:140, step:1, unit:'\u00B0F', onChange:setD('T_surf'), color:'#7a9ab8' }),
                React.createElement(Sl, { label:'Grad', value:draftPar.geo_grad, min:0.5, max:3.5, step:0.1, unit:'\u00B0F/100ft', onChange:setD('geo_grad'), color:'#7a9ab8' })
              ),
              React.createElement(Sec, { title:'Choke & Sep', color:'#fb923c', open:true },
                React.createElement(Sl, { label:'Choke', value:draftPar.choke_64, min:4, max:96, step:2, unit:'/64in', onChange:setD('choke_64'), color:'#fb923c' }),
                React.createElement(Sl, { label:'Psep', value:draftPar.P_sep, min:3, max:1500, step:25, unit:'psi', kind:'pressure', onChange:setD('P_sep'), color:'#60a5fa' })
              )
            ),

            // FLUIDS tab
            configTab === 'fluids' && React.createElement('div', null,
              React.createElement(Sec, { title:'Fluids', color:'#38bdf8', open:true },
                React.createElement(Sl, { label:'WGR', value:draftPar.wgr, min:0, max:500, step:5, unit:'bbl/MMscf', kind:'wgr', onChange:setD('wgr'), color:'#60a5fa' }),
                React.createElement(Sl, { label:'CGR', value:draftPar.cgr, min:0, max:300, step:5, unit:'bbl/MMscf', kind:'cgr', onChange:setD('cgr'), color:'#fde047' }),
                React.createElement(Sl, { label:'Pdew', value:draftPar.P_dew, min:100, max:6000, step:50, unit:'psi', kind:'pressure', onChange:setD('P_dew'), color:'#fde047' }),
                React.createElement(Sl, { label:'Salinity', value:draftPar.salinity/1000, min:0, max:250, step:5, unit:'kppm', kind:'salinity', onChange:function(v){setD('salinity')(v*1000);}, color:'#38bdf8' })
              )
            ),

            // LIFT tab
            configTab === 'lift' && React.createElement('div', null,
              React.createElement(Sec, { title:'Velocity String', color:'#a78bfa', open:true },
                React.createElement('div', { style:{ display:'flex', alignItems:'center', gap:6, marginBottom:6 } },
                  React.createElement('input', { type:'checkbox', checked:draftPar.vs_on, onChange:function(e){setD('vs_on')(e.target.checked);}, style:{accentColor:'#a78bfa'} }),
                  React.createElement('span', { style:{fontSize:13, color:draftPar.vs_on?'#a78bfa':'#3a5a70', fontFamily:FN, fontWeight:600} }, 'Enable velocity string')
                ),
                draftPar.vs_on && React.createElement('div', null,
                  React.createElement(Sl, { label:'VS ID', value:draftPar.vs_id, min:1.0, max:2.5, step:0.05, unit:'in', kind:'tubingID', onChange:setD('vs_id'), color:'#a78bfa' }),
                  React.createElement(Sl, { label:'VS Depth', value:draftPar.vs_depth, min:1000, max:draftPar.TD, step:500, unit:'ft', kind:'depth', onChange:setD('vs_depth'), color:'#a78bfa' })
                )
              ),
              React.createElement(Sec, { title:'Continuous Foamer', color:'#c084fc', open:true },
                React.createElement(Sl, { label:'Foamer rate', value:draftPar.foam_rate, min:0, max:5, step:0.1, unit:'gal/Mscf', onChange:function(v){setD('foam_rate')(v); if(v===0)setD('foam_type')('');}, color:'#c084fc' }),
                React.createElement('div', { style:{fontSize:11,color:'#c084fc',fontFamily:FN,marginBottom:4,visibility:draftPar.foam_rate>0?'visible':'hidden'} },
                  '\u03C3 reduced: '+Math.round(M.liquidProps(draftPar).sig)+' dyn/cm')
              ),
              React.createElement(Sec, { title:'Batch Foam Treatment', color:'#22d3ee', open:true },
                (function() {
                  // Liquid column geometry from current shut-in state
                  var _Ap_bf = Math.PI * Math.pow(draftPar.id_in / 24, 2);
                  var _Vliq_bf = tsRef.current.Vliq || 0;
                  var _liqColH = _Vliq_bf * 5.615 / Math.max(_Ap_bf, 0.001);
                  var _liqTop  = Math.max(0, draftPar.TD - _liqColH);
                  var _isShutIn = mdR.current === 'shutin';
                  var _active  = !!draftPar.foam_batch_active;
                  var _depthVal = Math.max(_liqTop, draftPar.foam_depth_ft > 0 ? draftPar.foam_depth_ft : draftPar.TD);
                  var _fracTreated = _liqColH > 0.1 ? Math.min(1, (_depthVal - _liqTop) / _liqColH) : 0;
                  var _sigBase = M.liquidProps(Object.assign({}, draftPar, { foam_rate: 0, foam_type: '' })).sig;
                  var _sigChem = M.foamSigma ? M.foamSigma(_sigBase, draftPar.foam_batch_conc || 0.10, 'anionic', draftPar.T_surf, draftPar.salinity || 0) : _sigBase;
                  var _effFrac = (draftPar.foam_efficiency || 70) / 100;
                  var _sigEff  = Math.max(15, _sigBase - _effFrac * (_sigBase - _sigChem));

                  return React.createElement('div', null,

                    // ── Checkbox: Implement batch foam ──
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 10, background: _active ? 'rgba(34,211,238,0.08)' : 'rgba(255,255,255,0.02)', border: '1px solid ' + (_active ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.08)'), borderRadius: 5, cursor: 'pointer' },
                      onClick: function() { setD('foam_batch_active')(!_active); }
                    },
                      React.createElement('input', { type: 'checkbox', checked: _active, readOnly: true,
                        style: { accentColor: '#22d3ee', width: 14, height: 14, cursor: 'pointer', flexShrink: 0 } }),
                      React.createElement('div', null,
                        React.createElement('div', { style: { fontSize: 12, fontWeight: 700, color: _active ? '#22d3ee' : '#4a6a88', fontFamily: FN } }, 'Implement batch foam treatment'),
                        React.createElement('div', { style: { fontSize: 9, color: _active ? '#0e8090' : '#2a4050', fontFamily: FN } }, 'Well must be shut in to stage')
                      )
                    ),

                    // Precondition notice when not shut in
                    _active && !_isShutIn && React.createElement('div', { style: { padding: '6px 10px', marginBottom: 10, background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 4, fontSize: 10, color: '#f87171', fontFamily: FN } },
                      '\u26A0 Shut in well before staging foam treatment'),

                    // Parameters — shown when active, greyed when inactive
                    React.createElement('div', { style: { opacity: _active ? 1 : 0.35, pointerEvents: _active ? 'auto' : 'none' } },

                      // Liquid column reference readout
                      React.createElement('div', { style: { padding: '7px 10px', marginBottom: 10, background: 'rgba(34,211,238,0.04)', border: '1px solid rgba(34,211,238,0.12)', borderRadius: 4 } },
                        React.createElement('div', { style: { fontSize: 9, color: '#0e8090', fontFamily: FN, letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 5 } }, 'Current Liquid Column'),
                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '3px 8px', fontSize: 11, fontFamily: FN } },
                          React.createElement('div', null,
                            React.createElement('div', { style: { fontSize: 9, color: '#0e8090' } }, 'Liquid top'),
                            React.createElement('div', { style: { color: '#22d3ee', fontWeight: 700 } }, Math.round(_liqTop) + ' ft')),
                          React.createElement('div', null,
                            React.createElement('div', { style: { fontSize: 9, color: '#0e8090' } }, 'Col. height'),
                            React.createElement('div', { style: { color: '#22d3ee', fontWeight: 700 } }, Math.round(_liqColH) + ' ft')),
                          React.createElement('div', null,
                            React.createElement('div', { style: { fontSize: 9, color: '#0e8090' } }, 'Volume'),
                            React.createElement('div', { style: { color: '#22d3ee', fontWeight: 700 } }, _Vliq_bf.toFixed(1) + ' bbl'))
                        )
                      ),

                      React.createElement(Sl, { label: 'Concentration', value: draftPar.foam_batch_conc || 0.10, min: 0.02, max: 0.30, step: 0.01, unit: 'wt%', color: '#22d3ee',
                        onChange: function(v) { setD('foam_batch_conc')(v); } }),

                      _liqColH > 0.5
                        ? React.createElement(Sl, { label: 'Foamer depth', value: _depthVal,
                            min: Math.ceil(_liqTop / 100) * 100, max: draftPar.TD, step: 100, unit: 'ft', kind: 'depth', color: '#22d3ee',
                            onChange: function(v) { setD('foam_depth_ft')(v); } })
                        : React.createElement('div', { style: { fontSize: 10, color: '#4a6a88', fontFamily: FN, marginBottom: 8, fontStyle: 'italic' } },
                            'Foamer depth available after liquid accumulates'),

                      React.createElement(Sl, { label: 'Efficiency', value: draftPar.foam_efficiency || 70, min: 0, max: 100, step: 5, unit: '%', color: '#22d3ee',
                        onChange: function(v) { setD('foam_efficiency')(v); } }),

                      React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '5px 8px', marginBottom: 8, background: 'rgba(34,211,238,0.05)', border: '1px solid rgba(34,211,238,0.10)', borderRadius: 4, fontSize: 11, fontFamily: FN } },
                        React.createElement('span', { style: { color: '#0e8090' } }, '\u03C3 ' + _sigBase.toFixed(0) + ' \u2192 ' + _sigEff.toFixed(0) + ' dyn/cm'),
                        React.createElement('span', { style: { color: '#22d3ee', fontWeight: 700 } }, 'Treated: ' + Math.round(_fracTreated * 100) + '%')
                      ),

                      React.createElement('div', { style: { fontSize: 9, color: '#2a4a5a', fontFamily: FN, marginBottom: 8, fontStyle: 'italic' } },
                        'Contact time & mixing quality captured by efficiency'),

                      _active && _isShutIn
                        ? React.createElement('div', { style: { padding: '6px 8px', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: 4, fontSize: 10, color: '#22d3ee', fontFamily: FN } },
                            '\u2713 Treatment will be staged on Apply & Resume')
                        : null
                    )
                  );
                })()
              )
            ),

            // ── CALIBRATE tab ──
            configTab === 'cal' && React.createElement('div', null,
              React.createElement('div', { style:{ marginBottom:14 } },
                React.createElement('div', { style:{ fontSize:10, color:'#f0d060', fontFamily:FN, letterSpacing:'.12em', textTransform:'uppercase', marginBottom:6, fontWeight:700 } }, 'Steady-State Data'),
                React.createElement('div', { style:{ fontSize:9, color:'#2a4050', fontFamily:FN, marginBottom:6, lineHeight:1.5 } }, 'CSV columns: qG (MMscfd), WHP (psi), BHP (psi) — any order, comma or semicolon'),
                React.createElement('div', { style:{ display:'flex', gap:6, marginBottom:6 } },
                  React.createElement('label', { htmlFor:'cal-ss-input', style:{ flex:1, padding:'7px 0', textAlign:'center', background:'rgba(240,208,96,0.08)', border:'1px solid rgba(240,208,96,0.25)', borderRadius:4, color:'#f0d060', fontSize:11, fontWeight:700, fontFamily:FN, cursor:'pointer' } }, '\u2B06 Upload CSV'),
                  React.createElement('input', { id:'cal-ss-input', type:'file', accept:'.csv,.txt', style:{ display:'none' },
                    onChange: function(e) { var f=e.target.files[0]; if(!f) return; var r=new FileReader(); r.onload=function(ev){ var p2=parseCSV(ev.target.result); if(p2) setCalSteady(p2); }; r.readAsText(f); e.target.value=''; }
                  }),
                  calSteady && React.createElement('button', { onClick:function(){ setCalSteady(null); }, style:{ padding:'7px 10px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:4, color:'#4a6a88', fontSize:11, cursor:'pointer' } }, '\u00D7')
                ),
                calSteady && (function(){
                  var cols=calCols(calSteady.headers);
                  return React.createElement('div', null,
                    React.createElement('div', { style:{ fontSize:9, color:'#4ade80', fontFamily:FN, marginBottom:4 } }, calSteady.rows.length+' rows \u2022 qG:'+( cols.qG||'?')+' WHP:'+(cols.WHP||'?')+' BHP:'+(cols.BHP||'?')),
                    React.createElement('div', { style:{ background:'rgba(0,0,0,0.3)', borderRadius:4, padding:'4px 6px', fontSize:9, fontFamily:FN, color:'#4a6a88', maxHeight:72, overflowY:'auto' } },
                      calSteady.rows.slice(0,4).map(function(row,ri){ return React.createElement('div',{key:ri,style:{display:'flex',gap:8}},
                        cols.qG  && React.createElement('span',{style:{color:'#4ade80'}},(row[cols.qG]||0).toFixed(2)+' MMscfd'),
                        cols.WHP && React.createElement('span',{style:{color:'#fb923c'}},Math.round(row[cols.WHP]||0)+' psi WHP'),
                        cols.BHP && React.createElement('span',{style:{color:'#a78bfa'}},Math.round(row[cols.BHP]||0)+' psi BHP')); })
                    )
                  );
                })()
              ),
              React.createElement('div', { style:{ marginBottom:14 } },
                React.createElement('div', { style:{ fontSize:10, color:'#60a5fa', fontFamily:FN, letterSpacing:'.12em', textTransform:'uppercase', marginBottom:6, fontWeight:700 } }, 'Time-Domain Data'),
                React.createElement('div', { style:{ fontSize:9, color:'#2a4050', fontFamily:FN, marginBottom:6, lineHeight:1.5 } }, 'CSV columns: time (hr), qG (MMscfd), WHP (psi), BHP (psi)'),
                React.createElement('div', { style:{ display:'flex', gap:6, marginBottom:6 } },
                  React.createElement('label', { htmlFor:'cal-td-input', style:{ flex:1, padding:'7px 0', textAlign:'center', background:'rgba(96,165,250,0.08)', border:'1px solid rgba(96,165,250,0.25)', borderRadius:4, color:'#60a5fa', fontSize:11, fontWeight:700, fontFamily:FN, cursor:'pointer' } }, '\u2B06 Upload CSV'),
                  React.createElement('input', { id:'cal-td-input', type:'file', accept:'.csv,.txt', style:{ display:'none' },
                    onChange: function(e) { var f=e.target.files[0]; if(!f) return; var r=new FileReader(); r.onload=function(ev){ var p2=parseCSV(ev.target.result); if(p2) setCalTime(p2); }; r.readAsText(f); e.target.value=''; }
                  }),
                  calTime && React.createElement('button', { onClick:function(){ setCalTime(null); setCalTOff(0); }, style:{ padding:'7px 10px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:4, color:'#4a6a88', fontSize:11, cursor:'pointer' } }, '\u00D7')
                ),
                calTime && (function(){
                  var cols=calCols(calTime.headers);
                  return React.createElement('div', null,
                    React.createElement('div', { style:{ fontSize:9, color:'#60a5fa', fontFamily:FN, marginBottom:4 } }, calTime.rows.length+' rows \u2022 t:'+(cols.time||'?')+' qG:'+(cols.qG||'?')+' WHP:'+(cols.WHP||'?')),
                    React.createElement(Sl, { label:'Time offset', value:calTOff, min:-48, max:48, step:0.5, unit:'hr', color:'#60a5fa', onChange:function(v){ setCalTOff(v); } })
                  );
                })()
              ),
              React.createElement('div', { style:{ padding:'8px 10px', background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:4, fontSize:9, fontFamily:FN, lineHeight:2 } },
                React.createElement('div', {style:{color:'#f0d060',fontWeight:700}}, '\u25CF Yellow \u2014 WHP steady-state points on VLP'),
                React.createElement('div', {style:{color:'#a0c8ff'}}, '\u25A0 Blue squares \u2014 BHP steady-state points on IPR'),
                React.createElement('div', {style:{color:'#60a5fa'}}, '\u25CF Blue \u2014 WHP time-domain (right panel)'),
                React.createElement('div', {style:{color:'#4ade80'}}, '\u25CF Green \u2014 qG time-domain (right panel)')
              )
            )
          ),

          // RIGHT COLUMN — live IPR/VLP chart (hidden on mobile — too narrow to be useful)
          !mob && React.createElement('div', { style:{ flex:1, display:'flex', flexDirection:'column', padding:'14px 18px', overflow:'hidden', minWidth:0 } },

            // Header row: label + op point readout
            React.createElement('div', { style:{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, flexShrink:0 } },
              React.createElement('span', { style:{ fontSize:9, color:'#3a5a78', letterSpacing:'.16em', textTransform:'uppercase', fontWeight:700, fontFamily:FN } }, 'IPR / VLP — Live Preview'),
              draftOp && !draftOp.noFlow && React.createElement('span', { style:{ fontSize:13, color:'#4ade80', fontFamily:FN, fontWeight:700 } },
                (U&&U.get()==='si'
                  ? U.toSI(draftOp.q_op,'gasRate').toFixed(2)+' '+U.label('gasRate')+' @ '+Math.round(U.toSI(draftOp.pwf_op,'pressure'))+' '+U.label('pressure')
                  : draftOp.q_op.toFixed(2)+' MMscfd @ '+Math.round(draftOp.pwf_op)+' psi')),
              draftOp && draftOp.noFlow && React.createElement('span', { style:{ fontSize:13, color:'#f87171', fontFamily:FN, fontWeight:700 } }, '\u26A0 NO FLOW')
            ),

            // IPR/VLP chart — fills remaining vertical space
            React.createElement('div', { style:{ flex: configTab==='cal' && calTime ? '0 0 auto' : 1, minHeight: configTab==='cal' && calTime ? 280 : 0, position:'relative' } },
              React.createElement(C.IPRCh, {
                params: draftPar, curves: draftCurves, opPoint: draftOp,
                liveQ: 0, livePwf: 0, liveOp: null, hasLoadedVLP: false,
                width: 900, height: 600,
                axisScale: 2, crossScale: 3,
                // Calibration overlay: WHP dots on VLP (yellow circles), BHP dots on IPR (blue squares)
                calPoints: (function(){
                  if (!calSteady) return null;
                  var cols = calCols(calSteady.headers);
                  var pts2 = [];
                  calSteady.rows.forEach(function(row) {
                    var q = cols.qG  ? row[cols.qG]  : NaN;
                    if (!isFinite(q) || q <= 0) return;
                    if (cols.WHP && isFinite(row[cols.WHP])) pts2.push({ q: q, p: row[cols.WHP], color: '#f0d060', shape: 'circle' });
                    if (cols.BHP && isFinite(row[cols.BHP])) pts2.push({ q: q, p: row[cols.BHP], color: '#a0c8ff', shape: 'square' });
                  });
                  return pts2.length ? pts2 : null;
                })()
              })
            ),

            // CALIBRATE tab: time-domain comparison chart
            configTab === 'cal' && calTime && (function(){
              var cols = calCols(calTime.headers);
              if (!cols.time) return null;
              var W2 = 860, H2 = 160, PL2 = 48, PR2 = 8, PT2 = 12, PB2 = 22;
              var cW2 = W2-PL2-PR2, cH2 = H2-PT2-PB2;

              // Gather calibration time series
              var calQpts = [], calWHPpts = [];
              calTime.rows.forEach(function(row) {
                var t = row[cols.time] + calTOff;
                if (!isFinite(t)) return;
                if (cols.qG  && isFinite(row[cols.qG]))  calQpts.push({t:t, v:row[cols.qG]});
                if (cols.WHP && isFinite(row[cols.WHP])) calWHPpts.push({t:t, v:row[cols.WHP]});
              });

              // Sim history
              var simQ   = gasH  || [];
              var simWHP = whpH  || [];

              var allT = calQpts.map(function(d){return d.t;}).concat(calWHPpts.map(function(d){return d.t;})).concat(simQ.map(function(d){return d.t;}));
              var tMax2 = allT.length ? Math.max.apply(null, allT) : 1;
              var allQv = calQpts.map(function(d){return d.v;}).concat(simQ.map(function(d){return d.v;}));
              var allPv = calWHPpts.map(function(d){return d.v;}).concat(simWHP.map(function(d){return d.v;}));
              var qMax2 = allQv.length ? Math.max.apply(null, allQv) * 1.15 : 1;
              var pMax2 = allPv.length ? Math.max.apply(null, allPv) * 1.15 : 1;

              var tx = function(t) { return PL2 + (t / Math.max(tMax2,0.001)) * cW2; };
              var qy = function(v) { return PT2 + cH2 - (v / Math.max(qMax2,0.001)) * cH2; };
              var py2= function(v) { return PT2 + cH2 - (v / Math.max(pMax2,0.001)) * cH2; };

              var simQpath  = simQ.map(function(d,i){ return (i===0?'M':'L')+tx(d.t).toFixed(1)+','+qy(d.v).toFixed(1); }).join(' ');
              var simPpath  = simWHP.map(function(d,i){ return (i===0?'M':'L')+tx(d.t).toFixed(1)+','+py2(d.v).toFixed(1); }).join(' ');

              return React.createElement('div', { style:{ flexShrink:0, marginTop:8 } },
                React.createElement('div', { style:{ fontSize:9, color:'#3a5a78', fontFamily:FN, letterSpacing:'.12em', textTransform:'uppercase', marginBottom:4 } }, 'Time Domain Comparison'),
                React.createElement('svg', { viewBox:'0 0 '+W2+' '+(H2+8), style:{ display:'block', width:'100%', height:'auto' } },
                  // Background
                  React.createElement('rect', { x:PL2, y:PT2, width:cW2, height:cH2, fill:'#060e1c', stroke:'#1a3050', strokeWidth:1 }),
                  // Grid lines
                  [0.25,0.5,0.75].map(function(f, gi) {
                    var xt = tx(tMax2*f);
                    return React.createElement('line', { key:'tg'+gi, x1:xt, y1:PT2, x2:xt, y2:PT2+cH2, stroke:'rgba(30,56,88,0.5)', strokeWidth:0.5 });
                  }),
                  // Sim qG line (green)
                  simQpath && React.createElement('path', { d:simQpath, fill:'none', stroke:'#4ade80', strokeWidth:1.2, opacity:0.7 }),
                  // Sim WHP line (orange)
                  simPpath && React.createElement('path', { d:simPpath, fill:'none', stroke:'#fb923c', strokeWidth:1.2, opacity:0.7, strokeDasharray:'4,2' }),
                  // Cal qG dots (green)
                  calQpts.map(function(d,i){ return React.createElement('circle',{key:'cq'+i, cx:tx(d.t), cy:qy(d.v), r:2.5, fill:'#4ade80', stroke:'rgba(0,0,0,0.5)', strokeWidth:0.5, opacity:0.9}); }),
                  // Cal WHP dots (blue)
                  calWHPpts.map(function(d,i){ return React.createElement('circle',{key:'cp'+i, cx:tx(d.t), cy:py2(d.v), r:2.5, fill:'#60a5fa', stroke:'rgba(0,0,0,0.5)', strokeWidth:0.5, opacity:0.9}); }),
                  // X axis ticks
                  [0.25,0.5,0.75,1].map(function(f,ti){
                    var xt=tx(tMax2*f), tv=(tMax2*f).toFixed(1);
                    return React.createElement('text',{key:'xt'+ti,x:xt,y:PT2+cH2+10,textAnchor:'middle',fill:'#2a4a60',fontSize:6,fontFamily:FN},tv+'h');
                  }),
                  // Y labels (left = qG, right = P)
                  React.createElement('text',{key:'yql',x:PL2-3,y:PT2+4,textAnchor:'end',fill:'#4ade80',fontSize:5.5,fontFamily:FN},qMax2.toFixed(1)),
                  React.createElement('text',{key:'ypl',x:W2-PR2+3,y:PT2+4,textAnchor:'start',fill:'#fb923c',fontSize:5.5,fontFamily:FN},Math.round(pMax2)),
                  // Legend
                  React.createElement('line',{x1:PL2,y1:PT2+cH2+20,x2:PL2+10,y2:PT2+cH2+20,stroke:'#4ade80',strokeWidth:1.2}),
                  React.createElement('text',{x:PL2+12,y:PT2+cH2+23,fill:'#4ade80',fontSize:5.5,fontFamily:FN},'qG model'),
                  React.createElement('circle',{cx:PL2+40,cy:PT2+cH2+20,r:2.5,fill:'#4ade80'}),
                  React.createElement('text',{x:PL2+44,y:PT2+cH2+23,fill:'#4ade80',fontSize:5.5,fontFamily:FN},'qG Ledaflow'),
                  React.createElement('line',{x1:PL2+80,y1:PT2+cH2+20,x2:PL2+90,y2:PT2+cH2+20,stroke:'#fb923c',strokeWidth:1.2,strokeDasharray:'4,2'}),
                  React.createElement('text',{x:PL2+92,y:PT2+cH2+23,fill:'#fb923c',fontSize:5.5,fontFamily:FN},'WHP model'),
                  React.createElement('circle',{cx:PL2+124,cy:PT2+cH2+20,r:2.5,fill:'#60a5fa'}),
                  React.createElement('text',{x:PL2+128,y:PT2+cH2+23,fill:'#60a5fa',fontSize:5.5,fontFamily:FN},'WHP Ledaflow')
                )
              );
            })(),

            // FLUIDS tab extra: fluid property readout
            configTab === 'fluids' && React.createElement('div', { style:{ flexShrink:0, marginTop:10, padding:'8px 10px', background:'rgba(56,189,248,0.05)', border:'1px solid rgba(56,189,248,0.12)', borderRadius:5 } },
              (function(){
                var wp = M.waterProps(draftPar.T_surf, draftPar.salinity||0);
                var lp2 = M.liquidProps(draftPar);
                var inSI = U && U.get()==='si';
                return React.createElement('div', { style:{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'4px 12px', fontSize:11, fontFamily:FN, color:'#38bdf8' } },
                  React.createElement('span', null, '\u03C1\u2097 = '+(inSI?U.toSI(lp2.rL,'density').toFixed(1)+' kg/m\u00B3':lp2.rL.toFixed(1)+' lb/ft\u00B3')),
                  React.createElement('span', null, '\u03BC\u2097 = '+lp2.muL.toFixed(2)+' cp'),
                  React.createElement('span', null, '\u03C3 = '+lp2.sig.toFixed(0)+' dyn/cm'),
                  React.createElement('span', null, '\u03C1\u1D64 = '+(inSI?U.toSI(wp.rhoW,'density').toFixed(1)+' kg/m\u00B3':wp.rhoW.toFixed(1)+' lb/ft\u00B3')),
                  React.createElement('span', null, '\u03BC\u1D64 = '+wp.muW.toFixed(2)+' cp'),
                  React.createElement('span', null, '\u03C3\u1D64 = '+wp.sigW.toFixed(0)+' dyn/cm')
                );
              })()
            ),

            // LIFT tab extra: Turner velocity summary with foam effect
            configTab === 'lift' && React.createElement('div', { style:{ flexShrink:0, marginTop:10, padding:'8px 10px', background:'rgba(34,211,238,0.04)', border:'1px solid rgba(34,211,238,0.14)', borderRadius:5 } },
              (function(){
                // σ with foam applied to draftPar (includes efficiency)
                var lp2 = M.liquidProps(Object.assign({}, draftPar, {
                  foam_type: (draftPar.foam_batch_active && (draftPar.foam_batch_conc || 0) > 0) ? 'anionic' : '',
                  foam_batch_conc: draftPar.foam_batch_conc || 0.10,
                  foam_efficiency: draftPar.foam_efficiency || 70
                }));
                var TR_mid = draftPar.T_surf + (draftPar.geo_grad/100) * (draftPar.TD*0.5) + 459.67;
                var P_mid  = Math.max(draftPar.Pr * 0.4, 100);
                var rG2    = M.gasDen(P_mid, TR_mid, draftPar.sg);
                var vT     = 5.62 * Math.pow(Math.max(lp2.sig,0.1) * Math.max(lp2.rL-rG2,0.1) / Math.max(rG2*rG2,0.001), 0.25);
                var qT_mmscfd = (function(){
                  var D_ft = draftPar.id_in/12; var Ap = Math.PI*(D_ft/2)*(D_ft/2);
                  var Z_t  = M.papayZ ? M.papayZ(P_mid, TR_mid, draftPar.sg) : 0.9;
                  return vT * Ap * (P_mid/14.7) * (520/TR_mid) / Z_t * 86400 / 1e6;
                })();
                var _Ap_bf = Math.PI * Math.pow(draftPar.id_in/24, 2);
                var _liqColH2 = (tsRef.current.Vliq||0) * 5.615 / Math.max(_Ap_bf, 0.001);
                var _liqTop2  = Math.max(0, draftPar.TD - _liqColH2);
                var _depthV2  = Math.max(_liqTop2, draftPar.foam_depth_ft > 0 ? draftPar.foam_depth_ft : draftPar.TD);
                var _frac2    = _liqColH2 > 0.1 ? Math.min(1, (_depthV2 - _liqTop2) / _liqColH2) : 0;
                var tr2    = draftOp && !draftOp.noFlow ? draftOp.q_op / Math.max(qT_mmscfd, 0.001) : 0;
                var trColor = tr2 > 1.2 ? '#4ade80' : tr2 > 0.8 ? '#fbbf24' : '#f87171';
                return React.createElement('div', { style:{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'5px 12px', fontSize:11, fontFamily:FN } },
                  React.createElement('span', { style:{color:'#22d3ee'} }, '\u03C3\u2091\u2092\u2092 = '+lp2.sig.toFixed(0)+' dyn/cm'),
                  React.createElement('span', { style:{color:'#22d3ee'} }, 'vT = '+vT.toFixed(2)+' ft/s'),
                  React.createElement('span', { style:{color:trColor, fontWeight:700} }, 'qT = '+qT_mmscfd.toFixed(2)+' MMscfd'),
                  React.createElement('span', { style:{color:'#5a8aaa'} }, '\u03C1\u2097 = '+lp2.rL.toFixed(1)+' lb/ft\u00B3'),
                  React.createElement('span', { style:{color:'#5a8aaa'} }, 'Treated: '+Math.round(_frac2*100)+'%'),
                  React.createElement('span', { style:{color:trColor, fontWeight:700} }, 'TR = '+(draftOp&&!draftOp.noFlow?tr2.toFixed(2):'—'))
                );
              })()
            )
          )
        ),

        // ── Footer: Save input (left) + Cancel / Apply (right) ──
        React.createElement('div', { style:{ padding: mob ? '8px 12px' : '10px 18px', borderTop:'1px solid rgba(255,255,255,0.07)', flexShrink:0, display:'flex', flexDirection: mob ? 'column' : 'row', alignItems: mob ? 'stretch' : 'center', justifyContent:'space-between', gap: mob ? 6 : 10, background:'#07101c' } },
          React.createElement('div', { style:{ display:'flex', alignItems:'center', gap:6, flex: mob ? '0 0 auto' : 1, minWidth:0 } },
            React.createElement('input', {
              type:'text', placeholder:'Save case as\u2026', value: saveName,
              onChange: function(e) { setSaveName(e.target.value); },
              onKeyDown: function(e) { if (e.key === 'Enter' && saveName.trim()) { setCases(lsSave(saveName.trim(), draftPar)); setSaveName(''); } },
              style:{ flex:1, minWidth:0, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:5, color:'#aac8d8', fontSize:12, fontFamily:FN, padding:'7px 10px', outline:'none' }
            }),
            React.createElement('button', {
              onClick: function() { if (saveName.trim()) { setCases(lsSave(saveName.trim(), draftPar)); setSaveName(''); } },
              style:{ padding:'7px 13px', flexShrink:0, background: saveName.trim() ? 'rgba(56,189,248,0.15)' : 'rgba(56,189,248,0.04)', border:'1px solid ' + (saveName.trim() ? 'rgba(56,189,248,0.40)' : 'rgba(56,189,248,0.12)'), borderRadius:5, color: saveName.trim() ? '#38bdf8' : '#1a3a50', fontSize:12, fontWeight:700, cursor: saveName.trim() ? 'pointer' : 'default', fontFamily:FN }
            }, '\ud83d\udcbe Save')
          ),
          React.createElement('div', { style:{ display:'flex', gap:8, flexShrink:0, justifyContent: mob ? 'flex-end' : 'initial' } },
            React.createElement('button', { onClick:cancelEdit, style:{ padding:'9px 22px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.09)', borderRadius:5, color:'#4a6a88', fontSize:13, fontWeight:700, cursor:'pointer' } }, 'Cancel'),
            React.createElement('button', { onClick:applyEdit, style:{ padding:'9px 28px', background:'rgba(74,222,128,0.10)', border:'1.5px solid rgba(74,222,128,0.35)', borderRadius:5, color:'#4ade80', fontSize:13, fontWeight:800, cursor:'pointer' } }, mode==='static' ? '\u2713 Apply' : '\u2713 Apply & Resume')
          )
        )
      )
    ),

      // CENTER PANEL
      React.createElement('div', { style: { flex: mob ? '0 0 auto' : '1 1 50%', width: mob ? '100%' : undefined, minWidth: 0, overflowY: mob ? 'visible' : 'auto', overflowX: 'hidden', padding: '8px 10px', boxSizing: 'border-box' } },
        !mob && React.createElement('div', { style: { marginBottom: 6 } },
          React.createElement(C.SurfPID, { mode: mode, gasRate: isFlow ? (liveR ? liveR.gasRate : fp.qGmmscfd) : 0, condRate: isFlow ? (liveR ? liveR.condRate : fp.condBpd) : 0, waterRate: isFlow ? (liveR ? liveR.waterRate : fp.waterBpd) : 0, whp: Math.round(WHP), psep: par.P_sep, choke64: par.choke_64, fillFrac: liqVolEst / Math.max(Vwb2, 1) })
        ),
        React.createElement('div', { style: { display: 'flex', gap: 6, maxHeight: mob ? 260 : undefined, overflow: mob ? 'hidden' : undefined } },
          React.createElement('div', { style: { flexShrink: 0, display: 'flex', gap: 4, alignSelf: 'stretch' } },
            React.createElement('div', { style: { width: mob ? 30 : 46, flexShrink: 0, position: 'relative' } }, [0, 0.25, 0.5, 0.75, 1].map(function(f) { return React.createElement('div', { key: f, style: { position: 'absolute', top: (f * 100) + '%', transform: 'translateY(-50%)', fontSize: mob ? 9 : 14, color: '#5a7a98', fontFamily: FN, textAlign: 'right', width: mob ? 28 : 44, fontWeight: 500 } }, Math.round(f * par.TD)); })),
            React.createElement('canvas', { ref: cRef, style: { width: CW, flex: 1, display: 'block', borderRadius: 2, border: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 } }),
            React.createElement('div', { style: { width: mob ? 60 : 90, flexShrink: 0, position: 'relative', fontFamily: FN } }, dp.segs.filter(function(_, i) { return i % (mob ? 10 : 6) === 0; }).map(function(s, idx) { var k = mode === 'shutin' ? s.siPhase : s.regime; var pct = dp.segs.length > 1 ? (s.depth / (dp.segs[dp.segs.length - 1].depth || 1)) * 100 : 0; return React.createElement('div', { key: idx, style: { position: 'absolute', top: pct + '%', transform: 'translateY(-50%)', left: 0 } }, React.createElement('span', { style: { color: RCOL[k] || '#475569', fontWeight: 700, fontSize: mob ? 11 : 17 } }, (k || '').toUpperCase().slice(0, 5)), React.createElement('br'), React.createElement('span', { style: { fontSize: mob ? 10 : 16, color: '#4a6a88' } }, 'HL ' + ((s.HL || 0) * 100).toFixed(0) + '%')); })),
            !mob && React.createElement(C.ChartWithCrosshair, null,
              React.createElement(C.PressProfileChart, { segs: dp.segs, TD: par.TD, Pr: par.Pr, Psep: par.P_sep, width: 130, height: 420 })
            )
          ),
          mob && React.createElement('button', {
            onClick: function() { setShowCharts(function(v) { return !v; }); },
            style: { margin:'4px 0 6px', padding:'6px 14px', background:'rgba(74,110,136,0.12)', border:'1px solid rgba(74,110,136,0.25)', borderRadius:5, color:'#4a7a9a', fontSize:11, fontWeight:700, fontFamily:FN, cursor:'pointer', alignSelf:'flex-start' }
          }, showCharts ? '\u25B2 Hide Charts' : '\u25BC Show Charts'),
          (!mob || showCharts) && React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
            React.createElement(CBox, { onClick: function() { setExpanded('gas'); } }, React.createElement(C.ChartWithCrosshair, null, React.createElement(C.LnC, { history: gasH, color: '#4ade80', title: 'GAS RATE', maxV: Math.max(1, (op && !op.noFlow ? op.q_op : 1) * 1.5), fmt: function(v) { return (U && U.get()==='si' ? U.toSI(v,'gasRate').toFixed(2)+' '+U.label('gasRate') : v.toFixed(2)+' MMscfd'); }, width: 480, height: 78 }))),
            React.createElement(CBox, { onClick: function() { setExpanded('press'); } }, React.createElement(C.ChartWithCrosshair, null, React.createElement(C.PressChart, { whpHistory: whpH, bhpHistory: bhpH, Pr: par.Pr, Psep: par.P_sep, width: 480, height: 100 }))),
            React.createElement(CBox, { onClick: function() { setExpanded('ipr'); } }, React.createElement(C.IPRCh, { params: par, curves: displayCurves, opPoint: op, liveQ: isFlow && !hasLoadedVLP ? (liveR ? liveR.gasRate : fp.qGmmscfd) : 0, livePwf: isFlow && !hasLoadedVLP ? fp.Pwf : 0, liveOp: hasLoadedVLP ? liveOp : null, hasLoadedVLP: hasLoadedVLP, width: 480, height: 150 }))
          )
        )
      ),

      // RIGHT PANEL
      React.createElement('div', { style: { flex: mob ? '0 0 auto' : '0 0 24%', width: mob ? '100%' : undefined, minWidth: mob ? 0 : 155, maxWidth: mob ? 'none' : 250, borderLeft: mob ? 'none' : '1px solid rgba(255,255,255,0.05)', borderBottom: mob ? '1px solid rgba(255,255,255,0.06)' : 'none', padding: '8px 10px', overflowY: mob ? 'visible' : 'auto', boxSizing: 'border-box' } },

        React.createElement('div', { style: { visibility: (mode === 'flowing' || mode === 'loading') ? 'visible' : 'hidden', background: 'rgba(12,24,40,0.6)', border: '1px solid rgba(74,110,136,0.2)', borderRadius: 5, padding: '8px 10px', marginBottom: 8 } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
            React.createElement('span', { style: { fontSize: 12, color: fillColor, fontFamily: FN, fontWeight: 700, transition: 'color 1s' } }, 'WELLBORE'),
            React.createElement('span', { style: { fontSize: 14, color: fillColor, fontFamily: FN, fontWeight: 700, transition: 'color 1s' } }, fillPct.toFixed(0) + '%')
          ),
          React.createElement('div', { style: { height: 8, background: '#0c1828', borderRadius: 4 } },
            React.createElement('div', { style: { height: '100%', width: Math.min(fillPct, 100) + '%', background: fillColor, borderRadius: 4, transition: 'width .5s, background 1s' } })
          ),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 4 } },
            React.createElement('span', { style: { fontSize: 10, color: '#4a6a88', fontFamily: FN } },
              (U && U.get()==='si'
                ? U.toSI(liqVolEst,'inventory').toFixed(1) + ' / ' + U.toSI(Vwb2,'inventory').toFixed(1) + ' m\u00B3'
                : liqVolEst.toFixed(0) + ' / ' + Vwb2.toFixed(0) + ' bbl')),
            React.createElement('span', { style: { fontSize: 10, color: '#4a6a88', fontFamily: FN } }, shR.current < 48 ? shR.current.toFixed(1) + 'hr' : (shR.current / 24).toFixed(1) + 'd')
          )
        ),

        React.createElement(Sec, { title: 'Production', color: '#4ade80' },
          React.createElement('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'baseline', padding:'3px 0', marginBottom:2, borderBottom:'1px solid rgba(255,255,255,0.025)' } },
            React.createElement('span', { style:{ fontSize:13, color:'#4a6a88', fontFamily:FN } }, 'qT Turner'),
            React.createElement('span', { style:{ fontSize:16, fontWeight:700, color:qTCol, fontFamily:FN, whiteSpace:'nowrap' } },
              qT_display.toFixed(2),
              React.createElement('span', { style:{ fontSize:11, opacity:0.5, marginLeft:2 } }, 'MMscfd')
            )
          ),
          React.createElement(Ch, { label: 'Gas', value: isFlow ? (liveR ? liveR.gasRate : fp.qGmmscfd) : 0, unit: 'MMscfd', kind: 'gasRate', decimals: 2, color: '#4ade80' }),
          React.createElement(Ch, { label: 'Water', value: isFlow ? (liveR ? liveR.waterRate : fp.waterBpd) : 0, unit: 'bpd', kind: 'liqRate', decimals: 0, color: '#60a5fa' }),
          React.createElement(Ch, { label: 'Cond', value: isFlow ? (liveR ? liveR.condRate : fp.condBpd) : 0, unit: 'bpd', kind: 'liqRate', decimals: 0, color: '#fde047' })
        ),

        React.createElement(Sec, { title: 'Pressures', color: '#fb923c' },
          React.createElement(Ch, { label: 'WHP', value: WHP, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fb923c' }),
          React.createElement(Ch, { label: 'BHP', value: BHP, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fbbf24' }),
          React.createElement(Ch, { label: 'Pr', value: par.Pr, unit: 'psi', kind: 'pressure', decimals: 0, color: '#4ade80' }),
          React.createElement(Ch, { label: 'dP choke', value: isFlow ? Math.max(0, WHP - (par.P_sep || 250)) : 0, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fb923c' })
        ),

        React.createElement(Sec, { title: 'Regime', color: '#a3e635' },
          ['annular','slug','churn','bubble','static','gas_zone','segregating','liquid_zone'].map(function(r) {
            var pct = (rC[r] || 0) / rT * 100;
            var col = RCOL[r] || '#64748b';
            return React.createElement('div', { key: r, style: { marginBottom: 3, visibility: pct >= 1 ? 'visible' : 'hidden', height: pct >= 1 ? 'auto' : 0, overflow: 'hidden' } },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
                React.createElement('span', { style: { fontSize: 14, color: col, fontWeight: 700 } }, r.toUpperCase()),
                React.createElement('span', { style: { fontSize: 14, fontFamily: FN, color: '#4a6a88' } }, pct.toFixed(0) + '%')
              ),
              React.createElement('div', { style: { height: 4, background: '#0c1828', borderRadius: 2 } },
                React.createElement('div', { style: { height: '100%', width: pct + '%', background: col, borderRadius: 2, opacity: 0.6, transition: 'width 1s' } })
              )
            );
          })
        ),

        React.createElement('div', { style: { visibility: mode === 'shutin' ? 'visible' : 'hidden', height: mode === 'shutin' ? 'auto' : 0, overflow: 'hidden' } },
          React.createElement(Sec, { title: 'Shut-In', color: '#f87171' },
            React.createElement(Ch, { label: 'BHP', value: BHP, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fbbf24' }),
            React.createElement(Ch, { label: 'WHP', value: WHP, unit: 'psi', kind: 'pressure', decimals: 0, color: '#fb923c' }),
            React.createElement(Ch, { label: 'Elapsed', value: shR.current < 1 ? Math.round(shR.current * 60) + 'min' : shR.current < 48 ? shR.current.toFixed(1) + 'hr' : (shR.current / 24).toFixed(1) + 'd', color: '#94a3b8' })
          )
        ),

        React.createElement(Sec, { title: 'Liquid Balance', color: '#38bdf8', open: true },
          React.createElement(Ch, { label: 'Inventory', value: liqVolEst, unit: 'bbl', kind: 'inventory', decimals: 1, color: '#38bdf8' }),
          React.createElement(Ch, { label: 'Fill', value: fillPct.toFixed(0), unit: '%', color: fillColor }),
          React.createElement(Ch, { label: 'Liq In', value: (sd.qLiqIn || 0), unit: 'bpd', kind: 'liqRate', decimals: 0, color: '#60a5fa' }),
          React.createElement(Ch, { label: 'Liq Out', value: (sd.qLiqOut || 0), unit: 'bpd', kind: 'liqRate', decimals: 0, color: '#4ade80' }),
          React.createElement(Ch, { label: 'Carry', value: ((sd.carryFrac || 0) * 100).toFixed(0), unit: '%', color: (sd.carryFrac || 0) > 0.8 ? '#4ade80' : (sd.carryFrac || 0) > 0.5 ? '#fbbf24' : '#f87171' }),
          React.createElement(Ch, { label: 'State', value: stLabel, color: mC })
        ),

        React.createElement(Sec, { title: 'Gray', open: false, color: '#5a8aaa' },
          [['Ngv', ((fp.segs[0] || {}).Ngv || 0).toFixed(2)], ['Ku', ((fp.segs[0] || {}).KuG || 0).toFixed(3)], ['C0', ((fp.segs[0] || {}).C0 || 0).toFixed(2)], ['Vd', ((fp.segs[0] || {}).Vd || 0).toFixed(2)]].map(function(e) { return React.createElement(Ch, { key: e[0], label: e[0], value: e[1], color: '#5a8aaa' }); })
        )
      )
    ),

    // CHART MODALS
    React.createElement(Modal, { open: expanded === 'gas', title: 'Gas Rate vs Time', onClose: function() { setExpanded(null); } },
      React.createElement(C.ChartWithCrosshair, null, React.createElement(C.LnC, { history: gasH, color: '#4ade80', title: 'GAS RATE', maxV: Math.max(1, (op && !op.noFlow ? op.q_op : 1) * 1.5), fmt: function(v) { return (U && U.get()==='si' ? U.toSI(v,'gasRate').toFixed(2)+' '+U.label('gasRate') : v.toFixed(2)+' MMscfd'); }, width: 1920, height: 900 }))
    ),
    React.createElement(Modal, { open: expanded === 'press', title: 'WHP / BHP vs Time', onClose: function() { setExpanded(null); } },
      React.createElement(C.ChartWithCrosshair, null, React.createElement(C.PressChart, { whpHistory: whpH, bhpHistory: bhpH, Pr: par.Pr, Psep: par.P_sep, width: 1920, height: 900 }))
    ),
    React.createElement(Modal, { open: expanded === 'ipr', title: 'IPR / VLP Nodal Analysis', onClose: function() { setExpanded(null); } },
      React.createElement(C.IPRCh, { params: par, curves: displayCurves, opPoint: op, liveQ: isFlow && !hasLoadedVLP ? (liveR ? liveR.gasRate : fp.qGmmscfd) : 0, livePwf: isFlow && !hasLoadedVLP ? fp.Pwf : 0, liveOp: hasLoadedVLP ? liveOp : null, hasLoadedVLP: hasLoadedVLP, width: 1920, height: 900,
        calPoints: (function(){
          if (!calSteady) return null;
          var cols = calCols(calSteady.headers); var pts3 = [];
          calSteady.rows.forEach(function(row) {
            var q = cols.qG ? row[cols.qG] : NaN; if (!isFinite(q) || q <= 0) return;
            if (cols.WHP && isFinite(row[cols.WHP])) pts3.push({ q:q, p:row[cols.WHP], color:'#f0d060', shape:'circle' });
            if (cols.BHP && isFinite(row[cols.BHP])) pts3.push({ q:q, p:row[cols.BHP], color:'#a0c8ff', shape:'square' });
          });
          return pts3.length ? pts3 : null;
        })()
      })
    )
  );
}

// Mount
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));