// =======================================================
// WELLMODEL.APP — CHARTS  (charts.js)
// Depends on: React (global), WM_Charts exports
// =======================================================

var FN = 'IBM Plex Mono, monospace';

// v3.4.7: small unit helpers — read window.WM.units if available.
// Charts internally hold Imperial values; these helpers convert to whatever
// the user's display system is.  Defined as plain functions (not React
// hooks) because charts re-render whenever parent re-renders, which is
// triggered by the App-level useUnitSys hook.
function _U()         { return (window.WM && window.WM.units) ? window.WM.units : null; }
function _isSI()      { var u = _U(); return u && u.get() === 'si'; }
function _vP(psi)     { var u = _U(); return _isSI() ? u.toSI(psi, 'pressure') : psi; }
function _vQg(mmscfd) { var u = _U(); return _isSI() ? u.toSI(mmscfd, 'gasRate') : mmscfd; }
function _vD(ft)      { var u = _U(); return _isSI() ? u.toSI(ft, 'depth') : ft; }
function _lP()        { return _isSI() ? 'bar' : 'psi'; }
function _lPa()       { return _isSI() ? 'bara' : 'psia'; }
function _lQg()       { var u = _U(); return _isSI() ? u.label('gasRate') : 'MMscfd'; }
function _lD()        { return _isSI() ? 'm' : 'ft'; }

// -------------------------------------------------------
// ChartWithCrosshair — mouse wrapper
// Passes crossX/crossY [0,1] to child via React.cloneElement
// -------------------------------------------------------
function ChartWithCrosshair(props) {
  var _mx = React.useState(null); var mx = _mx[0], setMx = _mx[1];
  var _my = React.useState(null); var my = _my[0], setMy = _my[1];
  var ref = React.useRef(null);
  var onMove = function(e) {
    var r = ref.current; if (!r) return;
    var rect = r.getBoundingClientRect();
    setMx((e.clientX - rect.left) / rect.width);
    setMy((e.clientY - rect.top) / rect.height);
  };
  var onLeave = function() { setMx(null); setMy(null); };
  var child = props.children;
  if (mx !== null && child) child = React.cloneElement(child, { crossX: mx, crossY: my });
  return React.createElement('div', { ref: ref, onMouseMove: onMove, onMouseLeave: onLeave,
    style: { position: 'relative', cursor: 'crosshair' } }, child);
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function interpHistory(h, frac) {
  if (!h || h.length < 2) return null;
  var t0 = h[0].t, tEnd = h[h.length - 1].t;
  var tT = t0 + frac * (tEnd - t0);
  var lo = 0, hi = h.length - 1;
  while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (h[mid].t < tT) lo = mid; else hi = mid; }
  var dt = h[hi].t - h[lo].t;
  if (dt < 1e-12) return { t: h[lo].t, val: h[lo].val };
  var f = Math.max(0, Math.min(1, (tT - h[lo].t) / dt));
  return { t: tT, val: h[lo].val + f * (h[hi].val - h[lo].val) };
}

function fmtCrossTime(t, t0) {
  var dt = t - t0;
  if (dt < 1) return Math.round(dt * 60) + 'min';
  if (dt < 48) return dt.toFixed(1) + 'hr';
  return (dt / 24).toFixed(1) + 'd';
}

function computeTimeTicks(t0, tEnd, nMax) {
  var span = tEnd - t0;
  if (span < 0.001) return { ticks: [t0], fmt: function() { return '0'; }, unit: 'hr' };
  var unit, niceTicks;
  if (span <= 1.5) {
    unit = 'min';
    var spanMin = span * 60;
    var rawStep = spanMin / Math.max(nMax, 2);
    var steps = [0.5, 1, 2, 5, 10, 15, 20, 30, 60];
    var step = steps[0];
    for (var si = 0; si < steps.length; si++) { if (steps[si] >= rawStep) { step = steps[si]; break; } }
    niceTicks = [];
    var firstTick = Math.ceil(t0 * 60 / step) * step / 60;
    for (var tv = firstTick; tv <= tEnd + step / 120; tv += step / 60) {
      if (tv >= t0 - 0.001 && tv <= tEnd + 0.001) niceTicks.push(tv);
    }
    return { ticks: niceTicks, fmt: function(t) { var m = (t - t0) * 60; return m < 1 ? Math.round(m * 60) + 's' : Math.round(m) + 'm'; }, unit: 'min' };
  } else if (span <= 72) {
    unit = 'hr';
    var rawStepH = span / Math.max(nMax, 2);
    var stepsH = [0.5, 1, 2, 3, 6, 12, 24, 48, 72];
    var stepH = stepsH[0];
    for (var si2 = 0; si2 < stepsH.length; si2++) { if (stepsH[si2] >= rawStepH) { stepH = stepsH[si2]; break; } }
    niceTicks = [];
    var firstTickH = Math.ceil(t0 / stepH) * stepH;
    for (var tv2 = firstTickH; tv2 <= tEnd + stepH / 2; tv2 += stepH) {
      if (tv2 >= t0 - 0.001 && tv2 <= tEnd + 0.001) niceTicks.push(tv2);
    }
    return { ticks: niceTicks, fmt: function(t) { var h = t - t0; return h < 1 ? Math.round(h * 60) + 'm' : h < 10 ? h.toFixed(1) : Math.round(h); }, unit: 'hr' };
  } else {
    unit = 'd';
    var spanD = span / 24;
    var rawStepD = spanD / Math.max(nMax, 2);
    var stepsD = [0.25, 0.5, 1, 2, 5, 7, 10, 14, 30];
    var stepD = stepsD[0];
    for (var si3 = 0; si3 < stepsD.length; si3++) { if (stepsD[si3] >= rawStepD) { stepD = stepsD[si3]; break; } }
    niceTicks = [];
    var firstTickD = Math.ceil(t0 / 24 / stepD) * stepD * 24;
    for (var tv3 = firstTickD; tv3 <= tEnd + stepD * 12; tv3 += stepD * 24) {
      if (tv3 >= t0 - 0.001 && tv3 <= tEnd + 0.001) niceTicks.push(tv3);
    }
    return { ticks: niceTicks, fmt: function(t) { var d = (t - t0) / 24; return d < 1 ? (t - t0).toFixed(0) + 'h' : d.toFixed(1); }, unit: 'd' };
  }
}

