// ============================================================================
// Project YUKTI — UI Polish Layer
// 3D panel tilt + electric-blue lightning cursor.
// Pulled into its own file because Manifest V3's default CSP blocks inline
// <script> tags in extension pages (side panel, popup, etc.) — only
// externally-sourced scripts are allowed to run.
// Safe to load last: no dependency on the other scripts. Respects
// prefers-reduced-motion and skips itself on touch/coarse pointers.
// ============================================================================

(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  /* ---------- 3D tilt + pointer-tracked glare on panels ---------- */
  if (!reduceMotion) {
    var panels = document.querySelectorAll('.panel');
    panels.forEach(function (panel) {
      panel.addEventListener('mousemove', function (e) {
        var r = panel.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width;
        var py = (e.clientY - r.top) / r.height;
        var rx = (0.5 - py) * 7;
        var ry = (px - 0.5) * 7;
        panel.style.setProperty('--rx', rx.toFixed(2) + 'deg');
        panel.style.setProperty('--ry', ry.toFixed(2) + 'deg');
        panel.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        panel.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      });
      panel.addEventListener('mouseleave', function () {
        panel.style.setProperty('--rx', '0deg');
        panel.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ---------- Electric lightning cursor ---------- */
  if (!finePointer) return; // touch/coarse pointers keep the native cursor

  document.body.classList.add('electric-cursor');

  var dot = document.createElement('div'); dot.id = 'cursorDot';
  var ring = document.createElement('div'); ring.id = 'cursorRing';
  var canvas = document.createElement('canvas'); canvas.id = 'cursorFx';
  document.body.appendChild(canvas);
  document.body.appendChild(ring);
  document.body.appendChild(dot);

  var ctx = canvas.getContext('2d');
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  var mx = window.innerWidth / 2, my = window.innerHeight / 2;
  var lastX = mx, lastY = my;
  var bolts = [];
  var MAX_BOLTS = 90;

  function spawnBolt(x1, y1, x2, y2, power) {
    power = power || 1;
    var steps = 3;
    var segs = [];
    var prevX = x1, prevY = y1;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var jitter = (1 - t) * 9 * power;
      var nx = x1 + (x2 - x1) * t + (Math.random() - 0.5) * jitter;
      var ny = y1 + (y2 - y1) * t + (Math.random() - 0.5) * jitter;
      segs.push([prevX, prevY, nx, ny]);
      prevX = nx; prevY = ny;
    }
    bolts.push({ segs: segs, life: 1, decay: 0.06 + Math.random() * 0.04 });
    if (bolts.length > MAX_BOLTS) bolts.shift();
  }

  function burst(x, y) {
    var n = 10;
    for (var i = 0; i < n; i++) {
      var ang = (Math.PI * 2 * i) / n + Math.random() * 0.3;
      var len = 22 + Math.random() * 20;
      spawnBolt(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 1.6);
    }
  }

  if (!reduceMotion) {
    window.addEventListener('mousemove', function (e) {
      mx = e.clientX; my = e.clientY;
      var dist = Math.hypot(mx - lastX, my - lastY);
      if (dist > 12) {
        spawnBolt(lastX, lastY, mx, my, Math.min(1.4, dist / 40));
        lastX = mx; lastY = my;
      }
    });
    window.addEventListener('mousedown', function (e) {
      burst(e.clientX, e.clientY);
      ring.classList.add('press');
    });
    window.addEventListener('mouseup', function () {
      ring.classList.remove('press');
    });
  } else {
    window.addEventListener('mousemove', function (e) { mx = e.clientX; my = e.clientY; });
  }

  document.addEventListener('mouseleave', function () { dot.style.opacity = 0; ring.style.opacity = 0; });
  document.addEventListener('mouseenter', function () { dot.style.opacity = 1; ring.style.opacity = 1; });

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = bolts.length - 1; i >= 0; i--) {
      var b = bolts[i];
      b.life -= b.decay;
      if (b.life <= 0) { bolts.splice(i, 1); continue; }
      var alpha = Math.max(0, b.life);
      ctx.lineWidth = 1.6 * alpha + 0.4;
      ctx.strokeStyle = 'rgba(96,200,255,' + alpha + ')';
      ctx.shadowColor = 'rgba(56,189,248,0.9)';
      ctx.shadowBlur = 12 * alpha;
      ctx.beginPath();
      for (var s = 0; s < b.segs.length; s++) {
        var seg = b.segs[s];
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    dot.style.transform = 'translate(' + mx + 'px, ' + my + 'px)';
    ring.style.transform = 'translate(' + mx + 'px, ' + my + 'px)';

    requestAnimationFrame(draw);
  }
  draw();
})();