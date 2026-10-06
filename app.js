(function () {
  'use strict';

  const RV_API = 'https://api.rainviewer.com/public/weather-maps.json';
  const RR_BASE = 'https://rainradar.ru/composite';
  const RR_MANIFEST = RR_BASE + '/manifest.json';
  const RR_ZOOM = 5;
  const RR_MIN_DBZ = 9;
  const RR_HISTORY = 19;
  const RGMC_GIF = 'https://meteoinfo.ru/hmc-output/rmap/phenomena.gif';
  /* Привязка GIF РГМЦ: сдвиг +0.77° с.ш., +1.46° в.д. — по скрину «Самара на гифе → Самара на карте» */
  const RGMC_BOUNDS = [[44.37, 25.66], [66.37, 65.26]];
  const MI_LIST = 'https://meteoinfo.ru/hmc-output/nowcast3/nowcast.php';
  const MI_TPL = 'https://meteoinfo.ru/res/nowcast/{z}0{x}0{y}/ncgi.php?tnz={z}&tnx={x}&tny={y}&TIME={t}&inidt={inidt}';
  const MI_TPL_FB = 'https://meteoinfo.ru/hmc-output/nowcast3/ncgi.php?tnz={z}&tnx={x}&tny={y}&TIME={t}&inidt={inidt}';
  const MOSCOW = [55.75, 37.62];
  const REFRESH_MS = 5 * 60 * 1000;
  const FRAME_MS = 450;

  /* Палитра RainRadar / ОЯ (dBZ → RGB), из FlowRad */
  const RAINRADAR_PALETTE = [
    {v:70,rgb:[100,4,101],lab:'смерч'},
    {v:65,rgb:[200,9,202],lab:'шквал сильный'},
    {v:59,rgb:[255,88,255],lab:'шквал умеренный'},
    {v:57,rgb:[255,171,255],lab:'шквал слабый'},
    {v:54,rgb:[88,14,8],lab:'град сильный'},
    {v:52,rgb:[143,73,15],lab:'град умеренный'},
    {v:50,rgb:[205,105,8],lab:'град слабый'},
    {v:48,rgb:[253,6,9],lab:'гроза (сильная)'},
    {v:46,rgb:[255,89,132],lab:'гроза'},
    {v:45,rgb:[255,171,128],lab:'гроза'},
    {v:37,rgb:[2,8,119],lab:'ливень сильный'},
    {v:35,rgb:[1,58,255],lab:'ливень умеренный'},
    {v:30,rgb:[62,137,253],lab:'ливень слабый'},
    {v:20,rgb:[1,154,8],lab:'осадки сильные'},
    {v:15,rgb:[1,194,94],lab:'осадки умеренные'},
    {v:10,rgb:[70,254,149],lab:'осадки слабые'},
    {v:9,rgb:[162,198,254],lab:'осадки слабые'}
  ];
  const RR_LUT = (() => {
    const lut = new Array(256).fill(null);
    for (let v = 0; v < 256; v++) {
      if (v < RR_MIN_DBZ) continue;
      for (const p of RAINRADAR_PALETTE) { if (v >= p.v) { lut[v] = p.rgb; break; } }
    }
    return lut;
  })();

  /* Метеоинфо мм/ч — цвета с легенды сайта (FlowRad) */
  const MI_CLASSES = [
    {lo:0.1,label:'0.1',rgb:[172,171,167]},
    {lo:0.3,label:'0.3',rgb:[135,134,128]},
    {lo:0.5,label:'0.5',rgb:[20,115,242]},
    {lo:1,label:'1',rgb:[14,20,132]},
    {lo:3,label:'3',rgb:[250,243,28]},
    {lo:5,label:'5',rgb:[197,232,48]},
    {lo:7,label:'7',rgb:[238,164,74]},
    {lo:10,label:'10',rgb:[233,100,33]},
    {lo:20,label:'20',rgb:[233,48,31]},
    {lo:30,label:'30',rgb:[142,247,131]},
    {lo:50,label:'50',rgb:[26,181,10]},
    {lo:100,label:'100',rgb:[247,147,221]},
    {lo:100,label:'>100',rgb:[203,70,192]}
  ];

  /* РГМЦ ОЯ — дискретная легенда phenomena (FlowRad LEGEND_TABLES.oya) */
  const OYA_LEGEND = [
    [4,'осадки слабые','#46fe93'],
    [5,'осадки умеренные','#00c25a'],
    [6,'осадки сильные','#009901'],
    [8,'ливень слабый','#3e88fe'],
    [9,'ливень умеренный','#0238fe'],
    [10,'ливень сильный','#010473'],
    [11,'гроза','#feab7c'],
    [12,'гроза','#ff557f'],
    [13,'гроза','#fd0101'],
    [14,'град слабый','#cd6701'],
    [15,'град умеренный','#8f4709'],
    [16,'град сильный','#550b02'],
    [17,'шквал слабый','#ffaaff'],
    [18,'шквал умеренный','#ff55ff'],
    [19,'шквал сильный','#c700c7'],
    [20,'смерч','#3b3a5b']
  ];

  let map, radarLayer = null, gifLayer = null, meteoLayer = null;
  let frames = [], frameIndex = 0, host = '';
  let rrTimestamps = [], rrTs = null, rrCanvas = null, rrCtx = null, rrTiles = new Map(), rrDrawToken = 0;
  let miFrames = [], miBaseInidt = 0;
  let playing = false, playTimer = null;
  let currentOpacity = 0.8;
  let baseLayers = {}, activeBase = 'dark', activeSrc = 'rainviewer';
  let tip = null;

  const $ = id => document.getElementById(id);
  const loading = $('loading');
  const timeline = $('timeline');
  const timeLabel = $('time-label');
  const timeAgo = $('time-ago');
  const statusEl = $('status');
  const timelinePanel = $('timeline-panel');
  const btnPlay = $('btn-play');
  const iconPlay = $('icon-play');
  const iconPause = $('icon-pause');
  const legendPanel = $('legend-panel');
  const legendList = $('legend-list');
  const legendTitle = $('legend-title');

  $('disc-accept').addEventListener('click', () => {
    $('disclaimer').classList.add('hidden');
    initMap();
  });

  function hex(rgb) {
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function setStatus(html) {
    statusEl.innerHTML = html;
  }

  function renderLegend(src) {
    legendList.innerHTML = '';
    let rows = [];
    if (src === 'rainradar') {
      legendTitle.textContent = 'ОЯ / dBZ';
      const seen = new Set();
      RAINRADAR_PALETTE.slice().reverse().forEach(p => {
        if (seen.has(p.lab)) return;
        seen.add(p.lab);
        rows.push([p.lab, hex(p.rgb)]);
      });
    } else if (src === 'meteoinfo') {
      legendTitle.textContent = 'мм/ч';
      rows = MI_CLASSES.map(c => [c.label + ' мм/ч', hex(c.rgb)]);
    } else if (src === 'rgmc') {
      legendTitle.textContent = 'ОЯ РГМЦ';
      rows = OYA_LEGEND.map(r => [r[1], r[2]]);
    } else {
      legendTitle.textContent = 'RainViewer';
      rows = [
        ['слабые','#96c8ff'],['умеренные','#3cc850'],['сильные','#fac828'],['ливень','#e63c2d'],['экстрем.','#c828a0']
      ];
    }
    rows.forEach(([lab, col]) => {
      const row = document.createElement('div');
      row.className = 'leg-row';
      row.innerHTML = '<span class="leg-sw" style="background:' + col + '"></span><span class="leg-lab">' + lab + '</span>';
      legendList.appendChild(row);
    });
    legendPanel.hidden = false;
  }

  function initMap() {
    map = L.map('map', { center: MOSCOW, zoom: 5, preferCanvas: true, maxZoom: 12, minZoom: 3, zoomControl: false });

    baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &copy; CARTO', subdomains: 'abcd', maxZoom: 19
    });
    baseLayers.sat = L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri', maxZoom: 18
      }),
      L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
        attribution: '', maxZoom: 18, opacity: 0.9
      }),
      L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', {
        attribution: '', maxZoom: 18, opacity: 0.55
      })
    ]);
    baseLayers.osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OSM', maxZoom: 19
    });
    baseLayers.dark.addTo(map);

    document.querySelectorAll('.layer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const layer = btn.dataset.layer;
        if (layer === activeBase) return;
        map.removeLayer(baseLayers[activeBase]);
        baseLayers[layer].addTo(map);
        activeBase = layer;
        document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.querySelectorAll('.src-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.src;
        if (src === activeSrc) return;
        switchSource(src);
        document.querySelectorAll('.src-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    $('opacity').addEventListener('input', e => {
      currentOpacity = e.target.value / 100;
      if (radarLayer) radarLayer.setOpacity(currentOpacity);
      if (rrCanvas) rrCanvas.style.opacity = currentOpacity;
      if (gifLayer) gifLayer.setOpacity(currentOpacity);
      if (meteoLayer) meteoLayer.setOpacity(currentOpacity);
    });

    $('btn-prev').addEventListener('click', () => { stopPlay(); stepFrame(-1); });
    $('btn-next').addEventListener('click', () => { stopPlay(); stepFrame(1); });
    btnPlay.addEventListener('click', togglePlay);
    timeline.addEventListener('input', () => { stopPlay(); setFrame(+timeline.value); });

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
      if (e.key === 'ArrowLeft') { stopPlay(); stepFrame(-1); }
      if (e.key === 'ArrowRight') { stopPlay(); stepFrame(1); }
    });

    map.on('moveend zoomend', () => {
      if (activeSrc === 'rainradar' && rrTs) rrScheduleDraw(rrTs);
    });

    map.on('click', onMapClick);

    loadRainViewer();
    renderLegend('rainviewer');
    setInterval(() => {
      if (activeSrc === 'rainviewer') loadRainViewer();
      if (activeSrc === 'rainradar') loadRainRadar(true);
      if (activeSrc === 'rgmc') loadRgmc(true);
      if (activeSrc === 'meteoinfo') loadMeteoinfo(true);
    }, REFRESH_MS);
  }

  function onMapClick(e) {
    if (tip) { map.closePopup(tip); tip = null; }
    const lat = e.latlng.lat;
    const lon = e.latlng.lng;
    const coord = lat.toFixed(2) + '°, ' + lon.toFixed(2) + '°';
    let title = '';
    let val = '—';
    let unit = '';

    if (activeSrc === 'rainradar') {
      title = 'ОЯ';
      // sample from processed tile LUT if possible
      const z = RR_ZOOM;
      const x = rrX(lon, z), y = rrY(lat, z);
      const key = rrTs + '/' + x + '/' + y;
      const entry = rrTiles.get(key);
      if (entry && entry.canvas) {
        try {
          const west = rrLon(x, z), east = rrLon(x + 1, z);
          const north = rrLat(y, z), south = rrLat(y + 1, z);
          const px = Math.floor((lon - west) / (east - west) * entry.canvas.width);
          const py = Math.floor((north - lat) / (north - south) * entry.canvas.height);
          const ctx = entry.canvas.getContext('2d', { willReadFrequently: true });
          const p = ctx.getImageData(Math.max(0, px), Math.max(0, py), 1, 1).data;
          if (p[3] > 20) {
            // reverse nearest palette label
            let best = 'осадки', bd = 1e9;
            for (const pr of RAINRADAR_PALETTE) {
              const d = Math.abs(pr.rgb[0] - p[0]) + Math.abs(pr.rgb[1] - p[1]) + Math.abs(pr.rgb[2] - p[2]);
              if (d < bd) { bd = d; best = pr.lab; }
            }
            val = best;
          } else val = 'нет';
        } catch (_) { val = '—'; }
      } else val = '—';
    } else if (activeSrc === 'meteoinfo') {
      title = 'мм/ч';
      unit = ' мм/ч';
      val = 'см. шкалу';
    } else if (activeSrc === 'rgmc') {
      title = 'ОЯ РГМЦ';
      val = 'см. шкалу';
    } else {
      title = 'RainViewer';
      val = 'осадки';
    }

    const html = '<div class="tip-inner"><div class="tip-coord">' + coord + '</div>' +
      '<div class="tip-title">' + title + '</div>' +
      '<div class="tip-val">' + val + (val !== '—' && val !== 'нет' && val !== 'см. шкалу' ? unit : '') + '</div></div>';
    tip = L.popup({ className: 'radar-tip', closeButton: false, maxWidth: 160, offset: [0, -8] })
      .setLatLng(e.latlng)
      .setContent(html)
      .openOn(map);
  }

  function clearOverlays() {
    stopPlay();
    if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; }
    if (gifLayer) { map.removeLayer(gifLayer); gifLayer = null; }
    rgmcToken++; gifPlaying = false; gifState = null; gifFrozenEl = null; dropLiveImg();
    if (gifTimer) { clearTimeout(gifTimer); gifTimer = null; }
    if (meteoLayer) { map.removeLayer(meteoLayer); meteoLayer = null; }
    rrHideCanvas();
    rrTiles.clear();
    frames = []; frameIndex = 0; rrTimestamps = []; miFrames = [];
    if (tip) { map.closePopup(tip); tip = null; }
  }

  function switchSource(src) {
    activeSrc = src;
    clearOverlays();
    renderLegend(src);
    if (src === 'rainviewer') {
      setStatus('RainViewer · глобальный композит');
      timelinePanel.style.display = '';
      setControlsEnabled(true);
      loadRainViewer();
    } else if (src === 'rainradar') {
      setStatus('RainRadar.ru · композит РФ · ОЯ/dBZ');
      timelinePanel.style.display = '';
      setControlsEnabled(true);
      loadRainRadar();
    } else if (src === 'rgmc') {
      setStatus('РГМЦ / ЦАО · <a href="https://meteoinfo.ru/radanim" target="_blank" rel="noopener">radanim</a>');
      timelinePanel.style.display = 'none';
      setControlsEnabled(false);
      loadRgmc();
    } else {
      setStatus('Метеоинфо · nowcast мм/ч · <a href="https://meteoinfo.ru/nowcasting" target="_blank" rel="noopener">nowcasting</a>');
      timelinePanel.style.display = '';
      setControlsEnabled(true);
      loadMeteoinfo();
    }
  }

  function setControlsEnabled(on) {
    $('btn-prev').disabled = !on;
    $('btn-next').disabled = !on;
    btnPlay.disabled = !on;
    timeline.disabled = !on;
  }
  function showLoading(on) { loading.classList.toggle('show', on); }

  function stepFrame(dir) {
    if (activeSrc === 'rainviewer' || activeSrc === 'rainradar' || activeSrc === 'meteoinfo') setFrame(frameIndex + dir);
  }

  // ——— RainViewer ———
  async function loadRainViewer() {
    showLoading(true);
    try {
      const res = await fetch(RV_API + '?_=' + Date.now());
      const data = await res.json();
      host = data.host || 'https://tilecache.rainviewer.com';
      frames = [...((data.radar && data.radar.past) || []), ...((data.radar && data.radar.nowcast) || [])];
      if (!frames.length) throw new Error('empty');
      timeline.max = frames.length - 1;
      frameIndex = frames.length - 1;
      setFrame(frameIndex);
    } catch (e) {
      console.error(e);
      timeLabel.textContent = 'ошибка RainViewer';
    }
    showLoading(false);
  }

  function setFrame(idx) {
    if (activeSrc === 'rainviewer') {
      if (!frames.length) return;
      frameIndex = ((idx % frames.length) + frames.length) % frames.length;
      const frame = frames[frameIndex];
      timeline.value = frameIndex;
      const url = host + frame.path + '/256/{z}/{x}/{y}/2/1_1.png';
      const next = L.tileLayer(url, { opacity: currentOpacity, zIndex: 200, maxZoom: 12, maxNativeZoom: 7, tileSize: 256 });
      next.addTo(map);
      const old = radarLayer;
      radarLayer = next;
      if (old) setTimeout(() => { if (map.hasLayer(old)) map.removeLayer(old); }, 160);
      labelTime(frame.time);
    } else if (activeSrc === 'rainradar') {
      if (!rrTimestamps.length) return;
      frameIndex = ((idx % rrTimestamps.length) + rrTimestamps.length) % rrTimestamps.length;
      rrTs = rrTimestamps[frameIndex];
      timeline.value = frameIndex;
      rrScheduleDraw(rrTs);
      labelTime(rrTs);
    } else if (activeSrc === 'meteoinfo') {
      if (!miFrames.length) return;
      frameIndex = ((idx % miFrames.length) + miFrames.length) % miFrames.length;
      timeline.value = frameIndex;
      miShowFrame(frameIndex);
    }
  }

  function labelTime(ts) {
    const d = new Date(ts * 1000);
    const diff = Math.round((Date.now() - ts * 1000) / 60000);
    const p = n => String(n).padStart(2, '0');
    timeLabel.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ' · ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
    timeAgo.textContent = diff < 1 ? 'сейчас' : (diff < 60 ? diff + ' мин назад' : Math.floor(diff / 60) + ' ч назад');
  }

  // ——— RainRadar ———
  function rrX(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }
  function rrY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
  }
  function rrLon(x, z) { return x / (1 << z) * 360 - 180; }
  function rrLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / (1 << z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function rrUrl(ts, x, y) { return RR_BASE + '/' + ts + '/' + RR_ZOOM + '/' + x + '_' + y + '.png'; }

  function rrEnsureCanvas() {
    if (rrCanvas) return;
    rrCanvas = document.createElement('canvas');
    rrCanvas.className = 'rainradar-exact-canvas pixelated';
    rrCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:410;image-rendering:pixelated';
    map.getPanes().overlayPane.appendChild(rrCanvas);
    rrCtx = rrCanvas.getContext('2d');
  }
  function rrHideCanvas() { if (rrCanvas) rrCanvas.style.display = 'none'; }
  function rrShowCanvas() {
    rrEnsureCanvas();
    rrCanvas.style.display = 'block';
    rrCanvas.style.opacity = currentOpacity;
  }

  function rrProcessTile(img) {
    const iw = img.naturalWidth || img.width || 264;
    const ih = img.naturalHeight || img.height || 264;
    const src = document.createElement('canvas');
    src.width = iw; src.height = ih;
    const sc = src.getContext('2d', { willReadFrequently: true });
    sc.drawImage(img, 0, 0);
    const id = sc.getImageData(0, 0, iw, ih);
    const d = id.data;
    const out = document.createElement('canvas');
    out.width = iw; out.height = ih;
    const oc = out.getContext('2d');
    oc.imageSmoothingEnabled = false;
    const oid = oc.createImageData(iw, ih);
    const od = oid.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3], r = d[i] | 0;
      if (a < 8 || r <= 0 || r > 200 || r < RR_MIN_DBZ) { od[i + 3] = 0; continue; }
      const rgb = RR_LUT[r];
      if (!rgb) { od[i + 3] = 0; continue; }
      od[i] = rgb[0]; od[i + 1] = rgb[1]; od[i + 2] = rgb[2]; od[i + 3] = 255;
    }
    oc.putImageData(oid, 0, 0);
    return out;
  }

  function rrLoadTile(ts, x, y) {
    const key = ts + '/' + x + '/' + y;
    if (rrTiles.has(key)) return Promise.resolve(rrTiles.get(key));
    const url = rrUrl(ts, x, y);
    return new Promise(resolve => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const canvas = rrProcessTile(im);
          const entry = { canvas, x, y, ts };
          rrTiles.set(key, entry);
          resolve(entry);
        } catch (e) { resolve(null); }
      };
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  function rrVisibleTiles() {
    const b = map.getBounds().pad(0.2);
    const z = RR_ZOOM, max = (1 << z) - 1;
    let x0 = Math.max(0, rrX(b.getWest(), z) - 1);
    let x1 = Math.min(max, rrX(b.getEast(), z) + 1);
    let y0 = Math.max(0, rrY(b.getNorth(), z) - 1);
    let y1 = Math.min(max, rrY(b.getSouth(), z) + 1);
    const a = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) a.push({ x, y });
    return a;
  }

  async function rrScheduleDraw(ts) {
    const token = ++rrDrawToken;
    rrShowCanvas();
    const size = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    rrCanvas.width = Math.max(1, Math.round(size.x * dpr));
    rrCanvas.height = Math.max(1, Math.round(size.y * dpr));
    rrCanvas.style.width = size.x + 'px';
    rrCanvas.style.height = size.y + 'px';
    const panePos = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(rrCanvas, panePos);

    const tiles = rrVisibleTiles();
    await Promise.all(tiles.map(t => rrLoadTile(ts, t.x, t.y)));
    if (token !== rrDrawToken || activeSrc !== 'rainradar') return;

    rrCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rrCtx.clearRect(0, 0, size.x, size.y);
    rrCtx.imageSmoothingEnabled = false;
    for (const t of tiles) {
      const entry = rrTiles.get(ts + '/' + t.x + '/' + t.y);
      if (!entry || !entry.canvas) continue;
      const nw = map.latLngToContainerPoint(L.latLng(rrLat(t.y, RR_ZOOM), rrLon(t.x, RR_ZOOM)));
      const se = map.latLngToContainerPoint(L.latLng(rrLat(t.y + 1, RR_ZOOM), rrLon(t.x + 1, RR_ZOOM)));
      const w = se.x - nw.x, h = se.y - nw.y;
      if (w > 0 && h > 0) rrCtx.drawImage(entry.canvas, nw.x, nw.y, w, h);
    }
  }

  async function loadRainRadar() {
    showLoading(true);
    try {
      const res = await fetch(RR_MANIFEST + '?' + Math.floor(Date.now() / 1000), { mode: 'cors' });
      const data = await res.json();
      rrTimestamps = data.map(e => e[0]).sort((a, b) => a - b).slice(-RR_HISTORY);
      if (!rrTimestamps.length) throw new Error('empty');
      timeline.max = rrTimestamps.length - 1;
      frameIndex = rrTimestamps.length - 1;
      rrTs = rrTimestamps[frameIndex];
      timeline.value = frameIndex;
      map.setView(MOSCOW, 5);
      await rrScheduleDraw(rrTs);
      labelTime(rrTs);
    } catch (e) {
      console.error(e);
      timeLabel.textContent = 'ошибка RainRadar';
    }
    showLoading(false);
  }

  // ——— РГМЦ GIF ———
  // Всегда стоп-кадр. Анимация — ТОЛЬКО по кнопке ▶ (свой плеер кадров).
  // Остаются только цвета шкалы ОЯ; фон, подписи, остатки шкалы, «ореол» вырезаются.
  // Рисуется в canvas размером с экран (а не на весь гиф) → быстро на любом зуме.
  let gifPlaying = false, gifTimer = null, gifState = null, gifFrozenEl = null, rgmcToken = 0, gifSrcW = 0, rgmcPal = null;
  const RGMC_START_LAST = true;      // стоп-кадр = последний кадр гифа (false → первый)
  const RGMC_MIN_SAT = 55;           // порог цветности: max-min канала, ниже — фон
  const RGMC_FILL_R = 4;             // заливка дыр (бывшие города/подписи), в пикселях гифа
  const RGMC_CROP_PCT = 2;           // срез краёв гифа, %
  const RGMC_MASKS = [               // вырезаемые прямоугольники [x0,y0,x1,y1] в % гифа (остатки шкалы/эмблемы)
    [0, 0, 13, 34],                  // слева‑сверху
    [0, 87, 9, 100]                  // слева‑снизу (эмблема ЦАО)
  ];
  const RGMC_PAL_TOL = 110;          // допуск до цветов шкалы ОЯ (сумма |ΔRGB|); остальное — не данные

  // Подгонка привязки без правки кода: ?rgmc=dLat,dLon
  function rgmcBounds() {
    let dLat = 0, dLon = 0;
    try {
      const v = new URLSearchParams(location.search).get('rgmc');
      if (v) { const a = v.split(',').map(Number); dLat = a[0] || 0; dLon = a[1] || 0; }
    } catch (_) {}
    return [[RGMC_BOUNDS[0][0] + dLat, RGMC_BOUNDS[0][1] + dLon],
            [RGMC_BOUNDS[1][0] + dLat, RGMC_BOUNDS[1][1] + dLon]];
  }

  // Слой: один canvas размером с экран (+запас), перерисовывается только видимая часть гифа
  const ViewLayer = L.Layer.extend({
    initialize: function (src, w, h, bounds, opts) {
      this._src = src; this._w = w; this._h = h; this._b = L.latLngBounds(bounds); L.setOptions(this, opts || {});
    },
    onAdd: function (m) {
      const c = this._c = document.createElement('canvas');
      c.className = 'leaflet-zoom-animated' + (this.options.filtered ? ' gif-clean' : '');
      c.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:200;will-change:transform';
      c.style.opacity = this.options.opacity != null ? this.options.opacity : 1;
      this._ctx = c.getContext('2d');
      m.getPane('overlayPane').appendChild(c);
      this.redraw();
    },
    onRemove: function () { if (this._c) L.DomUtil.remove(this._c); this._c = null; },
    getEvents: function () { return { moveend: this.redraw, resize: this.redraw, zoomanim: this._anim }; },
    setOpacity: function (o) { this.options.opacity = o; if (this._c) this._c.style.opacity = o; return this; },
    setSource: function (src) { this._src = src; this.redraw(); },
    _anim: function (e) {
      if (!this._c || !this._tl) return;
      const m = this._map;
      L.DomUtil.setTransform(this._c, m._latLngToNewLayerPoint(this._tl, e.zoom, e.center), m.getZoomScale(e.zoom, m.getZoom()));
    },
    redraw: function () {
      const m = this._map, c = this._c;
      if (!m || !c) return;
      const sz = m.getSize(), px = Math.round(sz.x * 0.15), py = Math.round(sz.y * 0.15);
      const cw = sz.x + 2 * px, ch = sz.y + 2 * py;
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; } else this._ctx.clearRect(0, 0, cw, ch);
      const origin = m.containerPointToLayerPoint([-px, -py]).round();
      L.DomUtil.setPosition(c, origin);
      this._tl = m.layerPointToLatLng(origin);
      const tl = m.latLngToLayerPoint(this._b.getNorthWest()), br = m.latLngToLayerPoint(this._b.getSouthEast());
      const dx = tl.x - origin.x, dy = tl.y - origin.y, dw = br.x - tl.x, dh = br.y - tl.y;
      if (!(dw > 0 && dh > 0) || !this._src) return;
      // видимая часть гифа
      const x0 = Math.max(0, -dx), y0 = Math.max(0, -dy), x1 = Math.min(dw, cw - dx), y1 = Math.min(dh, ch - dy);
      if (x1 <= x0 || y1 <= y0) return;
      const kx = this._w / dw, ky = this._h / dh;
      const ctx = this._ctx;
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      if (this.options.clipRects) {      // пиксели недоступны (CORS): срез краёв и маски делаем клипом
        ctx.beginPath();
        const cr = RGMC_CROP_PCT / 100;
        ctx.rect(dx + dw * cr, dy + dh * cr, dw * (1 - 2 * cr), dh * (1 - 2 * cr));
        for (const r of RGMC_MASKS) {
          const a0 = Math.max(r[0] / 100, cr), b0 = Math.max(r[1] / 100, cr), a1 = Math.min(r[2] / 100, 1 - cr), b1 = Math.min(r[3] / 100, 1 - cr);
          if (a1 > a0 && b1 > b0) ctx.rect(dx + dw * a0, dy + dh * b0, dw * (a1 - a0), dh * (b1 - b0));
        }
        ctx.clip('evenodd');
      }
      ctx.drawImage(this._src, x0 * kx, y0 * ky, (x1 - x0) * kx, (y1 - y0) * ky, dx + x0, dy + y0, x1 - x0, y1 - y0);
      ctx.restore();
      if (this.options.onResize) this.options.onResize(dw / this._w);
    }
  });

  function isGrayBg(r, g, b, a) {
    if (a < 12) return true;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < RGMC_MIN_SAT) return true;               // серый / белый / чёрный / подписи
    const mean = (r + g + b) / 3;
    if (mn >= 190 && mx - mn <= 70) return true;           // почти белое
    if (mx - mn <= 75 && mean >= 140 && b >= r - 5 && b >= g - 5) return true;   // бледно‑голубой / сиреневый
    return false;
  }

  function cleanPixels(src) {
    if (!rgmcPal) rgmcPal = OYA_LEGEND.map(r => [parseInt(r[2].slice(1, 3), 16), parseInt(r[2].slice(3, 5), 16), parseInt(r[2].slice(5, 7), 16)]);
    const d = new Uint8ClampedArray(src), cache = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (isGrayBg(d[i], d[i + 1], d[i + 2], d[i + 3])) { d[i + 3] = 0; continue; }
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      let ok = cache.get(key);
      if (ok === undefined) {
        ok = false;
        for (const c of rgmcPal) {
          if (Math.abs(c[0] - d[i]) + Math.abs(c[1] - d[i + 1]) + Math.abs(c[2] - d[i + 2]) <= RGMC_PAL_TOL) { ok = true; break; }
        }
        cache.set(key, ok);
      }
      if (!ok) d[i + 3] = 0;
    }
    return d;
  }

  // чистка кадра: срез краёв, маски, мелкие обрывки у края, закрытие дыр (бывшие города)
  function processFrame(src, W, H) {
    const d = cleanPixels(src), N = W * H;
    const cx = Math.round(W * RGMC_CROP_PCT / 100), cy = Math.round(H * RGMC_CROP_PCT / 100);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x < cx || x >= W - cx || y < cy || y >= H - cy) d[(y * W + x) * 4 + 3] = 0;
    }
    for (const m of RGMC_MASKS) {
      const mx0 = Math.round(W * m[0] / 100), my0 = Math.round(H * m[1] / 100);
      const mx1 = Math.min(W, Math.round(W * m[2] / 100)), my1 = Math.min(H, Math.round(H * m[3] / 100));
      for (let y = my0; y < my1; y++) for (let x = mx0; x < mx1; x++) d[(y * W + x) * 4 + 3] = 0;
    }
    // мелкие компоненты рядом с краем (BFS на типизированной очереди)
    const band = Math.round(Math.max(W, H) * 0.06);
    const seen = new Uint8Array(N), q = new Int32Array(N);
    for (let s0 = 0; s0 < N; s0++) {
      if (seen[s0] || !d[s0 * 4 + 3]) continue;
      let head = 0, tail = 0, nearEdge = false;
      q[tail++] = s0; seen[s0] = 1;
      while (head < tail) {
        const i = q[head++], x = i % W, y = (i / W) | 0;
        if (x < band || x >= W - band || y < band || y >= H - band) nearEdge = true;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= W) continue;
            const j = ny * W + nx;
            if (!seen[j] && d[j * 4 + 3]) { seen[j] = 1; q[tail++] = j; }
          }
        }
      }
      if (nearEdge && tail < 160) for (let k = 0; k < tail; k++) d[q[k] * 4 + 3] = 0;
    }
    // закрытие дыр: дилатация (цвета соседей) → эрозия
    const R = RGMC_FILL_R;
    const D = new Uint8Array(N), col = new Uint8ClampedArray(N * 3);
    for (let i = 0; i < N; i++) if (d[i * 4 + 3]) { D[i] = 1; col[i * 3] = d[i * 4]; col[i * 3 + 1] = d[i * 4 + 1]; col[i * 3 + 2] = d[i * 4 + 2]; }
    const dilate = (horiz) => {
      const outer = horiz ? H : W, inner = horiz ? W : H;
      const src1 = D.slice(), c1 = col.slice();
      const left = new Int32Array(inner), right = new Int32Array(inner);
      for (let a = 0; a < outer; a++) {
        const idx = k => horiz ? a * W + k : k * W + a;
        let last = -1;
        for (let k = 0; k < inner; k++) { if (src1[idx(k)]) last = k; left[k] = last; }
        last = -1;
        for (let k = inner - 1; k >= 0; k--) { if (src1[idx(k)]) last = k; right[k] = last; }
        for (let k = 0; k < inner; k++) {
          const i = idx(k);
          if (src1[i]) continue;
          const l = left[k] >= 0 && k - left[k] <= R ? idx(left[k]) : -1;
          const r = right[k] >= 0 && right[k] - k <= R ? idx(right[k]) : -1;
          if (l < 0 && r < 0) continue;
          D[i] = 1;
          for (let ch = 0; ch < 3; ch++) col[i * 3 + ch] = l >= 0 && r >= 0 ? (c1[l * 3 + ch] + c1[r * 3 + ch]) >> 1 : c1[(l >= 0 ? l : r) * 3 + ch];
        }
      }
    };
    dilate(true); dilate(false);
    const E = D.slice();
    const erode = (horiz) => {
      const outer = horiz ? H : W, inner = horiz ? W : H;
      const cur = E.slice(), pre = new Int32Array(inner + 1);
      for (let a = 0; a < outer; a++) {
        const idx = k => horiz ? a * W + k : k * W + a;
        for (let k = 0; k < inner; k++) pre[k + 1] = pre[k] + (cur[idx(k)] ? 0 : 1);
        for (let k = 0; k < inner; k++) {
          const lo = Math.max(0, k - R), hi = Math.min(inner - 1, k + R);
          E[idx(k)] = pre[hi + 1] - pre[lo] === 0 ? 1 : 0;
        }
      }
    };
    erode(true); erode(false);
    for (let i = 0; i < N; i++) {
      if (!d[i * 4 + 3] && E[i] && D[i]) {
        d[i * 4] = col[i * 3]; d[i * 4 + 1] = col[i * 3 + 1]; d[i * 4 + 2] = col[i * 3 + 2]; d[i * 4 + 3] = 255;
      }
    }
    return d;
  }

  // ——— мини‑декодер GIF (кадры → RGBA), чтобы управлять анимацией самим ———
  function lzwDecode(minCode, data, size) {
    const out = new Uint8Array(size);
    const clear = 1 << minCode, eoi = clear + 1;
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;
    let codeSize = minCode + 1, next = eoi + 1, bits = 0, acc = 0, pos = 0, old = -1, first = 0, o = 0;
    while (o < size) {
      while (bits < codeSize) {
        if (pos >= data.length) return out;
        acc |= data[pos++] << bits; bits += 8;
      }
      let code = acc & ((1 << codeSize) - 1);
      acc >>= codeSize; bits -= codeSize;
      if (code === clear) { codeSize = minCode + 1; next = eoi + 1; old = -1; continue; }
      if (code === eoi) break;
      if (old === -1) { out[o++] = suffix[code]; old = code; first = code; continue; }
      const inCode = code;
      let sp = 0;
      if (code >= next) { stack[sp++] = first; code = old; }
      while (code >= clear) { stack[sp++] = suffix[code]; code = prefix[code]; }
      first = suffix[code];
      stack[sp++] = first;
      if (next < 4096) {
        prefix[next] = old; suffix[next] = first; next++;
        if ((next & ((1 << codeSize) - 1)) === 0 && codeSize < 12) codeSize++;
      }
      old = inCode;
      while (sp > 0 && o < size) out[o++] = stack[--sp];
    }
    return out;
  }

  function parseGif(buf) {
    const d = new Uint8Array(buf);
    if (String.fromCharCode(d[0], d[1], d[2]) !== 'GIF') throw new Error('not gif');
    const W = d[6] | (d[7] << 8), H = d[8] | (d[9] << 8), fl = d[10];
    let p = 13, gct = null;
    if (fl & 0x80) { const n = 2 << (fl & 7); gct = d.subarray(p, p + n * 3); p += n * 3; }
    const full = new Uint8ClampedArray(W * H * 4);
    const frames = [];
    let gce = null, prev = null;
    while (p < d.length) {
      const b = d[p++];
      if (b === 0x3B) break;
      if (b === 0x21) {
        const label = d[p++];
        if (label === 0xF9) {
          const f = d[p + 1];
          gce = { disp: (f >> 2) & 7, tr: (f & 1) ? d[p + 4] : -1, delay: (d[p + 2] | (d[p + 3] << 8)) * 10 };
        }
        let sz; while ((sz = d[p++]) !== 0) p += sz;
      } else if (b === 0x2C) {
        const x = d[p] | (d[p + 1] << 8), y = d[p + 2] | (d[p + 3] << 8);
        const w = d[p + 4] | (d[p + 5] << 8), h = d[p + 6] | (d[p + 7] << 8), f = d[p + 8];
        p += 9;
        let ct = gct;
        if (f & 0x80) { const n = 2 << (f & 7); ct = d.subarray(p, p + n * 3); p += n * 3; }
        const minCode = d[p++];
        const chunks = []; let tot = 0, sz;
        while ((sz = d[p++]) !== 0) { chunks.push(d.subarray(p, p + sz)); p += sz; tot += sz; }
        const data = new Uint8Array(tot); let q = 0;
        for (const c of chunks) { data.set(c, q); q += c.length; }
        const idx = lzwDecode(minCode, data, w * h);

        // утилизация предыдущего кадра
        if (prev) {
          if (prev.disp === 2) {
            for (let yy = 0; yy < prev.h; yy++) for (let xx = 0; xx < prev.w; xx++) {
              const o = ((prev.y + yy) * W + prev.x + xx) * 4;
              full[o] = full[o + 1] = full[o + 2] = full[o + 3] = 0;
            }
          } else if (prev.disp === 3 && prev.snap) full.set(prev.snap);
        }
        const g = gce || { disp: 0, tr: -1, delay: 0 };
        const snap = g.disp === 3 ? new Uint8ClampedArray(full) : null;
        const rows = new Array(h);
        if (f & 0x40) {            // interlace
          let r = 0;
          for (const [s0, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let yy = s0; yy < h; yy += st) rows[r++] = yy;
        } else for (let yy = 0; yy < h; yy++) rows[yy] = yy;
        for (let r = 0; r < h; r++) {
          const yy = rows[r];
          for (let xx = 0; xx < w; xx++) {
            const ci = idx[r * w + xx];
            if (ci === g.tr) continue;
            const o = ((y + yy) * W + x + xx) * 4;
            full[o] = ct[ci * 3]; full[o + 1] = ct[ci * 3 + 1]; full[o + 2] = ct[ci * 3 + 2]; full[o + 3] = 255;
          }
        }
        frames.push({ data: new Uint8ClampedArray(full), delay: g.delay });
        prev = { disp: g.disp, x, y, w, h, snap };
        gce = null;
      } else break;
    }
    if (!frames.length) throw new Error('no frames');
    return { W, H, frames };
  }

  function stopGifTimer() {
    if (gifTimer) { clearTimeout(gifTimer); clearInterval(gifTimer); gifTimer = null; }
  }
  function setPlayIcons(playing) {
    iconPlay.style.display = playing ? 'none' : 'block';
    iconPause.style.display = playing ? 'block' : 'none';
  }
  function setFillRadius(sx) {            // радиус заливки в экранных пикселях (SVG‑фильтр, только когда нет доступа к пикселям)
    const rr = Math.min(24, Math.max(1, RGMC_FILL_R * sx));
    ['gkDil', 'gkEro'].forEach(id => { const n = $(id); if (n) n.setAttribute('radius', rr.toFixed(1)); });
    const b = $('gkBlur'); if (b) b.setAttribute('stdDeviation', (rr * 0.9).toFixed(1));
  }
  function mountSrc(src, w, h, filtered) {
    if (gifLayer) { try { map.removeLayer(gifLayer); } catch (_) {} gifLayer = null; }
    const opts = { opacity: currentOpacity };
    if (filtered) { opts.filtered = true; opts.clipRects = true; opts.onResize = setFillRadius; }
    gifLayer = new ViewLayer(src, w, h, rgmcBounds(), opts);
    gifLayer.addTo(map);
  }
  function loadImg(url, cors) {
    return new Promise(res => {
      const im = new Image();
      if (cors) im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  // кадр gif: чистим лениво (по одному), остальные — в фоне, чтобы не вешать страницу
  function gifFrame(s, i) {
    if (!s.imgs[i]) s.imgs[i] = processFrame(s.raw[i], s.W, s.H);
    return s.imgs[i];
  }
  function drawGifFrame(i) {
    const s = gifState; if (!s || s.mode !== 'frames') return;
    s.idx = i;
    s.ctx.putImageData(new ImageData(gifFrame(s, i), s.W, s.H), 0, 0);
    if (gifLayer) gifLayer.redraw();
    timeLabel.textContent = gifPlaying ? 'РГМЦ · кадр ' + (i + 1) + '/' + s.raw.length : 'РГМЦ · стоп';
  }
  function warmFrames(s, token) {
    let k = 0;
    const step = () => {
      if (token !== rgmcToken || gifState !== s) return;
      while (k < s.raw.length && s.imgs[k]) k++;
      if (k >= s.raw.length) return;
      gifFrame(s, k);
      setTimeout(step, 40);
    };
    setTimeout(step, 300);
  }

  // Стоп-кадр без доступа к пикселям (CORS закрыт)
  async function buildFrozen() {
    let im = await loadImg('rgmc-frame0.png?t=' + Date.now(), false), clean = false;
    if (!im) { im = await loadImg(RGMC_GIF + '?t=' + Date.now(), false); clean = true; }
    if (!im) throw new Error('gif load');
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    gifSrcW = c.width;
    c._filtered = false;
    if (clean) {
      try {
        const id = ctx.getImageData(0, 0, c.width, c.height);
        id.data.set(processFrame(id.data, c.width, c.height));
        ctx.putImageData(id, 0, 0);
      } catch (_) { c._filtered = true; }     // canvas «tainted» → фильтр + клип при отрисовке
    }
    return c;
  }

  async function loadRgmc(refresh) {
    if (refresh && gifPlaying) return;           // во время просмотра анимации не сбрасываем
    const token = ++rgmcToken;
    showLoading(true);
    stopGifTimer();
    gifPlaying = false;
    setPlayIcons(false);
    gifState = null; gifFrozenEl = null;
    try {
      let ok = false;
      try {
        const r = await fetch(RGMC_GIF + '?t=' + Date.now(), { mode: 'cors', cache: 'no-store' });
        if (!r.ok) throw new Error('http');
        const g = parseGif(await r.arrayBuffer());
        if (token !== rgmcToken) return;
        const c = document.createElement('canvas');
        c.width = g.W; c.height = g.H;
        const s = { mode: 'frames', canvas: c, ctx: c.getContext('2d'), W: g.W, H: g.H,
          raw: g.frames.map(f => f.data), imgs: new Array(g.frames.length),
          delays: g.frames.map(f => f.delay), idx: 0 };
        gifState = s;
        mountSrc(c, g.W, g.H, false);
        drawGifFrame(RGMC_START_LAST ? s.raw.length - 1 : 0);
        warmFrames(s, token);
        ok = true;
      } catch (e) { if (token !== rgmcToken) return; }
      if (!ok) {
        gifFrozenEl = await buildFrozen();
        if (token !== rgmcToken) return;
        gifState = { mode: 'live' };
        mountSrc(gifFrozenEl, gifFrozenEl.width, gifFrozenEl.height, gifFrozenEl._filtered);
        timeLabel.textContent = 'РГМЦ · стоп';
      }
      if (!refresh) map.fitBounds(rgmcBounds(), { padding: [16, 16], maxZoom: 6 });
      timeAgo.textContent = 'только данные · ▶ анимация';
      timelinePanel.style.display = '';
      timeline.disabled = true;
      $('btn-prev').disabled = true;
      $('btn-next').disabled = true;
      btnPlay.disabled = false;
    } catch (e) {
      console.error(e);
      timeLabel.textContent = 'ошибка РГМЦ';
      timeAgo.textContent = '';
      timelinePanel.style.display = 'none';
    }
    if (token === rgmcToken) showLoading(false);
  }

  let gifLiveImg = null;
  function dropLiveImg() { if (gifLiveImg) { try { gifLiveImg.remove(); } catch (_) {} gifLiveImg = null; } }

  function toggleGifAnim() {
    const s = gifState; if (!s) return;
    if (gifPlaying) {                       // пауза / стоп
      gifPlaying = false;
      stopGifTimer();
      dropLiveImg();
      setPlayIcons(false);
      if (s.mode === 'frames') drawGifFrame(s.idx);
      else if (gifLayer && gifFrozenEl) { gifLayer.setSource(gifFrozenEl); timeLabel.textContent = 'РГМЦ · стоп'; }
      return;
    }
    gifPlaying = true;
    setPlayIcons(true);
    if (s.mode === 'frames') {
      const n = s.raw.length;
      const tick = () => {
        if (!gifPlaying) return;
        const next = (s.idx + 1) % n;
        drawGifFrame(next);
        gifTimer = setTimeout(tick, next === n - 1 ? 1000 : Math.max(150, s.delays[next] || 300));
      };
      timeAgo.textContent = 'анимация';
      drawGifFrame(s.idx);
      gifTimer = setTimeout(tick, Math.max(150, s.delays[s.idx] || 300));
    } else {                                // CORS закрыт: живой гиф только после нажатия; рисуем его кадры в canvas
      const im = new Image();
      im.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;pointer-events:none';
      im.onload = () => {
        if (!gifPlaying || gifLiveImg !== im) return;
        gifLayer.setSource(im);
        gifTimer = setInterval(() => { if (gifLayer) gifLayer.redraw(); }, 120);
      };
      gifLiveImg = im;
      document.body.appendChild(im);
      im.src = RGMC_GIF + '?play=' + Date.now();
      timeLabel.textContent = 'РГМЦ · анимация';
      timeAgo.textContent = 'GIF live';
    }
  }

  // ——— Метеоинфо (TMS Y) ———
  function miParseWmsTimes(text) {
    const m = String(text).match(/<Extent[^>]*name\s*=\s*["']time["'][^>]*>([^<]+)<\/Extent>/i);
    if (!m) return [];
    return m[1].trim().split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  }
  function miIso(s) {
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  }

  async function loadMeteoinfo() {
    showLoading(true);
    try {
      const res = await fetch(MI_LIST + '?SERVICE=WMS&REQUEST=GetCapabilities&_=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      const times = miParseWmsTimes(text);
      if (times.length < 1) throw new Error('no times');
      const base = new Date(times[0]);
      miBaseInidt = base.getTime();
      miFrames = times.map(t => ({ t: miIso(t), raw: t }));
      timeline.max = miFrames.length - 1;
      frameIndex = miFrames.length - 1;
      timeline.value = frameIndex;
      if (map.getZoom() < 6) map.setView(MOSCOW, 6);
      miShowFrame(frameIndex);
    } catch (e) {
      console.error(e);
      timeLabel.textContent = 'ошибка Метеоинфо';
      timeAgo.textContent = String(e.message || e);
    }
    showLoading(false);
  }

  function miShowFrame(i) {
    const f = miFrames[i];
    if (!f) return;
    const tEnc = encodeURIComponent(f.t);
    const inidt = miBaseInidt;

    function miIsNoData(r, g, b, a) {
      if (a < 10) return true;
      if (r > 248 && g > 248 && b > 248) return true;
      // бежево-белый фон meteoinfo
      if (r >= 240 && g >= 230 && b >= 220 && Math.abs(r - g) < 25 && Math.abs(g - b) < 25) return true;
      if (r > 220 && g > 220 && b > 220 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20) return true;
      // (250,240,230)
      if (Math.abs(r - 250) <= 12 && Math.abs(g - 240) <= 12 && Math.abs(b - 230) <= 12) return true;
      return false;
    }

    const MiGrid = L.GridLayer.extend({
      createTile(coords, done) {
        const tile = document.createElement('canvas');
        tile.width = 256; tile.height = 256;
        tile.alt = '';
        const z = coords.z, x = coords.x;
        const y = (1 << z) - 1 - coords.y; // TMS
        const path = z + '0' + x + '0' + y;
        const qs = 'tnz=' + z + '&tnx=' + x + '&tny=' + y +
          '&TIME=' + tEnc + '&inidt=' + inidt +
          '&service=WMS&request=GetMap&layers=1&format=image/png&transparent=true&version=1.1.1' +
          '&height=256&width=256&srs=EPSG:3857';
        const primary = 'https://meteoinfo.ru/res/nowcast/' + path + '/ncgi.php?' + qs;
        const fallback = 'https://meteoinfo.ru/hmc-output/nowcast3/ncgi.php?' + qs;

        const paint = (img) => {
          try {
            const ctx = tile.getContext('2d', { willReadFrequently: true });
            ctx.clearRect(0, 0, 256, 256);
            ctx.drawImage(img, 0, 0, 256, 256);
            const id = ctx.getImageData(0, 0, 256, 256);
            const d = id.data;
            for (let i = 0; i < d.length; i += 4) {
              if (miIsNoData(d[i], d[i + 1], d[i + 2], d[i + 3])) d[i + 3] = 0;
            }
            ctx.putImageData(id, 0, 0);
          } catch (_) {}
          done(null, tile);
        };

        const img = new Image();
        img.crossOrigin = 'anonymous';
        let tried = false;
        img.onload = () => paint(img);
        img.onerror = () => {
          if (!tried) { tried = true; img.src = fallback; return; }
          done(null, tile);
        };
        img.src = primary;
        return tile;
      }
    });

    const next = new MiGrid({
      opacity: currentOpacity,
      zIndex: 200,
      tileSize: 256,
      minZoom: 3,
      maxZoom: 12,
      minNativeZoom: 5,
      maxNativeZoom: 8,
      className: 'mi-layer'
    });
    next.addTo(map);
    const old = meteoLayer;
    meteoLayer = next;
    if (old) setTimeout(() => { if (map.hasLayer(old)) map.removeLayer(old); }, 200);

    const d = new Date(f.t);
    const p = n => String(n).padStart(2, '0');
    timeLabel.textContent = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC · мм/ч';
    timeAgo.textContent = i === 0 ? 'наблюдение' : 'прогноз +' + (i * 10) + ' мин';
  }

  // ——— Playback ———
  function togglePlay() {
    if (activeSrc === 'rgmc') { toggleGifAnim(); return; }
    if (playing) stopPlay(); else startPlay();
  }
  function startPlay() {
    const len = activeSrc === 'rainradar' ? rrTimestamps.length
      : activeSrc === 'meteoinfo' ? miFrames.length : frames.length;
    if (len < 2) return;
    playing = true;
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    playTimer = setInterval(() => {
      setFrame(frameIndex + 1);
      if (frameIndex === len - 1) {
        clearInterval(playTimer);
        setTimeout(() => {
          if (playing) playTimer = setInterval(() => setFrame(frameIndex + 1), FRAME_MS);
        }, 800);
      }
    }, FRAME_MS);
  }
  function stopPlay() {
    playing = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }
})();