// -------------------------------------------------------
// LnC — single-series line chart with crosshair
// -------------------------------------------------------
function LnC(props) {
  var h = props.history, c = props.color || '#4ade80';
  var W = props.width || 480, H = props.height || 80;
  var isModal = H > 200;
  var PL = 42, PR = 8, PT = 12, PB = isModal ? 22 : 16;
  var cW = W - PL - PR, cH = H - PT - PB;

  if (!h || h.length < 2) {
    return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H,
      style: { display: 'block', width: '100%', height: 'auto' } },
      React.createElement('rect', { x: PL, y: PT, width: cW, height: cH, rx: 2, fill: '#060e1c', stroke: '#1a3050', strokeWidth: 1 }),
      React.createElement('text', { x: W / 2, y: H / 2, textAnchor: 'middle', fill: '#1e3050', fontSize: 8, fontFamily: FN }, 'Play to record'));
  }

  var maxV = props.maxV || 1;
  h.forEach(function(p) { if (p.val > maxV) maxV = p.val; });
  if (props.refVal && props.refVal > maxV) maxV = props.refVal * 1.05;
  var t0 = h[0].t, tEnd = h[h.length - 1].t, ts = Math.max(tEnd - t0, 0.01);
  var px = function(t) { return PL + ((t - t0) / ts) * cW; };
  var py = function(v) { return PT + cH - (v / maxV) * cH; };

  var path = '';
  h.forEach(function(p, i) { path += (i === 0 ? 'M' : 'L') + px(p.t).toFixed(1) + ',' + py(p.val).toFixed(1); });
  var last = h[h.length - 1];
  var nTicks = isModal ? 8 : 4;
  var timeTicks = computeTimeTicks(t0, tEnd, nTicks);

  var els = [];
  els.push(React.createElement('rect', { key: 'bg', x: PL, y: PT, width: cW, height: cH, rx: 2, fill: '#060e1c', stroke: '#1a3050', strokeWidth: 1 }));

  // Y ticks
  var nY = isModal ? 4 : 2;
  for (var yi = 1; yi <= nY; yi++) {
    var yv = maxV * yi / (nY + 1), yy = py(yv);
    els.push(React.createElement('line', { key: 'yg' + yi, x1: PL, y1: yy, x2: PL + cW, y2: yy, stroke: '#0e1e30', strokeWidth: 0.5 }));
    var yLbl = yv >= 1000 ? Math.round(yv) : yv >= 10 ? yv.toFixed(0) : yv.toFixed(1);
    els.push(React.createElement('text', { key: 'yl' + yi, x: PL - 3, y: yy + 3, textAnchor: 'end', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, String(yLbl)));
  }

  // X ticks
  timeTicks.ticks.forEach(function(t, i) {
    var xt = px(t);
    els.push(React.createElement('line', { key: 'tg' + i, x1: xt, y1: PT, x2: xt, y2: PT + cH, stroke: '#0a1828', strokeWidth: 0.5 }));
    els.push(React.createElement('text', { key: 'tl' + i, x: xt, y: PT + cH + 9, textAnchor: 'middle', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, timeTicks.fmt(t)));
  });
  els.push(React.createElement('text', { key: 'tunit', x: PL + cW, y: PT + cH + (isModal ? 17 : 14), textAnchor: 'end', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, timeTicks.unit));

  if (props.refVal > 0) {
    els.push(React.createElement('line', { key: 'ref', x1: PL, y1: py(props.refVal), x2: PL + cW, y2: py(props.refVal), stroke: (props.refColor || '#4ade80') + '40', strokeWidth: 1, strokeDasharray: '4,3' }));
  }

  els.push(React.createElement('path', { key: 'line', d: path, fill: 'none', stroke: c, strokeWidth: 1.5, strokeLinejoin: 'round' }));
  els.push(React.createElement('circle', { key: 'dot', cx: px(last.t), cy: py(last.val), r: 2.5, fill: '#030810', stroke: c, strokeWidth: 1.5 }));
  els.push(React.createElement('text', { key: 'title', x: PL + 3, y: PT + 9, fill: c + '70', fontSize: 7.5, fontFamily: FN, fontWeight: '600' }, props.title || ''));
  els.push(React.createElement('text', { key: 'val', x: PL + cW - 2, y: PT + 9, textAnchor: 'end', fill: c, fontSize: 9, fontFamily: FN, fontWeight: '700' }, props.fmt ? props.fmt(last.val) : last.val.toFixed(2)));

  // Crosshair
  var crossX = props.crossX;
  if (crossX !== null && crossX !== undefined) {
    var interp = interpHistory(h, crossX);
    if (interp) {
      var cx2 = px(interp.t), cy2 = py(interp.val);
      var ttFS = isModal ? 7 : 6, ttW = isModal ? 80 : 70, ttH = 20;
      var ttX = cx2 + 5; if (ttX + ttW > PL + cW) ttX = cx2 - ttW - 5;
      var ttY = PT + 4;
      els.push(React.createElement('line', { key: 'cxv', x1: cx2, y1: PT, x2: cx2, y2: PT + cH, stroke: 'rgba(180,210,255,0.4)', strokeWidth: 0.8 }));
      els.push(React.createElement('line', { key: 'cxh', x1: PL, y1: cy2, x2: PL + cW, y2: cy2, stroke: c + '40', strokeWidth: 0.6 }));
      els.push(React.createElement('circle', { key: 'cxd', cx: cx2, cy: cy2, r: 3, fill: c, stroke: '#030810', strokeWidth: 1 }));
      els.push(React.createElement('rect', { key: 'cxbg', x: ttX - 2, y: ttY - 8, width: ttW, height: ttH, rx: 2, fill: 'rgba(4,12,24,0.9)', stroke: 'rgba(40,80,120,0.5)', strokeWidth: 0.5 }));
      els.push(React.createElement('text', { key: 'cxt1', x: ttX, y: ttY, fill: '#7aa8c8', fontSize: ttFS, fontFamily: FN }, fmtCrossTime(interp.t, t0)));
      els.push(React.createElement('text', { key: 'cxt2', x: ttX, y: ttY + 10, fill: c, fontSize: ttFS, fontFamily: FN }, props.fmt ? props.fmt(interp.val) : interp.val.toFixed(2)));
    }
  }

  return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block', width: '100%', height: 'auto' } }, els);
}

// -------------------------------------------------------
// PressChart — dual WHP/BHP time series with crosshair
// -------------------------------------------------------
function PressChart(props) {
  var wh = props.whpHistory, bh = props.bhpHistory;
  var Pr = props.Pr || 5000, Psep = props.Psep || 250;
  var W = props.width || 480, H = props.height || 100;
  var isModal = H > 200;
  var PL = 48, PR = 8, PT = 14, PB = isModal ? 22 : 16;
  var cW = W - PL - PR, cH = H - PT - PB;

  var empty = !wh || wh.length < 2;
  var maxP = Pr * 1.08;

  var allH = (wh || []).concat(bh || []);
  if (allH.length > 0) {
    var maxVal = 0;
    allH.forEach(function(p) { if (p.val > maxVal) maxVal = p.val; });
    maxP = Math.max(maxP, maxVal * 1.05);
  }

  var t0 = empty ? 0 : allH[0].t;
  var tEnd = empty ? 1 : allH[allH.length - 1].t;
  if (wh && wh.length > 0) t0 = wh[0].t;
  if (bh && bh.length > 0) t0 = Math.min(t0, bh[0].t);
  var ts = Math.max(tEnd - t0, 0.01);

  var px = function(t) { return PL + ((t - t0) / ts) * cW; };
  var py = function(v) { return PT + cH - (Math.max(0, Math.min(v, maxP)) / maxP) * cH; };

  var els = [];
  els.push(React.createElement('rect', { key: 'bg', x: PL, y: PT, width: cW, height: cH, rx: 2, fill: '#060e1c', stroke: '#1a3050', strokeWidth: 1 }));

  // Pr and Psep reference lines
  els.push(React.createElement('line', { key: 'pr', x1: PL, y1: py(Pr), x2: PL + cW, y2: py(Pr), stroke: '#4ade8020', strokeWidth: 1, strokeDasharray: '6,3' }));
  els.push(React.createElement('text', { key: 'prl', x: PL + 3, y: py(Pr) - 2, fill: '#4ade8030', fontSize: 5.5, fontFamily: FN }, 'Pr ' + Math.round(_vP(Pr)) + ' ' + _lP()));
  els.push(React.createElement('line', { key: 'ps', x1: PL, y1: py(Psep), x2: PL + cW, y2: py(Psep), stroke: '#60a5fa18', strokeWidth: 0.8, strokeDasharray: '4,3' }));
  els.push(React.createElement('text', { key: 'psl', x: PL + 3, y: py(Psep) - 2, fill: '#60a5fa28', fontSize: 5.5, fontFamily: FN }, 'Psep ' + Math.round(_vP(Psep)) + ' ' + _lP()));

  // Y ticks
  var nY = isModal ? 4 : 3;
  for (var yi = 1; yi <= nY; yi++) {
    var yv = maxP * yi / (nY + 1), yy = py(yv);
    els.push(React.createElement('line', { key: 'yg' + yi, x1: PL, y1: yy, x2: PL + cW, y2: yy, stroke: '#0e1e30', strokeWidth: 0.5 }));
    els.push(React.createElement('text', { key: 'yl' + yi, x: PL - 3, y: yy + 3, textAnchor: 'end', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, Math.round(_vP(yv))));
  }

  if (empty) {
    els.push(React.createElement('text', { key: 'emp', x: W / 2, y: H / 2, textAnchor: 'middle', fill: '#1e3050', fontSize: 8, fontFamily: FN }, 'Play to record'));
    return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block', width: '100%', height: 'auto' } }, els);
  }

  // X ticks
  var nTicks = isModal ? 8 : 4;
  var timeTicks = computeTimeTicks(t0, tEnd, nTicks);
  timeTicks.ticks.forEach(function(t, i) {
    var xt = px(t);
    els.push(React.createElement('line', { key: 'tg' + i, x1: xt, y1: PT, x2: xt, y2: PT + cH, stroke: '#0a1828', strokeWidth: 0.5 }));
    els.push(React.createElement('text', { key: 'tl' + i, x: xt, y: PT + cH + 9, textAnchor: 'middle', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, timeTicks.fmt(t)));
  });
  els.push(React.createElement('text', { key: 'tunit', x: PL + cW, y: PT + cH + (isModal ? 17 : 14), textAnchor: 'end', fill: '#1e3858', fontSize: isModal ? 6 : 5, fontFamily: FN }, timeTicks.unit));

  function makePath(h) {
    var p = '';
    h.forEach(function(pt, i) { p += (i === 0 ? 'M' : 'L') + px(pt.t).toFixed(1) + ',' + py(pt.val).toFixed(1); });
    return p;
  }

  if (bh && bh.length > 1) {
    els.push(React.createElement('path', { key: 'bhp', d: makePath(bh), fill: 'none', stroke: '#fbbf24', strokeWidth: 1.5, strokeLinejoin: 'round' }));
    var lb = bh[bh.length - 1];
    els.push(React.createElement('circle', { key: 'bdot', cx: px(lb.t), cy: py(lb.val), r: 2.5, fill: '#030810', stroke: '#fbbf24', strokeWidth: 1.5 }));
    els.push(React.createElement('text', { key: 'bval', x: PL + cW - 2, y: PT + 9, textAnchor: 'end', fill: '#fbbf24', fontSize: 9, fontFamily: FN, fontWeight: '700' }, 'BHP ' + Math.round(_vP(lb.val)) + ' ' + _lP()));
  }
  if (wh && wh.length > 1) {
    els.push(React.createElement('path', { key: 'whp', d: makePath(wh), fill: 'none', stroke: '#fb923c', strokeWidth: 1.5, strokeLinejoin: 'round' }));
    var lw = wh[wh.length - 1];
    els.push(React.createElement('circle', { key: 'wdot', cx: px(lw.t), cy: py(lw.val), r: 2.5, fill: '#030810', stroke: '#fb923c', strokeWidth: 1.5 }));
    els.push(React.createElement('text', { key: 'wval', x: PL + cW - 2, y: PT + (isModal ? 20 : 19), textAnchor: 'end', fill: '#fb923c', fontSize: 9, fontFamily: FN, fontWeight: '700' }, 'WHP ' + Math.round(_vP(lw.val)) + ' ' + _lP()));
  }
  els.push(React.createElement('text', { key: 'title', x: PL + 3, y: PT + 9, fill: '#fb923c70', fontSize: 7.5, fontFamily: FN, fontWeight: '600' }, 'PRESSURE'));
  els.push(React.createElement('text', { key: 'yunit', x: PL - 3, y: PT + 6, textAnchor: 'end', fill: '#1e3858', fontSize: 4.5, fontFamily: FN }, _lP()));

  // Crosshair
  var crossX = props.crossX;
  if (crossX !== null && crossX !== undefined) {
    var iW = interpHistory(wh, crossX);
    var iB = interpHistory(bh, crossX);
    if (iW || iB) {
      var t_cx = iW ? iW.t : iB.t;
      var xcx = px(t_cx);
      var ttFS = isModal ? 7 : 6, ttW = isModal ? 96 : 80, ttH = iW && iB ? 30 : 20;
      var ttX = xcx + 5; if (ttX + ttW > PL + cW) ttX = xcx - ttW - 5;
      var ttY = PT + 4;
      els.push(React.createElement('line', { key: 'cxv', x1: xcx, y1: PT, x2: xcx, y2: PT + cH, stroke: 'rgba(180,210,255,0.4)', strokeWidth: 0.8 }));
      if (iW) { els.push(React.createElement('circle', { key: 'cxdw', cx: xcx, cy: py(iW.val), r: 3, fill: '#fb923c', stroke: '#030810', strokeWidth: 1 })); }
      if (iB) { els.push(React.createElement('circle', { key: 'cxdb', cx: xcx, cy: py(iB.val), r: 3, fill: '#fbbf24', stroke: '#030810', strokeWidth: 1 })); }
      els.push(React.createElement('rect', { key: 'cxbg', x: ttX - 2, y: ttY - 8, width: ttW, height: ttH, rx: 2, fill: 'rgba(4,12,24,0.9)', stroke: 'rgba(40,80,120,0.5)', strokeWidth: 0.5 }));
      els.push(React.createElement('text', { key: 'cxt0', x: ttX, y: ttY, fill: '#7aa8c8', fontSize: ttFS, fontFamily: FN }, fmtCrossTime(t_cx, t0)));
      if (iW) els.push(React.createElement('text', { key: 'cxtw', x: ttX, y: ttY + 10, fill: '#fb923c', fontSize: ttFS, fontFamily: FN }, 'WHP ' + Math.round(_vP(iW.val)) + ' ' + _lP()));
      if (iB) els.push(React.createElement('text', { key: 'cxtb', x: ttX, y: ttY + 20, fill: '#fbbf24', fontSize: ttFS, fontFamily: FN }, 'BHP ' + Math.round(_vP(iB.val)) + ' ' + _lP()));
    }
  }

  return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block', width: '100%', height: 'auto' } }, els);
}

// -------------------------------------------------------
// PressProfileChart — pressure vs depth vertical traverse
// -------------------------------------------------------
function PressProfileChart(props) {
  var segs = props.segs || [];
  var TD   = props.TD   || 9000;
  var Pr   = props.Pr   || 3200;
  var Psep = props.Psep || 250;
  var W    = props.width  || 130;
  var H    = props.height || 420;
  var crossY = props.crossY;

  var PT = 14, PB = 18, PL = 10, PR = 32;
  var cW = W - PL - PR, cH = H - PT - PB;
  var maxP = Math.max(Pr * 1.05, 500);

  var px = function(p) { return PL + Math.max(0, Math.min(p / maxP, 1)) * cW; };
  var py = function(d) { return PT + (Math.min(d, TD) / TD) * cH; };

  var els = [];
  els.push(React.createElement('rect', { key: 'bg', x: PL, y: PT, width: cW, height: cH, rx: 2, fill: '#060e1c', stroke: '#1a3050', strokeWidth: 0.8 }));

  // Grid
  for (var pi = 1; pi < 4; pi++) {
    var pv = maxP * pi / 4, xp = px(pv);
    els.push(React.createElement('line', { key: 'pg' + pi, x1: xp, y1: PT, x2: xp, y2: PT + cH, stroke: 'rgba(30,56,88,0.55)', strokeWidth: 0.4 }));
    els.push(React.createElement('text', { key: 'pl' + pi, x: xp, y: PT + cH + 10, textAnchor: 'middle', fill: '#2d4a60', fontSize: 5, fontFamily: FN }, Math.round(_vP(pv) / (_isSI() ? 5 : 100)) * (_isSI() ? 5 : 100) + ''));
  }
  for (var di = 1; di < 4; di++) {
    var dv = TD * di / 4, yd = py(dv);
    els.push(React.createElement('line', { key: 'dg' + di, x1: PL, y1: yd, x2: PL + cW, y2: yd, stroke: 'rgba(30,56,88,0.35)', strokeWidth: 0.4 }));
    els.push(React.createElement('text', { key: 'dl' + di, x: PL + cW + 2, y: yd + 3, fill: '#2d4a60', fontSize: 5, fontFamily: FN }, Math.round(_vD(dv) / (_isSI() ? 30 : 100)) * (_isSI() ? 30 : 100) + ''));
  }

  // Reference lines
  els.push(React.createElement('line', { key: 'psep', x1: px(Psep), y1: PT, x2: px(Psep), y2: PT + cH, stroke: 'rgba(96,165,250,0.2)', strokeWidth: 0.8, strokeDasharray: '3,2' }));
  els.push(React.createElement('line', { key: 'pr', x1: px(Pr), y1: PT, x2: px(Pr), y2: PT + cH, stroke: 'rgba(74,222,128,0.18)', strokeWidth: 0.8, strokeDasharray: '3,2' }));

  // Curve
  if (segs && segs.length > 1) {
    var path = '';
    for (var si = 0; si < segs.length; si++) {
      var s = segs[si];
      path += (si === 0 ? 'M' : 'L') + px(s.P).toFixed(1) + ',' + py(s.depth).toFixed(1);
    }
    els.push(React.createElement('path', { key: 'curve', d: path, fill: 'none', stroke: '#fb923c', strokeWidth: 1.5, strokeLinejoin: 'round' }));
    els.push(React.createElement('circle', { key: 'topdot', cx: px(segs[0].P), cy: py(segs[0].depth), r: 2.5, fill: '#fb923c', stroke: '#030810', strokeWidth: 1 }));
    var last = segs[segs.length - 1];
    els.push(React.createElement('circle', { key: 'botdot', cx: px(last.P), cy: py(last.depth), r: 2.5, fill: '#fbbf24', stroke: '#030810', strokeWidth: 1 }));
  }

  els.push(React.createElement('text', { key: 'xtitle', x: PL + cW / 2, y: PT + cH + 17, textAnchor: 'middle', fill: '#2d4a60', fontSize: 5, fontFamily: FN }, 'P (' + _lPa() + ')'));

  // Crosshair
  if (crossY !== null && crossY !== undefined && segs && segs.length > 1) {
    var depthVal = crossY * TD;
    var si2 = 0;
    for (var i2 = 0; i2 < segs.length - 1; i2++) {
      if (segs[i2].depth <= depthVal) si2 = i2; else break;
    }
    var pAtDepth = segs[si2].P;
    if (si2 < segs.length - 1) {
      var dSpan = segs[si2 + 1].depth - segs[si2].depth;
      var f = dSpan > 0 ? (depthVal - segs[si2].depth) / dSpan : 0;
      pAtDepth = segs[si2].P + f * (segs[si2 + 1].P - segs[si2].P);
    }
    var cxP = px(pAtDepth), cyD = py(depthVal);
    els.push(React.createElement('line', { key: 'cxH', x1: PL, y1: cyD, x2: PL + cW, y2: cyD, stroke: 'rgba(90,138,170,0.5)', strokeWidth: 0.7 }));
    els.push(React.createElement('line', { key: 'cxV', x1: cxP, y1: PT, x2: cxP, y2: PT + cH, stroke: 'rgba(90,138,170,0.5)', strokeWidth: 0.7 }));
    els.push(React.createElement('circle', { key: 'cxDot', cx: cxP, cy: cyD, r: 3, fill: '#fb923c', stroke: '#030810', strokeWidth: 1.5 }));
    var depStr = Math.round(_vD(depthVal)) + _lD();
    var presStr = Math.round(_vP(pAtDepth)) + _lP();
    var tbW = 36, tbH = 20, tx = cxP + 4, ty = cyD - tbH - 3;
    if (tx + tbW > PL + cW) tx = cxP - tbW - 4;
    if (ty < PT) ty = cyD + 4;
    els.push(React.createElement('rect', { key: 'cxBg', x: tx, y: ty, width: tbW, height: tbH, rx: 2, fill: '#0a1828ee', stroke: '#1e3858', strokeWidth: 0.8 }));
    els.push(React.createElement('text', { key: 'cxP2', x: tx + tbW / 2, y: ty + 8, textAnchor: 'middle', fill: '#fb923c', fontSize: 7, fontFamily: FN, fontWeight: '700' }, presStr));
    els.push(React.createElement('text', { key: 'cxD2', x: tx + tbW / 2, y: ty + 16, textAnchor: 'middle', fill: '#5a8aaa', fontSize: 6, fontFamily: FN }, depStr));
  }

  return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block', width: '100%', height: '100%' } }, els);
}

// -------------------------------------------------------
// IPRCh — IPR/VLP nodal chart with axes, crosshair
// Uses class component to hold crosshair state (no hooks)
// -------------------------------------------------------
var IPRChInner = (function() {
  function IPRChInner(props) {
    this.state = { cxFrac: null };
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onMouseLeave = this.onMouseLeave.bind(this);
  }
  IPRChInner.prototype = Object.create(React.Component.prototype);
  IPRChInner.prototype.constructor = IPRChInner;
  IPRChInner.prototype.onMouseMove = function(e) {
    var rect = e.currentTarget.getBoundingClientRect();
    var W = this.props.W || 480, PL = this.props.PL || 46, cW = W - PL - 8;
    var svgX = (e.clientX - rect.left) / rect.width * W;
    this.setState({ cxFrac: Math.max(0, Math.min(1, (svgX - PL) / cW)) });
  };
  IPRChInner.prototype.onMouseLeave = function() { this.setState({ cxFrac: null }); };
  IPRChInner.prototype.render = function() {
    var p = this.props, cxFrac = this.state.cxFrac;
    var par = p.par, pts = p.pts, qMax = p.qMax, maxP = p.maxP;
    var W = p.W, H = p.H, PL = p.PL, PR = p.PR, PT = p.PT, PB = p.PB;
    var cW = W - PL - PR, cH = H - PT - PB;
    var px = function(q) { return PL + (q / qMax) * cW; };
    var py = function(v) { return PT + cH - (Math.max(0, Math.min(v, maxP)) / maxP) * cH; };

    var els = p.baseEls.slice();
    var aS = p.axisScale  || 1;   // axis tick + title scale
    var cS = p.crossScale || 1;   // crosshair tooltip scale

    // Y ticks
    for (var yi = 1; yi < 4; yi++) {
      var pv = maxP * yi / 4, yy = py(pv);
      els.push(React.createElement('line', { key: 'yg' + yi, x1: PL, y1: yy, x2: PL + cW, y2: yy, stroke: 'rgba(30,56,88,0.7)', strokeWidth: 0.5 }));
      els.push(React.createElement('text', { key: 'yl' + yi, x: PL - 3, y: yy + 3, textAnchor: 'end', fill: '#3d6080', fontSize: 6 * aS, fontFamily: FN }, String(Math.round(_vP(pv) / (_isSI() ? 5 : 100)) * (_isSI() ? 5 : 100))));
    }
    els.push(React.createElement('text', { key: 'ytitle', x: aS > 1 ? 10 : 7, y: PT + cH / 2, textAnchor: 'middle', transform: 'rotate(-90,' + (aS > 1 ? 10 : 7) + ',' + (PT + cH / 2) + ')', fill: '#2d4a60', fontSize: 5.5 * aS, fontFamily: FN }, 'Pwf (' + _lPa() + ')'));

    // X ticks
    for (var xi = 1; xi < 4; xi++) {
      var qv = qMax * xi / 4, xx = px(qv);
      els.push(React.createElement('line', { key: 'xg' + xi, x1: xx, y1: PT, x2: xx, y2: PT + cH, stroke: 'rgba(30,56,88,0.5)', strokeWidth: 0.5 }));
      var qvDisp = _vQg(qv);
      els.push(React.createElement('text', { key: 'xl' + xi, x: xx, y: PT + cH + 10 * aS, textAnchor: 'middle', fill: '#3d6080', fontSize: 6 * aS, fontFamily: FN }, String(qvDisp >= 10 ? qvDisp.toFixed(0) : qvDisp.toFixed(1))));
    }
    els.push(React.createElement('text', { key: 'xtitle', x: PL + cW / 2, y: PT + cH + 20 * aS, textAnchor: 'middle', fill: '#2d4a60', fontSize: 5.5 * aS, fontFamily: FN }, 'Gas rate (' + _lQg() + ')'));

    // Crosshair
    if (cxFrac !== null) {
      var qCur = cxFrac * qMax, xLine = PL + cxFrac * cW;
      function interp(field) {
        for (var i = 1; i < pts.length; i++) {
          if (pts[i].q >= qCur) {
            var t = (qCur - pts[i-1].q) / Math.max(pts[i].q - pts[i-1].q, 1e-9);
            var v = pts[i-1][field] + t * (pts[i][field] - pts[i-1][field]);
            return isFinite(v) ? v : null;
          }
        }
        return pts[pts.length - 1][field];
      }
      var piV = interp('pi'), poV = interp('po'), poLV = p.hasLoadedVLP ? interp('poL') : null;
      els.push(React.createElement('line', { key: 'cxv', x1: xLine, y1: PT, x2: xLine, y2: PT + cH, stroke: 'rgba(200,220,255,0.45)', strokeWidth: 0.8, pointerEvents: 'none' }));
      if (piV !== null) els.push(React.createElement('circle', { key: 'cxd1', cx: xLine, cy: py(piV), r: 2.5, fill: '#e05080', pointerEvents: 'none' }));
      if (poV !== null) els.push(React.createElement('circle', { key: 'cxd2', cx: xLine, cy: py(poV), r: 2.5, fill: '#e08030', pointerEvents: 'none' }));
      if (poLV !== null) els.push(React.createElement('circle', { key: 'cxd3', cx: xLine, cy: py(poLV), r: 2.5, fill: '#e0a000', pointerEvents: 'none' }));
      var lnSp = 10 * cS;
      var nRows = 1 + (piV !== null ? 1 : 0) + (poV !== null ? 1 : 0) + (poLV !== null ? 1 : 0);
      var ttW = cS > 1 ? 230 : 92;
      var ttH = 8 + lnSp * nRows;
      var ttX = xLine + 5; if (ttX + ttW > PL + cW) ttX = xLine - ttW - 5;
      var ttY = PT + 6;
      els.push(React.createElement('rect', { key: 'cxtbg', x: ttX - 2, y: ttY - lnSp * 0.8, width: ttW, height: ttH, rx: 2, fill: 'rgba(3,8,16,0.88)', stroke: 'rgba(40,80,120,0.5)', strokeWidth: 0.5, pointerEvents: 'none' }));
      els.push(React.createElement('text', { key: 'cxt0', x: ttX, y: ttY, fill: '#7aa8c8', fontSize: 6 * cS, fontFamily: FN, pointerEvents: 'none' }, 'q = ' + _vQg(qCur).toFixed(2) + ' ' + _lQg()));
      if (piV !== null) els.push(React.createElement('text', { key: 'cxt1', x: ttX, y: ttY + lnSp, fill: '#e05080', fontSize: 6 * cS, fontFamily: FN, pointerEvents: 'none' }, 'IPR  ' + Math.round(_vP(piV)) + ' ' + _lPa()));
      if (poV !== null) els.push(React.createElement('text', { key: 'cxt2', x: ttX, y: ttY + lnSp * 2, fill: '#e08030', fontSize: 6 * cS, fontFamily: FN, pointerEvents: 'none' }, 'VLP  ' + Math.round(_vP(poV)) + ' ' + _lPa()));
      if (poLV !== null) els.push(React.createElement('text', { key: 'cxt3', x: ttX, y: ttY + lnSp * 3, fill: '#e0a000', fontSize: 6 * cS, fontFamily: FN, pointerEvents: 'none' }, 'VLP\u2113 ' + Math.round(_vP(poLV)) + ' ' + _lPa()));
    }

    return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + (H + 10),
      style: { display: 'block', width: '100%', height: 'auto', cursor: 'crosshair' },
      onMouseMove: this.onMouseMove, onMouseLeave: this.onMouseLeave }, els);
  };
  return IPRChInner;
})();

function IPRCh(props) {
  var par = props.params, cv = props.curves, op = props.opPoint;
  var liveOp = props.liveOp, hasLoadedVLP = props.hasLoadedVLP;
  var W = props.width || 480, H = props.height || 150;
  var axisScale  = props.axisScale  || 1;
  var crossScale = props.crossScale || 1;
  if (!cv || cv.pts.length < 2) return null;

  // Widen margins to accommodate larger axis labels in popup mode
  var PL = axisScale > 1 ? 64 : 46;
  var PR = 8, PT = 16;
  var PB = axisScale > 1 ? 44 : 30;
  var cW = W - PL - PR, cH = H - PT - PB;
  var pts = cv.pts, qMax = cv.qMax * 1.05;
  var vlpM = 0;
  pts.forEach(function(p) { if (isFinite(p.po) && p.po > vlpM) vlpM = p.po; if (isFinite(p.poL) && p.poL > vlpM) vlpM = p.poL; });
  var maxP = Math.max(par.Pr * 1.05, Math.min(vlpM * 1.05, par.Pr * 1.8));
  var px = function(q) { return PL + (q / qMax) * cW; };
  var py = function(v) { return PT + cH - (Math.max(0, Math.min(v, maxP)) / maxP) * cH; };

  var els = [];
  els.push(React.createElement('rect', { key: 'bg', x: PL, y: PT, width: cW, height: cH, rx: 2, fill: '#060e1c', stroke: '#1a3050', strokeWidth: 1 }));

  var ip = '', vp = '', vpL = '';
  pts.forEach(function(p, i) {
    ip += (i === 0 ? 'M' : 'L') + px(p.q).toFixed(1) + ',' + py(p.pi).toFixed(1);
    if (isFinite(p.po) && p.po >= 0) vp += (vp === '' ? 'M' : 'L') + px(p.q).toFixed(1) + ',' + py(p.po).toFixed(1);
    if (hasLoadedVLP && isFinite(p.poL) && p.poL >= 0) vpL += (vpL === '' ? 'M' : 'L') + px(p.q).toFixed(1) + ',' + py(p.poL).toFixed(1);
  });
  if (ip) els.push(React.createElement('path', { key: 'ipr', d: ip, fill: 'none', stroke: '#e05080', strokeWidth: 1.5 }));
  if (vp) els.push(React.createElement('path', { key: 'vlp', d: vp, fill: 'none', stroke: '#e08030', strokeWidth: 1.5 }));
  if (vpL) els.push(React.createElement('path', { key: 'vlpL', d: vpL, fill: 'none', stroke: '#e0a000', strokeWidth: 1.2, strokeDasharray: '5,3' }));

  if (op && op.q_op > 0) {
    els.push(React.createElement('circle', { key: 'opdot', cx: px(op.q_op), cy: py(op.pwf_op), r: 4, fill: '#c8a020', stroke: '#030810', strokeWidth: 1 }));
    els.push(React.createElement('text', { key: 'oplbl', x: PL + cW - 2, y: PT + 9, textAnchor: 'end', fill: '#c8a020', fontSize: 9, fontFamily: FN, fontWeight: '700' }, _vQg(op.q_op).toFixed(2) + ' ' + _lQg()));
  }
  if (liveOp && liveOp.q > 0) {
    els.push(React.createElement('circle', { key: 'liveop', cx: px(liveOp.q), cy: py(liveOp.pwf), r: 3.5, fill: '#40c880', stroke: '#030810', strokeWidth: 1 }));
  }

  var legY = PT + cH + 22;
  els.push(React.createElement('line', { key: 'lg1', x1: PL, y1: legY, x2: PL+12, y2: legY, stroke: '#e05080', strokeWidth: 1.5 }));
  els.push(React.createElement('text', { key: 'lt1', x: PL+14, y: legY+3, fill: '#e05080', fontSize: 6, fontFamily: FN }, 'IPR'));
  els.push(React.createElement('line', { key: 'lg2', x1: PL+30, y1: legY, x2: PL+42, y2: legY, stroke: '#e08030', strokeWidth: 1.5 }));
  els.push(React.createElement('text', { key: 'lt2', x: PL+44, y: legY+3, fill: '#e08030', fontSize: 6, fontFamily: FN }, 'VLP'));
  if (hasLoadedVLP) {
    els.push(React.createElement('line', { key: 'lg3', x1: PL+60, y1: legY, x2: PL+72, y2: legY, stroke: '#e0a000', strokeWidth: 1.2, strokeDasharray: '4,2' }));
    els.push(React.createElement('text', { key: 'lt3', x: PL+74, y: legY+3, fill: '#e0a000', fontSize: 6, fontFamily: FN }, 'VLP+load'));
  }

  return React.createElement(IPRChInner, {
    par: par, pts: pts, qMax: qMax, maxP: maxP,
    W: W, H: H, PL: PL, PR: PR, PT: PT, PB: PB,
    hasLoadedVLP: hasLoadedVLP, baseEls: els,
    axisScale: axisScale, crossScale: crossScale
  });
}

// -------------------------------------------------------
// SurfPID — surface P&ID schematic
// -------------------------------------------------------
function SurfPID(props) {
  var mode = props.mode, gR = props.gasRate || 0, cR = props.condRate || 0, wR = props.waterRate || 0;
  var whp = props.whp || 0, psep = props.psep || 250, choke64 = props.choke64 || 32;
  var isF = mode === 'unloading' || mode === 'flowing' || mode === 'loading';
  var W = 560, H = 134;
  var gc = '#4ade80', cc = '#fde047', wc = '#60a5fa';
  var anim = isF ? 'sfFlow .75s linear infinite' : 'none';

  // Separator geometry — horizontal cylindrical vessel.
  // Straight section is 85 wide (33% longer than the v3.4.7 first cut at 64).
  // Caps are circular with r=28.
  var sepBodyX = 276, sepBodyW = 85;
  var sepBodyR = sepBodyX + sepBodyW;
  var sepCapR  = 28;
  var sepLeft  = sepBodyX - sepCapR;
  var sepRight = sepBodyR + sepCapR;
  var sepTop = 42, sepBot = 98, sepCY = (sepTop + sepBot) / 2;

  return React.createElement('svg', { viewBox: '0 0 ' + W + ' ' + H, style: { display: 'block', width: '100%', height: 'auto' } },
    React.createElement('defs', null,
      React.createElement('style', null, '@keyframes sfFlow{from{stroke-dashoffset:15}to{stroke-dashoffset:0}}'),
      React.createElement('linearGradient', { id: 'hp', x1: '0%', y1: '0%', x2: '0%', y2: '100%' },
        React.createElement('stop', { offset: '0%', stopColor: '#6a8fa8' }),
        React.createElement('stop', { offset: '50%', stopColor: '#92b4c8' }),
        React.createElement('stop', { offset: '100%', stopColor: '#243444' })
      ),
      // Clip path: the vessel interior shape, used to clip the fluid layer rectangles
      // so they only appear inside the capsule outline.
      React.createElement('clipPath', { id: 'sepInner' },
        React.createElement('path', {
          d: 'M ' + sepBodyX + ' ' + sepTop +
             ' L ' + sepBodyR + ' ' + sepTop +
             ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyR + ' ' + sepBot +
             ' L ' + sepBodyX + ' ' + sepBot +
             ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyX + ' ' + sepTop +
             ' Z'
        })
      )
    ),

    // Wellhead
    React.createElement('rect', { x: 50, y: 48, width: 8, height: 50, fill: 'url(#hp)' }),
    React.createElement('rect', { x: 38, y: 56, width: 32, height: 12, rx: 3, fill: '#182e40', stroke: '#3a5870', strokeWidth: 1 }),
    React.createElement('text', { x: 54, y: 80, textAnchor: 'middle', fill: '#2e4e68', fontSize: 7, fontFamily: FN }, 'WH'),
    React.createElement('text', { x: 54, y: 90, textAnchor: 'middle', fill: isF ? '#4a7a9a' : '#2e4a60', fontSize: 8, fontFamily: FN, fontWeight: '600' }, Math.round(_vP(whp)) + _lP()),

    // Flowline to choke
    React.createElement('rect', { x: 70, y: 58, width: 60, height: 8, fill: 'url(#hp)' }),
    React.createElement('line', { x1: 72, y1: 62, x2: 128, y2: 62, stroke: isF ? gc + '72' : '#1a2e3e', strokeWidth: 3, strokeDasharray: '9 6', style: { animation: anim } }),

    // Choke body
    React.createElement('rect', { x: 132, y: 50, width: 24, height: 24, rx: 3, fill: '#0c1c2c', stroke: isF ? '#5a8aaa' : '#2a4050', strokeWidth: 1.5 }),
    React.createElement('polygon', { points: '138,54 138,70 148,62', fill: isF ? '#4a8aaa' : '#2a4858' }),
    React.createElement('polygon', { points: '152,54 152,70 142,62', fill: isF ? '#4a8aaa' : '#2a4858' }),
    React.createElement('text', { x: 144, y: 84, textAnchor: 'middle', fill: '#3a6080', fontSize: 7, fontFamily: FN }, 'CHOKE'),
    React.createElement('text', { x: 144, y: 94, textAnchor: 'middle', fill: '#4a7a9a', fontSize: 8, fontFamily: FN, fontWeight: '600' }, choke64 + '/64"'),

    // Downstream flowline — extends all the way to the vessel body start (sepBodyX)
    // so the pipe visually enters the left cap. The vessel's dark background fill
    // (drawn below) covers the portion inside the cap, giving a sealed entry.
    React.createElement('rect', { x: 156, y: 58, width: sepBodyX - 156, height: 8, fill: 'url(#hp)' }),
    React.createElement('line', { x1: 158, y1: 62, x2: sepBodyX - 1, y2: 62, stroke: isF ? gc + '60' : '#1a2e3e', strokeWidth: 3, strokeDasharray: '9 6', style: { animation: anim } }),

    // ── Separator vessel ──
    // 1. Dark background fill — drawn first so it covers the inlet pipe
    //    where it passes inside the left cap.  This gives a sealed-entry look.
    React.createElement('path', {
      d: 'M ' + sepBodyX + ' ' + sepTop +
         ' L ' + sepBodyR + ' ' + sepTop +
         ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyR + ' ' + sepBot +
         ' L ' + sepBodyX + ' ' + sepBot +
         ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyX + ' ' + sepTop +
         ' Z',
      fill: '#0c1c2c'
    }),

    // 2. Fluid stratification layers.
    //    During flowing: layers proportional to WGR/CGR + gas cap.
    //    During shut-in: show residual liquid (from props.fillPct if given)
    //    with the same water/cond split.  Minimum gas cap = 25% of vessel height.
    (function() {
      var layers = [];
      // Determine effective liquid fraction of vessel height (0–0.75)
      var fp = props.fillFrac || 0;   // 0..1, passed from app.js (Vliq/Vwb)
      var liqFrac;
      if (isF) {
        // flowing — use production ratio; always show a gas cap (min 20%)
        liqFrac = Math.min(0.75, Math.max(0.05, (wR + cR) / Math.max(gR * 200 + wR + cR, 1)));
      } else {
        // shut-in — use actual inventory fill, capped at 80% vessel
        liqFrac = Math.min(0.80, fp);
      }
      var vesselH = sepBot - sepTop;
      var liqPx   = liqFrac * vesselH;
      var liqTopY = sepBot - liqPx;
      var totalLiq2 = (wR + cR) || 1;
      var wFrac2 = Math.max(0, wR) / totalLiq2;
      var wPx    = liqPx * wFrac2;
      var cPx    = liqPx - wPx;
      var wTopY  = sepBot - wPx;
      var cTopY  = wTopY  - cPx;  // = liqTopY

      // Gas (top)
      layers.push(React.createElement('rect', {
        key: 'gasL', x: sepLeft, y: sepTop, width: sepRight - sepLeft,
        height: Math.max(0, cTopY - sepTop),
        fill: gc, fillOpacity: 0.07, clipPath: 'url(#sepInner)'
      }));
      // Condensate (middle)
      if (cPx > 0.5) layers.push(React.createElement('rect', {
        key: 'condL', x: sepLeft, y: cTopY, width: sepRight - sepLeft, height: cPx,
        fill: cc, fillOpacity: 0.22, clipPath: 'url(#sepInner)'
      }));
      // Water (bottom)
      if (wPx > 0.5) layers.push(React.createElement('rect', {
        key: 'watL', x: sepLeft, y: wTopY, width: sepRight - sepLeft, height: wPx,
        fill: wc, fillOpacity: 0.22, clipPath: 'url(#sepInner)'
      }));
      // Interface lines
      if (liqPx > 2) layers.push(React.createElement('line', {
        key: 'intL', x1: sepLeft + 6, y1: cTopY, x2: sepRight - 6, y2: cTopY,
        stroke: '#8ab0c8', strokeWidth: 0.8, strokeDasharray: '4,3', opacity: 0.5
      }));
      if (wPx > 4 && cPx > 4) layers.push(React.createElement('line', {
        key: 'intW', x1: sepLeft + 6, y1: wTopY, x2: sepRight - 6, y2: wTopY,
        stroke: '#5a7088', strokeWidth: 0.6, strokeDasharray: '3,2', opacity: 0.45
      }));
      return layers;
    })(),

    // 3. Vessel outline (drawn on top of fills, behind outlet stubs)
    React.createElement('path', {
      d: 'M ' + sepBodyX + ' ' + sepTop +
         ' L ' + sepBodyR + ' ' + sepTop +
         ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyR + ' ' + sepBot +
         ' L ' + sepBodyX + ' ' + sepBot +
         ' A ' + sepCapR + ' ' + sepCapR + ' 0 0 1 ' + sepBodyX + ' ' + sepTop +
         ' Z',
      fill: 'none', stroke: '#2a4050', strokeWidth: 1.5
    }),

    // 4. Inlet nozzle — small stub drawn OVER the vessel outline at the left cap,
    //    at the pipe entry point, to make the connection explicit.
    React.createElement('rect', { x: sepLeft - 2, y: 58, width: sepCapR + 4, height: 8, fill: 'url(#hp)' }),
    React.createElement('rect', { x: sepLeft - 2, y: 59.5, width: 10, height: 5, fill: '#0c1c2c' }),
    React.createElement('line', { x1: sepLeft + 8, y1: 62, x2: sepBodyX, y2: 62, stroke: isF ? gc + '40' : '#1a2e3e40', strokeWidth: 2, strokeDasharray: '4 3' }),

    // 5. Internal weir/baffle
    React.createElement('line', {
      x1: sepBodyR - 18, y1: sepCY - 8, x2: sepBodyR - 18, y2: sepBot,
      stroke: '#2a4868', strokeWidth: 1.2
    }),

    // 6. Labels
    React.createElement('text', { x: (sepLeft + sepRight) / 2 - 18, y: sepTop - 6, textAnchor: 'middle', fill: '#2e4e68', fontSize: 7, fontFamily: FN }, 'SEPARATOR'),
    React.createElement('text', { x: (sepLeft + sepRight) / 2, y: sepCY - 2, textAnchor: 'middle', fill: '#3a6080', fontSize: 8, fontFamily: FN }, Math.round(_vP(psep)) + ' ' + _lP()),

    // 7. Gas outlet
    React.createElement('rect', { x: sepBodyX + sepBodyW * 0.7 - 3, y: sepTop - 16, width: 6, height: 16, fill: 'url(#hp)' }),
    React.createElement('line', { x1: sepBodyX + sepBodyW * 0.7, y1: sepTop - 16, x2: sepBodyX + sepBodyW * 0.7, y2: sepTop, stroke: isF ? gc + '80' : '#1a2e3e', strokeWidth: 2, strokeDasharray: '6 4', style: { animation: anim } }),
    React.createElement('text', { x: sepBodyX + sepBodyW * 0.7, y: sepTop - 20, textAnchor: 'middle', fill: isF ? gc : '#2a4050', fontSize: 7, fontFamily: FN }, 'GAS'),
    React.createElement('text', { x: sepBodyX + sepBodyW * 0.7, y: sepTop - 28, textAnchor: 'middle', fill: isF ? gc : '#2a4050', fontSize: 7.5, fontFamily: FN, fontWeight: '700' }, isF ? _vQg(gR).toFixed(2) + ' ' + _lQg() : ''),

    // 8. Water outlet
    React.createElement('rect', { x: sepBodyX + 18, y: sepBot, width: 6, height: 16, fill: 'url(#hp)' }),
    React.createElement('line', { x1: sepBodyX + 21, y1: sepBot + 2, x2: sepBodyX + 21, y2: sepBot + 16, stroke: isF ? wc + '80' : '#1a2e3e', strokeWidth: 2, strokeDasharray: '6 4', style: { animation: anim } }),
    React.createElement('text', { x: sepBodyX + 21, y: sepBot + 24, textAnchor: 'middle', fill: isF ? wc : '#2a4050', fontSize: 7, fontFamily: FN }, 'WATER'),
    React.createElement('text', { x: sepBodyX + 21, y: sepBot + 32, textAnchor: 'middle', fill: isF ? wc : '#2a4050', fontSize: 7, fontFamily: FN, fontWeight: '700' }, isF && wR > 0 ? Math.round(wR) + ' bpd' : ''),

    // 9. Condensate outlet
    React.createElement('rect', { x: sepBodyR - 8, y: sepBot, width: 6, height: 16, fill: 'url(#hp)' }),
    React.createElement('line', { x1: sepBodyR - 5, y1: sepBot + 2, x2: sepBodyR - 5, y2: sepBot + 16, stroke: isF ? cc + '80' : '#1a2e3e', strokeWidth: 2, strokeDasharray: '6 4', style: { animation: anim } }),
    React.createElement('text', { x: sepBodyR - 5, y: sepBot + 24, textAnchor: 'middle', fill: isF ? cc : '#2a4050', fontSize: 7, fontFamily: FN }, 'COND'),
    React.createElement('text', { x: sepBodyR - 5, y: sepBot + 32, textAnchor: 'middle', fill: isF ? cc : '#2a4050', fontSize: 7, fontFamily: FN, fontWeight: '700' }, isF && cR > 0 ? Math.round(cR) + ' bpd' : '')
  );
}

// -------------------------------------------------------
// EXPORTS
// -------------------------------------------------------
window.WM_Charts = {
  FN: FN,
  ChartWithCrosshair: ChartWithCrosshair,
  LnC: LnC,
  PressChart: PressChart,
  PressProfileChart: PressProfileChart,
  IPRCh: IPRCh,
  SurfPID: SurfPID
};
