// =======================================================
// WELLMODEL.APP — WELLBORE CANVAS DRAWING
// Regime-specific flow pattern visualization
// =======================================================

var RCOL = {
  bubble: '#2563eb', slug: '#16a34a', churn: '#65a30d',
  annular: '#34d399', gas_zone: '#166534', segregating: '#a16207',
  liquid_zone: '#1e40af'
};

function seededRand(seed) {
  var s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function() {
    s = s * 16807 % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function drawWB(cv, segs, ph, fluid) {
  if (!cv || !segs.length) return;
  var dpr = window.devicePixelRatio || 1;
  var ctx = cv.getContext('2d');
  var W = cv.width / dpr, H = cv.height / dpr;
  var SH = H / segs.length, WL = 10, WR = W - 10, IW = WR - WL;
  var CX = WL + IW / 2;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#030609';
  ctx.fillRect(0, 0, W, H);

  var isW = fluid === 'water';
  var liqCol = isW ? [37, 99, 235] : [161, 128, 40];
  var gasCol = [22, 163, 74];

  for (var i = 0; i < segs.length; i++) {
    var s = segs[i], y = i * SH, hl = s.HL;
    var key = s.siPhase || s.regime;
    var rng = seededRand(i * 1337 + 7);

    // Gas background
    ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',' + (0.08 + (1 - hl) * 0.25) + ')';
    ctx.fillRect(WL, y, IW, SH);

    if (key === 'bubble') {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (0.25 + hl * 0.3) + ')';
      ctx.fillRect(WL, y, IW, SH);
      var nb = Math.round(8 + hl * 6);
      for (var b = 0; b < nb; b++) {
        var bx = WL + 3 + rng() * (IW - 6);
        var by = y + ((rng() * SH - ph * 0.8 * SH + SH * 10) % SH);
        var br = 0.6 + rng() * 1.2;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',' + (0.35 + rng() * 0.3) + ')';
        ctx.fill();
        ctx.strokeStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.15)';
        ctx.lineWidth = 0.5; ctx.stroke();
      }
    }
    else if (key === 'slug') {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (0.25 + hl * 0.3) + ')';
      ctx.fillRect(WL, y, IW, SH);
      var slugPeriod = 6;
      var slugPos = ((i + ph * 0.3) % slugPeriod) / slugPeriod;
      var gasCapFrac = Math.max(0.3, 1 - hl);
      if (slugPos < gasCapFrac) {
        var filmW = Math.max(2, IW * hl * 0.18);
        var gasL = WL + filmW, gasR = WR - filmW, gasW2 = gasR - gasL;
        if (slugPos < 0.15) {
          var noseProg = slugPos / 0.15;
          var bw = gasW2 * (0.3 + 0.7 * noseProg);
          var bh = SH * (0.4 + 0.6 * noseProg);
          ctx.beginPath();
          ctx.ellipse(CX, y + SH - bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.12)'; ctx.fill();
          ctx.strokeStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',0.3)';
          ctx.lineWidth = 0.8; ctx.stroke();
        }
        else if (slugPos > gasCapFrac - 0.12) {
          var tailProg = (gasCapFrac - slugPos) / 0.12;
          var tw = gasW2 * tailProg;
          ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.10)';
          ctx.fillRect(CX - tw / 2, y, tw, SH * tailProg);
        }
        else {
          ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.10)';
          ctx.fillRect(gasL, y, gasW2, SH);
        }
        for (var b2 = 0; b2 < 3; b2++) {
          var side = rng() > 0.5;
          var bx2 = side ? (WR - filmW + rng() * filmW) : (WL + rng() * filmW);
          var by2 = y + rng() * SH;
          ctx.beginPath(); ctx.arc(bx2, by2, 0.4 + rng() * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.4)'; ctx.fill();
        }
      } else {
        var nb2 = Math.round(3 + rng() * 4);
        for (var b3 = 0; b3 < nb2; b3++) {
          var bx3 = WL + 3 + rng() * (IW - 6);
          var by3 = y + ((rng() * SH + ph * 1.2 * SH) % SH);
          var br2 = 0.4 + rng() * 0.9;
          ctx.beginPath(); ctx.arc(bx3, by3, br2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.3)'; ctx.fill();
          ctx.strokeStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.15)';
          ctx.lineWidth = 0.4; ctx.stroke();
        }
      }
    }
    else if (key === 'churn') {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (0.15 + hl * 0.25) + ')';
      ctx.fillRect(WL, y, IW, SH);
      var np2 = Math.round(2 + rng() * 3);
      for (var p2 = 0; p2 < np2; p2++) {
        var px2 = WL + 2 + rng() * (IW - 4);
        var py2 = y + ((rng() * SH + ph * 0.6 * SH) % SH);
        var pw = 2 + rng() * 6, ph2 = 1.5 + rng() * 4;
        ctx.save(); ctx.translate(px2, py2); ctx.rotate(rng() * Math.PI);
        ctx.beginPath();
        ctx.moveTo(-pw / 2, 0);
        ctx.bezierCurveTo(-pw / 2, -ph2 * 0.6, pw * 0.3, -ph2 * 0.8, pw / 2, -ph2 * 0.2);
        ctx.bezierCurveTo(pw * 0.6, ph2 * 0.3, pw * 0.1, ph2 * 0.5, -pw / 2, 0);
        ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',' + (0.15 + rng() * 0.15) + ')'; ctx.fill();
        ctx.strokeStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',0.2)';
        ctx.lineWidth = 0.6; ctx.stroke();
        ctx.restore();
      }
      for (var b4 = 0; b4 < 4; b4++) {
        var bx4 = WL + 2 + rng() * (IW - 4), by4 = y + rng() * SH;
        ctx.beginPath(); ctx.arc(bx4, by4, 0.5 + rng() * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.35)'; ctx.fill();
      }
    }
    else if (key === 'annular') {
      ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.18)';
      ctx.fillRect(WL, y, IW, SH);
      var filmW2 = Math.max(2, IW * hl * 0.4);
      var filmAlpha = 0.35 + hl * 0.3;
      ctx.beginPath(); ctx.moveTo(WL, y);
      for (var yy = 0; yy <= SH; yy += 2) {
        var wave = filmW2 * (0.7 + 0.3 * Math.sin((y + yy) * 0.3 + ph * 2));
        ctx.lineTo(WL + wave, y + yy);
      }
      ctx.lineTo(WL, y + SH); ctx.closePath();
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + filmAlpha + ')'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(WR, y);
      for (var yy2 = 0; yy2 <= SH; yy2 += 2) {
        var wave2 = filmW2 * (0.7 + 0.3 * Math.sin((y + yy2) * 0.35 + ph * 2.3 + 1.5));
        ctx.lineTo(WR - wave2, y + yy2);
      }
      ctx.lineTo(WR, y + SH); ctx.closePath();
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + filmAlpha + ')'; ctx.fill();
      var nd = Math.round(3 + rng() * 4);
      for (var d = 0; d < nd; d++) {
        var dx = WL + filmW2 + 2 + rng() * (IW - filmW2 * 2 - 4);
        var dy = y + ((rng() * SH - ph * 2 * SH + SH * 20) % SH);
        var dr = 0.3 + rng() * 0.6;
        ctx.beginPath(); ctx.arc(dx, dy, dr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',0.5)'; ctx.fill();
      }
    }
    else if (key === 'gas_zone') {
      ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.06)';
      ctx.fillRect(WL, y, IW, SH);
    }
    else if (key === 'liquid_zone') {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (0.35 + hl * 0.3) + ')';
      ctx.fillRect(WL, y, IW, SH);
      for (var b5 = 0; b5 < 2; b5++) {
        var bx5 = WL + 3 + rng() * (IW - 6);
        var by5 = y + ((rng() * SH - ph * 0.3 * SH + SH * 10) % SH);
        ctx.beginPath(); ctx.arc(bx5, by5, 0.5 + rng() * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.25)'; ctx.fill();
      }
    }
    else if (key === 'segregating') {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (hl * 0.35) + ')';
      ctx.fillRect(WL, y, IW, SH);
      var nb3 = Math.round(3 + rng() * 3);
      for (var b6 = 0; b6 < nb3; b6++) {
        var bx6 = WL + 2 + rng() * (IW - 4), by6 = y + rng() * SH;
        var br3 = 0.5 + rng() * 1;
        ctx.beginPath(); ctx.arc(bx6, by6, br3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + gasCol[0] + ',' + gasCol[1] + ',' + gasCol[2] + ',0.3)'; ctx.fill();
      }
    }
    else {
      ctx.fillStyle = 'rgba(' + liqCol[0] + ',' + liqCol[1] + ',' + liqCol[2] + ',' + (hl * 0.4) + ')';
      ctx.fillRect(WL, y, IW, SH);
    }

    // Regime indicator bar
    ctx.fillStyle = RCOL[key] || '#475569';
    ctx.globalAlpha = 0.4;
    ctx.fillRect(WR - 2, y, 2, SH - 0.2);
    ctx.globalAlpha = 1;
  }

  // Casing walls
  var ml = ctx.createLinearGradient(0, 0, WL, 0);
  ml.addColorStop(0, '#020508'); ml.addColorStop(0.3, '#7a8fa0');
  ml.addColorStop(0.7, '#5a7080'); ml.addColorStop(1, '#1e3040');
  ctx.fillStyle = ml; ctx.fillRect(0, 0, WL, H);
  var mr = ctx.createLinearGradient(WR, 0, W, 0);
  mr.addColorStop(0, '#1e3040'); mr.addColorStop(0.4, '#5a7080');
  mr.addColorStop(0.7, '#7a8fa0'); mr.addColorStop(1, '#020508');
  ctx.fillStyle = mr; ctx.fillRect(WR, 0, WL, H);
}

// Export
window.WM_Draw = { RCOL: RCOL, drawWB: drawWB };
