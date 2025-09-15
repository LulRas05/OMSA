// ------------------------------------------------------------
// usermap.js (Subtareas 2, 3, 4, 5 y 6)
// - Sin fallback de caminata si no hay ruta útil
// - Estados de UI: "Buscando ruta…", limpieza al teclear/cambiar destino
// - Rótulos discretos (pequeños) en parada de abordaje y descenso
// ------------------------------------------------------------
let map;
let routeMarkers = [];
let directionsRenderers = [];

let rutasCache = [];
let rutaSeleccionada = null;
let ultimasParadas = [];
let markerByParadaId = new Map();

// Rótulos (labels) para parada de abordaje y descenso (discretos)
let boardingLabelWin = null;   // donde se monta
let alightingLabelWin = null;  // donde se desmonta

// Heurísticas para evitar "bus de 1 parada" con mucha caminata
const ROUTE_RULES = {
  MIN_BUS_STOPS: 2,           // si el bus tiene < que esto, se considera "muy corto"
  MAX_SHORT_BUS_DIST_M: 1000, // o si el bus recorre menos de ~1 km
  MIN_ADJ_WALK_SUM_M: 500,    // y la suma de caminata antes+después es mayor a esto
  BUS_STEP_TIME_MIN: 4,       // o si el tramo bus dura menos de X min (si tu leg trae duration)
  WALK_SPEED_MPS: 1.25        // para estimar duración al re-fusionar (opcional)
};

// === Destacar parada seleccionada ===
let selectedStopMarker = null;
let selectedStopInfo = null;
let selectedStopAnimT = null;

function escapeHtml(s){ 
    return (s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Iconos (se crean en runtime porque google.* puede no estar aún cargado)
function getNormalStopIcon(){
    return {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 4,
        strokeColor: "#ffffff",
        strokeWeight: 3,
        fillColor: "#2e7d32",
        fillOpacity: 1
    };
}
function getSelectedStopIcon(){
    return {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 7,
        strokeColor: "#ffffff",
        strokeWeight: 4,
        fillColor: "#1a73e8", // azul para destacar
        fillOpacity: 1
    };
}

function clearSelectedStop(){
    try {
        if (selectedStopAnimT) { clearTimeout(selectedStopAnimT); selectedStopAnimT = null; }
        if (selectedStopInfo) { selectedStopInfo.close(); selectedStopInfo = null; }
        if (selectedStopMarker) {
        selectedStopMarker.setIcon(getNormalStopIcon());
        selectedStopMarker.setZIndex(100);
        selectedStopMarker.setAnimation(null);
        selectedStopMarker = null;
        }
    } catch {}
}

function highlightStopById(paradaId, nombre) {
    const mk = markerByParadaId.get(paradaId);
    if (!mk) return;

    // limpia selección previa (icono, zIndex, animación, infowindow)
    try { clearSelectedStop?.(); } catch {}

    // icono seleccionado + zIndex + pequeño bounce
    try {
        mk.setIcon(getSelectedStopIcon());
        mk.setZIndex(400);
        mk.setAnimation(google.maps.Animation.BOUNCE);
        selectedStopAnimT = setTimeout(() => {
        try { mk.setAnimation(null); } catch {}
        selectedStopAnimT = null;
        }, 1400);
    } catch {}

    selectedStopMarker = mk;

    // ------- InfoWindow compacto: texto + "X" en la misma línea
    const node = document.createElement("div");
    node.className = "iw2";
    node.innerHTML = `
        <div class="iw2__row">
        <div class="iw2__text">${escapeHtml(nombre || "Parada")}</div>
        <button class="iw2__close" aria-label="Cerrar" title="Cerrar">×</button>
        </div>
    `;

    selectedStopInfo = new google.maps.InfoWindow({ content: node });

    selectedStopInfo.addListener("domready", () => {
        // click en nuestra "X"
        const btn = node.querySelector(".iw2__close");
        btn?.addEventListener("click", () => {
        try { selectedStopInfo?.close(); } catch {}
        });

        // ocultar el botón de cierre nativo de Google para esta IW
        const iw = document.querySelector(".gm-style-iw");
        if (iw) {
        const closeBtn = iw.querySelector(".gm-ui-hover-effect");
        if (closeBtn) closeBtn.style.display = "none";
        }
    });

    selectedStopInfo.open({ map: _gmapSafe(), anchor: mk, shouldFocus: false });
}



// ===== Próximo bus (cada :00 y :30) =====
let nextBusTimer = null;

function two(n){ return String(n).padStart(2, "0"); }
function fmtTime(d){
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

// ===== Horario OMSA por día (hora local) =====
const OMSA_SERVICE = {
  weekday:  { start: [6, 0], end: [23, 0] }, // Lunes–Viernes 06:00–22:00
  saturday: { start: [6, 0], end: [22, 0] }, // Sábado 06:00–20:00
  sunday:   { start: [6, 0], end: [22, 0] }, // Domingo 08:00–20:00
};

function serviceWindowFor(date) {
    const d = new Date(date);
    const day = d.getDay(); // 0=Dom, 1=Lun, ... 6=Sáb
    let start, end;

    if (day === 0) { // Domingo
        start = OMSA_SERVICE.sunday.start;   end = OMSA_SERVICE.sunday.end;
    } else if (day === 6) { // Sábado
        start = OMSA_SERVICE.saturday.start; end = OMSA_SERVICE.saturday.end;
    } else { // L–V
        start = OMSA_SERVICE.weekday.start;  end = OMSA_SERVICE.weekday.end;
    }

    const startDt = new Date(d); startDt.setHours(start[0], start[1], 0, 0);
    const endDt   = new Date(d); endDt.setHours(end[0],   end[1],   0, 0);
    return { start: startDt, end: endDt };
}

function nextServiceStartAfter(date) {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    return serviceWindowFor(d).start;
}


// Devuelve { nowStr, nextStr, mins }
// Devuelve { nowStr, nextStr, mins, open, windowStartStr, windowEndStr }
function calcNextBusInfo(now = new Date()) {
    const { start, end } = serviceWindowFor(now);
    const open = now >= start && now <= end;

    // Helper para minutos (redondeo hacia arriba)
    const minsUntil = (a, b) => Math.max(0, Math.ceil((b - a) / 60000));

    if (!open) {
        // Si aún no abre hoy → abre hoy; si ya cerró → abre mañana
        const next = now < start ? start : nextServiceStartAfter(now);
        return {
        nowStr: fmtTime(now),
        nextStr: fmtTime(next),
        mins: minsUntil(now, next),
        open: false,
        windowStartStr: fmtTime(start),
        windowEndStr: fmtTime(end),
        };
    }

    // Dentro del horario → próximos múltiplos de :00 o :30
    const m = now.getMinutes();
    const s = now.getSeconds();
    let rem = (30 - (m % 30)) % 30;   // 0..29
    if (rem === 0 && s > 0) rem = 30; // si ya pasaron segundos, ir al siguiente bloque de 30

    const next = new Date(now);
    next.setMinutes(m + rem, 0, 0);

    // Si el siguiente cae fuera del horario de hoy, abrir mañana
    if (next > end) {
        const ns = nextServiceStartAfter(now);
        return {
        nowStr: fmtTime(now),
        nextStr: fmtTime(ns),
        mins: minsUntil(now, ns),
        open: false,
        windowStartStr: fmtTime(start),
        windowEndStr: fmtTime(end),
        };
    }

    return {
        nowStr: fmtTime(now),
        nextStr: fmtTime(next),
        mins: minsUntil(now, next),
        open: true,
        windowStartStr: fmtTime(start),
        windowEndStr: fmtTime(end),
    };
}

function updateNextBusBanner() {
    const banner = document.getElementById("recorrido-banner");
    if (!banner) return;
    const info = calcNextBusInfo();
    banner.querySelector(".trip-banner__now").textContent  = info.nowStr;
    banner.querySelector(".trip-banner__next").textContent = info.nextStr;
    const minsEl = banner.querySelector(".trip-banner__mins");
    minsEl.textContent = info.open ? (info.mins === 0 ? "llegando" : `≈ ${info.mins} min`) : ` (abre en ≈ ${info.mins} min)`;
    minsEl.style.opacity = "0.8";
}

function startNextBusBanner() {
    const tab = document.getElementById("tab-recorrido");
    if (!tab) return;

    let banner = document.getElementById("recorrido-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "recorrido-banner";
        banner.className = "card card-empty trip-banner";
        banner.innerHTML = `
        <div class="trip-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" style="opacity:.85">
            <path d="M17 1H7C4.79 1 3 2.79 3 5v9c0 1.65 1.35 3 3 3v2a1 1 0 0 0 2 0v-2h8v2a1 1 0 0 0 2 0v-2c1.65 0 3-1.35 3-3V5c0-2.21-1.79-4-4-4ZM7 3h10c1.1 0 2 .9 2 2v3H5V5c0-1.1.9-2 2-2Zm12 12H5V10h14v5ZM7.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>
            </svg>
        </div>
        <div class="trip-banner__text">
            <div>Hora actual: <strong class="trip-banner__now">--:--</strong></div>
            <div>Próximo bus: <strong class="trip-banner__next">--:--</strong><span class="trip-banner__mins" style="margin-left:6px;opacity:.8">…</span></div>
        </div>`;
        const panel = document.getElementById("panel-ruta");
        if (panel && panel.parentNode === tab) tab.insertBefore(banner, panel);
        else tab.prepend(banner);
    }

    updateNextBusBanner();
    if (nextBusTimer) clearInterval(nextBusTimer);
    nextBusTimer = setInterval(updateNextBusBanner, 30 * 1000);
}


function normalizar(txt) {
    return (txt || "")
        .toString()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,;:!?()'"-]/g, "")
        .replace(/\s+/g, " ")                 
        .trim();
}

function clearRouteOverlays() {
    routeMarkers.forEach(m => m.setMap(null));
    routeMarkers = [];
    directionsRenderers.forEach(r => r.setMap(null));
    directionsRenderers = [];
    markerByParadaId.clear();
    ultimasParadas = [];

    clearSelectedStop();
}

async function initMap() {
    const position = { lat: 18.486, lng: -69.931 };
    const { Map } = await google.maps.importLibrary("maps");
    await google.maps.importLibrary("marker");
    await google.maps.importLibrary("routes");

    map = new Map(document.getElementById("map"), {
        zoom: 13,
        center: position,
        mapId: "DEMO_MAP_ID",
    });

    // Exponer instancia REAL del mapa
    window._gmap = map;
    window.map = map; // compat
}

function renderListaRutasYParadas(filtro = "", paradasEncontradas = []) {
    const ul = document.getElementById("lista-rutas");
    if (!ul) return;

    ul.innerHTML = "";

    const f = normalizar(filtro);
    const rutas = rutasCache.filter(r => {
        const texto = `${r.codigo} ${r.nombre} ${r.origen} ${r.destino}`;
        return normalizar(texto).includes(f);
    });

    // Rutas
    rutas.forEach(r => {
        const li = document.createElement("li");
        li.textContent = `${r.nombre} \n (${r.origen} → ${r.destino})`;
        li.style.cursor = "pointer";
        if (rutaSeleccionada === r.codigo) li.classList.add("ruta--activa");
        li.addEventListener("click", () => {
            rutaSeleccionada = r.codigo;
            // si hay una parada destacada de otra ruta, la limpiamos (si existe helper)
            try { clearSelectedStop?.(); } catch {}
            renderListaRutasYParadas(filtro, paradasEncontradas);
            mostrarRuta(r.codigo);
        });
        ul.appendChild(li);
    });

    // Paradas (si hay filtro)
    if (f && paradasEncontradas.length) {
        const sep = document.createElement("li");
        sep.textContent = "— Paradas —";
        sep.style.margin = "8px 0";
        sep.style.opacity = "0.7";
        ul.appendChild(sep);

        paradasEncontradas.forEach(p => {
            const li = document.createElement("li");
            li.className = "parada-item";
            li.style.cursor = "pointer";
            li.textContent = `Parada: ${p.nombre} [${p.ruta_codigo}]`;

            li.addEventListener("click", async () => {
            // mostrar la ruta de esa parada (crea/actualiza los markers)
            await mostrarRuta(p.ruta_codigo);

            // centrar/zoom y destacar exactamente igual que al hacer click en el marker
            try { clearSelectedStop?.(); } catch {}
            const mk = markerByParadaId.get(p.id);
            const m = _gmapSafe?.();
            if (mk && m) {
                m.panTo(mk.getPosition());
                m.setZoom(Math.max(m.getZoom(), 16));
                highlightStopById(p.id, p.nombre);   // ← cambia a azul, bounce y rótulo
            }

            // marcar visualmente la fila activa (opcional)
            ul.querySelectorAll(".parada-item.is-active").forEach(el => el.classList.remove("is-active"));
            li.classList.add("is-active");
            });

            ul.appendChild(li);
        });
    }
}


function renderListaRutasEnRutasPanel(filtro = "", paradasEncontradas = []) {
    const ulR = document.getElementById("lista-rutas-rutas");
    if (!ulR) return;
    ulR.innerHTML = "";

    const f = normalizar(filtro);

    // Filtrar rutas locales
    const rutas = rutasCache.filter(r => {
        const texto = `${r.codigo} ${r.nombre} ${r.origen} ${r.destino}`;
        return normalizar(texto).includes(f);
    });

    // Pintar rutas
    rutas.forEach(r => {
        const li = document.createElement("li");
        li.style.cursor = "pointer";
        li.textContent = `${r.nombre} \n (${r.origen} → ${r.destino})`;
        li.addEventListener("click", () => {
        // Mostrar la ruta en el mapa solo si el usuario hace clic
        mostrarRuta(r.codigo);
        });
        ulR.appendChild(li);
    });

    // Si hay filtro y paradas coincididas, mostrarlas bajo un separador
    if (f && paradasEncontradas.length) {
        const sep = document.createElement("li");
        sep.textContent = "— Paradas —";
        sep.style.margin = "8px 0";
        sep.style.opacity = "0.7";
        ulR.appendChild(sep);

        paradasEncontradas.forEach(p => {
        const li = document.createElement("li");
        li.className = "parada-item";
        li.style.cursor = "pointer";
        li.textContent = `Parada: ${p.nombre} [${p.ruta_codigo}]`;

        li.addEventListener("click", async () => {
            // 1) pinta la ruta de esa parada (crea/actualiza markers)
            await mostrarRuta(p.ruta_codigo);

            // 2) localizar el marker con tolerancia de nombres de campo
            const stopId =
            p.id ?? p.parada_id ?? p.paradaId ?? p.stop_id ?? p.stopId ?? null;

            let mk = stopId != null ? markerByParadaId.get(stopId) : null;

            // Fallback: por título si el id no coincide
            if (!mk) {
            for (const m of markerByParadaId.values()) {
                const t = (typeof m.getTitle === "function") ? m.getTitle() : m.title;
                if (t && p.nombre && t.trim() === p.nombre.trim()) {
                mk = m; break;
                }
            }
            }

            // 3) centrar/zoom + destacar igual que click en el marcador
            const m = _gmapSafe?.();
            if (mk && m) {
            m.panTo(mk.getPosition());
            m.setZoom(Math.max(m.getZoom(), 16));
            try { clearSelectedStop?.(); } catch {}
            try { highlightStopById(stopId || -1, p.nombre); } catch {}
            }

            // 4) marcar visualmente la fila activa (opcional)
            ulR.querySelectorAll(".parada-item.is-active")
            .forEach(el => el.classList.remove("is-active"));
            li.classList.add("is-active");
        });

        ulR.appendChild(li);
        });
    }
}


function variantesPuntuacion(q) {
    const base = q.trim();
    const out = new Set([base]); // siempre incluye la original

    const tokens = base.split(/\s+/);
    const ABBR = new Set(["av", "dr", "sr", "sta", "sto", "pte"]); // amplía si hace falta

    tokens.forEach((t, i) => {
        const tNorm = t.toLowerCase().replace(/\.$/, "");
        if (ABBR.has(tNorm)) {
            // versión con punto
            const withDot = tokens.slice();
            withDot[i] = tNorm + ".";
            out.add(withDot.join(" "));
        }
    });

    return Array.from(out);
}



// === Cargar rutas + buscador ===
async function cargarRutas() {
    try {
        const res = await fetch("/api/public/rutas/");
        rutasCache = await res.json();

        // Relleno inicial del panel Rutas sin filtro
        renderListaRutasEnRutasPanel("", []);

        // Bind del input pequeño en la pestaña Rutas (independiente del input grande)
        const rutasSearch = document.getElementById("rutas-search");
        if (rutasSearch && !rutasSearch.dataset.bound) {
            let debounceTimer = null;

            rutasSearch.addEventListener("input", (e) => {
                clearTimeout(debounceTimer);
                const value = e.target.value;

                debounceTimer = setTimeout(async () => {
                    let paradasEncontradas = [];
                    const q = value.trim();

                    if (q.length >= 2) {
                        const variantes = variantesPuntuacion(q);
                        const vistos = new Set();

                        for (const term of variantes) {
                            try {
                                const resp = await fetch(`/api/public/paradas/buscar/?q=${encodeURIComponent(term)}`);
                                if (resp.ok) {
                                    const arr = await resp.json();
                                    for (const p of arr) {
                                        if (!vistos.has(p.id)) {
                                            vistos.add(p.id);
                                            paradasEncontradas.push(p);
                                        }
                                    }
                                }
                            } catch (err) {
                                console.error("Error buscando paradas (panel Rutas):", err);
                            }
                        }
                    }

                    renderListaRutasEnRutasPanel(value, paradasEncontradas);
                }, 150);
            });

            rutasSearch.dataset.bound = "1";
        }
        

        renderListaRutasYParadas("", []);

        const search = document.getElementById("search-box");
        if (search && !search.dataset.bound) {
            let timer = null;

            /*
            // Resetear panel al escribir
            search.addEventListener("input", () => {
                const panel = document.getElementById("panel-ruta");
                if (panel) panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>`;
            });
            */

            search.addEventListener("input", async (e) => {
                clearTimeout(timer);
                const value = e.target.value;
                timer = setTimeout(async () => {
                    let paradasEncontradas = [];
                    const q = value.trim();
                    // Si el modo es OMSA, buscamos paradas/filtramos rutas
                    const mode = document.querySelector('.mode-btn.is-active')?.dataset.mode || 'places';
                    if (q.length >= 2 && mode === 'omsa') {
                        try {
                            const resp = await fetch(`/api/public/paradas/buscar/?q=${encodeURIComponent(q)}`);
                            if (resp.ok) paradasEncontradas = await resp.json();
                        } catch (err) {
                            console.error("Error buscando paradas:", err);
                        }
                    }
                    renderListaRutasYParadas(value, paradasEncontradas);
                }, 150);
            });
            search.dataset.bound = "1";
        }

        // Dispara construcción del índice (Subtarea 3) sin bloquear
        if (window.omsaStops?.build) window.omsaStops.build().catch(console.error);

        // Primera carga de Paradas cercanas (si ya hay índice y origen)
        setTimeout(() => { if (window.loadNearbyStops) window.loadNearbyStops(); }, 800);

    } catch (err) {
        console.error("Error cargando rutas", err);
    }
}

// === Directions por tramos ===
function chunkPoints(points, maxPoints = 25) {
    const segments = [];
    if (points.length < 2) return segments;
    let start = 0;
    while (start < points.length - 1) {
        const end = Math.min(start + maxPoints - 1, points.length - 1);
        const origin = points[start];
        const destination = points[end];
        const waypoints = points.slice(start + 1, end).map(p => ({
            location: p,
            stopover: true,
        }));
        segments.push({ origin, destination, waypoints });
        start = end;
    }
    return segments;
}

// --- Helper global: DirectionsService.route como Promise confiable ---
function routeAsync(ds, req) {
    return new Promise((resolve, reject) => {
        ds.route(req, (result, status) => {
            if (status === "OK") resolve(result);
            else reject(new Error(status || "ROUTE_FAILED"));
        });
    });
}

async function mostrarRuta(codigo) {
    try {
        const res = await fetch(`/api/public/paradas/?codigo=${encodeURIComponent(codigo)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const paradas = await res.json();

        clearRouteOverlays();
        if (!paradas.length) return;

        ultimasParadas = paradas;
        const bounds = new google.maps.LatLngBounds();
        const points = paradas.map(p => ({ lat: p.lat, lng: p.lon }));

        // Markers
        paradas.forEach((p, idx) => {
            const pos = new google.maps.LatLng(p.lat, p.lon);
            bounds.extend(pos);
            const marker = new google.maps.Marker({
                map: _gmapSafe(),
                position: pos,
                title: p.nombre,
                zIndex: 100,
                icon: getNormalStopIcon()
            });
            // Guardar referencia para poder destacarlo luego
            markerByParadaId.set(p.id, marker);
            routeMarkers.push(marker);

            // Click en el propio marcador también lo destaca
            marker.addListener('click', () => {
                highlightStopById(p.id, p.nombre);
                _gmapSafe().panTo(marker.getPosition());
                _gmapSafe().setZoom(Math.max(_gmapSafe().getZoom(), 16));
            });
        });


        const { DirectionsService, DirectionsRenderer, TravelMode } = await google.maps.importLibrary("routes");
        const ds = new DirectionsService();

        const segments = chunkPoints(points, 25);
        for (const seg of segments) {
            const result = await routeAsync(ds, {
                origin: seg.origin,
                destination: seg.destination,
                waypoints: seg.waypoints,
                travelMode: TravelMode.DRIVING,
                optimizeWaypoints: false,
            });
            const dr = new DirectionsRenderer({
                map: _gmapSafe(),
                preserveViewport: true,
                suppressMarkers: true,
            });
            dr.setDirections(result);
            directionsRenderers.push(dr);
        }
        _gmapSafe().fitBounds(bounds);
    } catch (err) {
        console.error("Error mostrando paradas:", err);
    }
}

// Helper seguro para acceder al mapa real
function _gmapSafe() {
    return window._gmap || map;
}

// --- Boot del mapa + rutas ---
(function bootMapSafely(){
    let tries = 0;
    const t = setInterval(() => {
        tries++;
        if (window.google && google.maps?.importLibrary && document.getElementById("map")) {
            clearInterval(t);
            initMap().then(() => cargarRutas());
        }
        if (tries > 120) clearInterval(t);
    }, 100);
})();


// ============================================================
// GEOLOCALIZACIÓN (Subtarea 2) — SIEMPRE ACTIVA
// ============================================================
(function enableAlwaysOnUserGeolocation() {
    const userLoc = {
        marker: null,
        circle: null,
        watchId: null,
        centeredOnce: false,
        active: false,
        _alerted: false
    };

    const GEO_OPTS = {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 10000
    };

    // Icono azul con borde blanco (12px) vía SVG path
    function blueDotIcon() {
        const pathCircle = "M 0,0 m -6,0 a 6,6 0 1,0 12,0 a 6,6 0 1,0 -12,0";
        return {
            path: pathCircle,
            scale: 1,
            fillColor: "#4285F4",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
            anchor: new google.maps.Point(0, 0)
        };
    }

    function renderMyLocation(lat, lng, accuracy) {
        if (!window.google || !google.maps || !_gmapSafe()) return;

        const pos = { lat, lng };

        if (!userLoc.marker) {
            userLoc.marker = new google.maps.Marker({
                position: pos,
                map: _gmapSafe(),
                title: "Mi ubicación",
                icon: blueDotIcon(),
                zIndex: 9999
            });
        } else {
            userLoc.marker.setPosition(pos);
            if (!userLoc._iconSet) {
                try { userLoc.marker.setIcon(blueDotIcon()); userLoc._iconSet = true; } catch {}
            }
        }

        if (!userLoc.circle) {
            userLoc.circle = new google.maps.Circle({
                map: _gmapSafe(),
                center: pos,
                radius: Math.max(accuracy || 0, 5),
                strokeOpacity: 0.2,
                strokeWeight: 1,
                fillOpacity: 0.08
            });
        } else {
            userLoc.circle.setCenter(pos);
            userLoc.circle.setRadius(Math.max(accuracy || 0, 5));
        }
    }

    function handlePositionSuccess(position) {
        const { latitude, longitude, accuracy } = position.coords;
        renderMyLocation(latitude, longitude, accuracy);

        document.dispatchEvent(new CustomEvent("omsa:livepos", { detail: { lat: latitude, lng: longitude } }));

        if (!userLoc.centeredOnce && _gmapSafe()) {
            _gmapSafe().panTo({ lat: latitude, lng: longitude });
            userLoc.centeredOnce = true;
        }
    }

    function handlePositionError(err) {
        console.warn("Geolocalización: error/denegado:", err && err.message);
        if (!userLoc._alerted) {
            alert("No se pudo obtener tu ubicación. Revisa permisos del navegador y usa HTTPS o localhost.");
            userLoc._alerted = true;
        }
        stopWatch();
    }

    function startWatch() {
        if (userLoc.active) return;
        if (!("geolocation" in navigator)) {
            console.warn("Este navegador no soporta geolocalización.");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            handlePositionSuccess,
            handlePositionError,
            GEO_OPTS
        );
        userLoc.watchId = navigator.geolocation.watchPosition(
            handlePositionSuccess,
            handlePositionError,
            GEO_OPTS
        );
        userLoc.active = true;
    }

    function stopWatch() {
        if (userLoc.watchId != null) {
            try { navigator.geolocation.clearWatch(userLoc.watchId); } catch {}
            userLoc.watchId = null;
        }
        if (userLoc.marker) { userLoc.marker.setMap(null); userLoc.marker = null; }
        if (userLoc.circle) { userLoc.circle.setMap(null); userLoc.circle = null; }
        userLoc.active = false;
        userLoc.centeredOnce = false;
    }

    function bootIfReady() {
        if (window.google && google.maps && _gmapSafe()) {
            startWatch();
            return true;
        }
        return false;
    }

    let tries = 0;
    const tid = setInterval(() => {
        tries++;
        if (bootIfReady() || tries > 120) {
            clearInterval(tid);
        }
    }, 100);

    document.addEventListener("DOMContentLoaded", bootIfReady);
    window.addEventListener("pagehide", stopWatch);
    window.addEventListener("beforeunload", stopWatch);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !userLoc.active) {
            startWatch();
        }
    });
})();


// ============================================================
// SUBTAREA 1 — Autocomplete
// ============================================================
(function enablePlacesAutocomplete() {
    let destino = null;
    let destinoMarker = null;

    const SDE_BOUNDS = { south: 18.30, west: -70.10, north: 18.65, east: -69.55 };

    async function boot() {
        if (!window.google || !google.maps?.importLibrary || !document.getElementById("search-box")) return false;

        const { Autocomplete } = await google.maps.importLibrary("places");
        const input = document.getElementById("search-box");

        const ac = new Autocomplete(input, {
            fields: ["geometry", "place_id", "formatted_address", "name"],
            bounds: SDE_BOUNDS,
            strictBounds: true,
            componentRestrictions: { country: "do" }
        });

        ac.addListener("place_changed", () => {
            const place = ac.getPlace();
            if (!place?.geometry?.location) return;

            const loc = place.geometry.location;
            destino = {
                lat: loc.lat(),
                lng: loc.lng(),
                placeId: place.place_id || null,
                address: place.formatted_address || place.name || "(sin nombre)"
            };

            if (!destinoMarker) {
                destinoMarker = new google.maps.Marker({
                    map: _gmapSafe(),
                    position: { lat: destino.lat, lng: destino.lng },
                    title: `Destino: ${destino.address}`,
                    zIndex: 9998
                });
            } else {
                destinoMarker.setPosition({ lat: destino.lat, lng: destino.lng });
                destinoMarker.setTitle(`Destino: ${destino.address}`);
            }

            if (_gmapSafe()) {
                _gmapSafe().panTo({ lat: destino.lat, lng: destino.lng });
                _gmapSafe().setZoom(Math.max(_gmapSafe().getZoom(), 14));
            }

            window.omsaTrip?.setDestino(destino);

            // Resetear panel al cambiar destino
            const panel = document.getElementById("panel-ruta");
            if (panel) panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>`;

            // Actualizar mini-card UI
            const card = document.getElementById("destino-card");
            const title = document.getElementById("destino-title");
            const addr = document.getElementById("destino-addr");
            if (card && title && addr) {
                title.textContent = place.name || "Destino";
                addr.textContent = place.formatted_address || place.name || "";
                card.hidden = false;
            }
        });

        return true;
    }

    let tries = 0;
    const tid = setInterval(async () => {
        tries++;
        const ok = await boot();
        if (ok || tries > 60) clearInterval(tid);
    }, 150);
})();


// ============================================================
// SUBTAREA 2 — Origen: vivo o Shift+clic
// ============================================================
(function setupTripOrigin() {
    const trip = {
        destino: null,
        setDestino(d) { this.destino = d; },
        getDestino() { return this.destino; },

        origenOverride: null,
        setOrigenOverride(lat, lng) {
            this.origenOverride = { lat, lng };
            renderOverrideMarker();
        },
        clearOrigenOverride() {
            this.origenOverride = null;
            if (overrideMarker) { overrideMarker.setMap(null); overrideMarker = null; }
        },
        getOrigen() {
            if (this.origenOverride) return this.origenOverride;
            const live = window.__omsaUserLivePos;
            if (live) return { lat: live.lat, lng: live.lng };
            if (_gmapSafe()) {
                const c = _gmapSafe().getCenter();
                return { lat: c.lat(), lng: c.lng() };
            }
            return null;
        }
    };

    window.__omsaUserLivePos = null;
    document.addEventListener("omsa:livepos", (e) => {
        window.__omsaUserLivePos = e.detail;
    });

    let overrideMarker = null;
    function renderOverrideMarker() {
        if (!_gmapSafe() || !trip.origenOverride) return;
        const pos = trip.origenOverride;
        if (!overrideMarker) {
            overrideMarker = new google.maps.Marker({
                map: _gmapSafe(),
                position: pos,
                title: "Origen (fijado manualmente)",
                zIndex: 9997
            });
        } else {
            overrideMarker.setPosition(pos);
        }
    }

    function bindShiftClick() {
        const gm = _gmapSafe();
        if (!gm) return;

        // Idempotente: si ya había un listener en ESTE mapa, lo quitamos
        if (gm.__omsaShiftListener) {
            google.maps.event.removeListener(gm.__omsaShiftListener);
            gm.__omsaShiftListener = null;
        }

        gm.__omsaShiftListener = gm.addListener("click", (ev) => {
            // Acepta Shift desde el evento del mapa y (si lo agregaste) el respaldo global
            const shiftDown = (ev && ev.domEvent && ev.domEvent.shiftKey) || window.__omsaShiftDown === true;
            if (!shiftDown) return;

            const ll = ev.latLng;
            if (!ll) return;

            window.omsaTrip.setOrigenOverride(ll.lat(), ll.lng());
            gm.panTo(ll);
            console.debug("[OMSA] Origen fijado por usuario (Shift+clic):", window.omsaTrip.origenOverride);
        });
    }

    let tries = 0;
    const tid = setInterval(() => {
        tries++;
        if (_gmapSafe() && window.google && google.maps) {
            clearInterval(tid);
            bindShiftClick();
        }
        if (tries > 120) clearInterval(tid);
    }, 100);

    window.omsaTrip = trip;
})();


// ============================================================
// Helpers robustos para fetch con timeout (Subtarea 3)
// ============================================================
async function fetchJsonWithTimeout(url, { timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(id);
    }
}


// ============================================================
// SUBTAREA 3 — Índice global de paradas
// ============================================================
(function setupStopsIndex() {
    const state = {
        building: false,
        built: false,
        stopsByRoute: {},
        allStops: []
    };

    function haversine(a, b) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const s1 = Math.sin(dLat / 2) ** 2;
        const s2 = Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s1 + s2));
    }

    async function build({ force = false } = {}) {
        if (state.built && !force) return state;
        if (state.building) {
            await new Promise(r => {
                const tid = setInterval(() => {
                    if (!state.building) { clearInterval(tid); r(); }
                }, 100);
            });
            return state;
        }

        // 1) Asegurar rutasCache
        try {
            if (!Array.isArray(window.rutasCache) || window.rutasCache.length === 0) {
                const rutas = await fetchJsonWithTimeout("/api/public/rutas/", { timeoutMs: 20000 });
                if (Array.isArray(rutas) && rutas.length) window.rutasCache = rutas;
            }
        } catch (e) {
            console.warn("[OMSA] No se pudieron cargar rutas en build():", e);
        }

        if (!Array.isArray(window.rutasCache) || window.rutasCache.length === 0) {
            state.stopsByRoute = {};
            state.allStops = [];
            state.built = true;
            state.building = false;
            document.dispatchEvent(new CustomEvent("omsa:stops-index-ready", { detail: { routes: 0, totalStops: 0 } }));
            return state;
        }

        state.building = true;
        document.dispatchEvent(new CustomEvent("omsa:stops-index-building"));

        try {
            const codigos = window.rutasCache.map(r => r.codigo).filter(Boolean);
            const all = [];
            const byRoute = {};

            let i = 0;
            const K = 4;
            const runners = new Array(Math.min(K, codigos.length)).fill(0).map(async () => {
                while (i < codigos.length) {
                    const idx = i++;
                    const codigo = codigos[idx];
                    try {
                        const arr = await fetchJsonWithTimeout(
                            `/api/public/paradas/?codigo=${encodeURIComponent(codigo)}`,
                            { timeoutMs: 20000 }
                        );
                        const norm = (Array.isArray(arr) ? arr : []).map(p => ({ ...p, lng: p.lng ?? p.lon }));
                        byRoute[codigo] = norm;
                        for (const p of norm) {
                            const ruta_codigo = p.ruta_codigo || p.codigo_ruta || codigo;
                            all.push({ ...p, ruta_codigo, lng: p.lng ?? p.lon });
                        }
                    } catch (e) {
                        console.warn("[OMSA] Timeout / error en paradas de", codigo, e);
                        byRoute[codigo] = byRoute[codigo] || [];
                    }
                }
            });
            await Promise.all(runners);

            state.stopsByRoute = byRoute;
            state.allStops = all;
            state.built = true;
            state.building = false;

            document.dispatchEvent(new CustomEvent("omsa:stops-index-ready", {
                detail: { routes: Object.keys(byRoute).length, totalStops: all.length }
            }));
            return state;
        } catch (err) {
            console.warn("[OMSA] build(): error global; cerrando con lo disponible.", err);
            state.built = true;
            state.building = false;
            document.dispatchEvent(new CustomEvent("omsa:stops-index-ready", {
                detail: { routes: Object.keys(state.stopsByRoute).length, totalStops: state.allStops.length }
            }));
            return state;
        }
    }

    function getByRoute(codigo) { return state.stopsByRoute[codigo] || []; }
    function getAll() { return state.allStops.slice(); }
    function nearest(origin, N = 5) {
        if (!state.built) return [];
        const { lat, lng } = origin || {};
        if (typeof lat !== "number" || typeof lng !== "number") return [];
        const o = { lat, lng };
        return state.allStops
            .map(p => ({ p, d: haversine(o, { lat: p.lat, lng: p.lng }) }))
            .sort((a, b) => a.d - b.d)
            .slice(0, Math.max(1, N))
            .map(x => ({ ...x.p, distance_m: x.d }));
    }

    function waitUntilBuilt(timeoutMs = 120000) {
        if (state.built) return Promise.resolve(true);
        if (!state.building) build().catch(e => console.warn("[OMSA] build() inicial falló:", e));
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const onReady = () => { cleanup(); resolve(true); };
            const onError = () => {};
            const cleanup = () => {
                document.removeEventListener("omsa:stops-index-ready", onReady);
                document.removeEventListener("omsa:stops-index-error", onError);
                clearInterval(tid);
            };
            document.addEventListener("omsa:stops-index-ready", onReady);
            document.addEventListener("omsa:stops-index-error", onError);

            const tid = setInterval(() => {
                if (state.built) { cleanup(); resolve(true); return; }
                const elapsed = Date.now() - start;
                if (elapsed > timeoutMs) {
                    if ((state.allStops?.length || 0) > 0) {
                        cleanup(); resolve(true); return;
                    }
                    cleanup();
                    reject(new Error("Timeout esperando índice de paradas"));
                }
            }, 150);
        });
    }

    window.omsaStops = {
        get built() { return state.built; },
        get building() { return state.building; },
        get stopsByRoute() { return state.stopsByRoute; },
        get allStops() { return state.allStops; },
        build, getByRoute, getAll, nearest, waitUntilBuilt,
    };

    (async () => {
        try { await build({ force: false }); }
        catch (e) { console.warn("[OMSA] build inicial falló:", e); }
    })();
})();


// ============================================================
// SUBTAREA 4 — Candidatos de abordaje/descenso (con WALKING)
// ============================================================
(function setupBoardingCandidates() {
    const CFG = {
        DEFAULT_N: 3,
        DEFAULT_MAX_WALK_MIN: 18,
        SEARCH_POOL: 20
    };

    const walkCache = new Map();

    function keyFor(a, b) {
        return `${a.lat.toFixed(6)},${a.lng.toFixed(6)}->${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
    }

    function haversine(a, b) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const s1 = Math.sin(dLat / 2) ** 2;
        const s2 = Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s1 + s2));
    }

    async function walkingTimeSec(origin, target) {
        const k = keyFor(origin, target);
        if (walkCache.has(k)) return walkCache.get(k);

        try {
            const { DirectionsService, TravelMode } = await google.maps.importLibrary("routes");
            const ds = new DirectionsService();
            const res = await routeAsync(ds, {
                origin,
                destination: target,
                travelMode: TravelMode.WALKING,
                provideRouteAlternatives: false,
            });

            const leg = res?.routes?.[0]?.legs?.[0];
            const sec = leg?.duration?.value ?? null;
            const meters = leg?.distance?.value ?? null;

            const out = { sec, meters };
            walkCache.set(k, out);
            return out;
        } catch (e) {
            const meters = Math.round(haversine(origin, target));
            const sec = Math.round(meters / 1.25);
            const out = { sec, meters, estimated: true };
            walkCache.set(k, out);
            return out;
        }
    }

    async function candidatesForPoint(point, N, maxWalkMin) {
        if (!window.omsaStops?.built) return [];

        const prelim = window.omsaStops.nearest(point, Math.max(CFG.SEARCH_POOL, N));
        if (!prelim.length) return [];

        const validated = [];
        for (const p of prelim) {
            const stopPos = { lat: p.lat, lng: p.lng ?? p.lon };
            const w = await walkingTimeSec(point, stopPos);
            const ok = (w.sec != null) ? (w.sec <= maxWalkMin * 60) : true;
            validated.push({
                ...p,
                walk_sec: w.sec ?? null,
                walk_m: w.meters ?? Math.round(haversine(point, stopPos)),
                walk_ok: ok,
                walk_estimated: !!w.estimated
            });
        }

        const good = validated
            .filter(x => x.walk_ok)
            .sort((a, b) => (a.walk_sec ?? a.distance_m) - (b.walk_sec ?? b.distance_m))
            .slice(0, N);

        if (good.length < N) {
            const rest = validated
                .filter(x => !x.walk_ok)
                .sort((a, b) => (a.walk_sec ?? a.distance_m) - (b.walk_sec ?? b.distance_m))
                .slice(0, N - good.length);
            return good.concat(rest);
        }
        return good;
    }

    async function compute({ N = CFG.DEFAULT_N, maxWalkMin = CFG.DEFAULT_MAX_WALK_MIN } = {}) {
        try {
            if (!window.omsaStops?.built) {
                if (window.omsaStops?.build && !window.omsaStops.building) {
                    window.omsaStops.build().catch(()=>{});
                }
                await window.omsaStops.waitUntilBuilt();
            }
        } catch (e1) {
            try {
                await window.omsaStops.build({ force: true });
                await window.omsaStops.waitUntilBuilt();
            } catch (e2) {
                throw new Error("No se pudo preparar el índice de paradas (Subtarea 3).");
            }
        }

        const origen = window.omsaTrip?.getOrigen?.();
        const destino = window.omsaTrip?.getDestino?.();

        if (!origen || typeof origen.lat !== "number" || typeof origen.lng !== "number") {
            throw new Error("No hay origen disponible (ubicación o Shift+clic).");
        }

        document.dispatchEvent(new CustomEvent("omsa:candidates-building", {
            detail: { N, maxWalkMin }
        }));

        const [origCands, destCands] = await Promise.all([
            candidatesForPoint(origen, N, maxWalkMin),
            destino && typeof destino.lat === "number" && typeof destino.lng === "number"
                ? candidatesForPoint(destino, N, maxWalkMin)
                : Promise.resolve([])
        ]);

        const result = { origen: origCands, destino: destCands, params: { N, maxWalkMin } };
        document.dispatchEvent(new CustomEvent("omsa:candidates-ready", { detail: result }));
        return result;
    }

    window.omsaCandidates = { compute };
})();


// ============================================================
// SUBTAREA 5 — Grafo y ruteo con transferencias (Dijkstra)
// SIN fallback de caminata si no hay ruta útil
// ============================================================
(function setupRoutingWithTransfers() {
    const CFG = {
        N: 3,
        maxWalkMin: 18,
        transferPenaltyMin: 4,
        transferMaxWalkMin: 8,
        transferRadiusM: 250,
        busAvgSpeedMps: 5.0
    };

    function toRad(d){ return d*Math.PI/180; }
    function haversine(a,b){
        const R=6371000;
        const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
        const s1=Math.sin(dLat/2)**2;
        const s2=Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
        return 2*R*Math.asin(Math.sqrt(s1+s2));
    }

    const _walkCache = new Map();
    function _keyWalk(a,b){ return `${a.lat.toFixed(6)},${a.lng.toFixed(6)}->${b.lat.toFixed(6)},${b.lng.toFixed(6)}`; }

    function dijkstra(startId, endId, graph, penaltyPerTransferSec) {
        const dist = new Map();
        const prev = new Map();
        the_visited = new Set();
        const pq = [];
        const push = (id, d) => { pq.push({id, d}); pq.sort((a,b)=>a.d-b.d); };

        dist.set(startId, 0);
        push(startId, 0);

        while (pq.length) {
            const {id: u} = pq.shift();
            if (the_visited.has(u)) continue;
            the_visited.add(u);
            if (u === endId) break;

            const edges = graph.get(u) || [];
            for (const e of edges) {
                let penalty = 0;
                if (e.meta.type === 'BUS') {
                    const prevEdge = prev.get(u)?.edge;
                    if (prevEdge && prevEdge.meta.type === 'BUS' && prevEdge.meta.routeCode !== e.meta.routeCode) {
                        penalty = penaltyPerTransferSec;
                    }
                }
                const alt = (dist.get(u) ?? Infinity) + e.w + penalty;
                if (alt < (dist.get(e.v) ?? Infinity)) {
                    dist.set(e.v, alt);
                    prev.set(e.v, { id: u, edge: e });
                    push(e.v, alt);
                }
            }
        }

        if (!dist.has(endId)) return null;

        const path = [];
        let cur = endId;
        while (cur !== startId && prev.has(cur)) {
            const { id: p, edge } = prev.get(cur);
            path.push({ from: p, to: cur, edge });
            cur = p;
        }
        path.reverse();
        return { totalSec: dist.get(endId), path };
    }

    function compressToLegs(path, nodeInfo) {
        if (!path || !path.length) return [];
        const legs = [];
        let current = null;

        function labelFor(nodeId){
            const n = nodeInfo.get(nodeId);
            if (!n) return { name: nodeId };
            return { name: n.name, route: n.routeCode, lat: n.lat, lng: n.lng };
        }

        for (const seg of path) {
            const t = seg.edge.meta.type; // 'WALK' | 'BUS'
            if (!current || current.type !== t || (t === 'BUS' && current.routeCode !== seg.edge.meta.routeCode)) {
                if (current) legs.push(current);
                current = {
                    type: t,
                    routeCode: t === 'BUS' ? seg.edge.meta.routeCode : null,
                    secs: 0,
                    meters: 0,
                    from: labelFor(seg.from),
                    to: labelFor(seg.to),
                    hops: 1
                };
            } else {
                current.to = labelFor(seg.to);
                current.hops++;
            }
            current.secs += seg.edge.w;
            current.meters += seg.edge.m || 0;
        }
        if (current) legs.push(current);
        return legs;
    }

    function buildGraph({ origin, destino, originStops, destStops, transferRadiusM, transferMaxWalkMin, busAvgSpeedMps }) {
        const graph = new Map();          // id -> [{v, w, m, meta}]
        const nodeInfo = new Map();       // id -> {name, routeCode, lat, lng}
        const addNode = (id, info)=>{ if(!nodeInfo.has(id)) nodeInfo.set(id, info); if(!graph.has(id)) graph.set(id, []); };
        const addEdge = (u, v, w, m, meta)=>{ graph.get(u).push({ v, w, m, meta }); };

        const routesNeeded = new Set();
        originStops.forEach(s => routesNeeded.add(s.ruta_codigo));
        destStops.forEach(s => routesNeeded.add(s.ruta_codigo));

        // 1) Nodos/aristas BUS por cada ruta relevante (SOLO ADELANTE)
        routesNeeded.forEach(code => {
            const arr = (window.omsaStops.getByRoute(code) || [])
                .slice()
                .sort((a,b)=> (a.orden ?? a.order ?? 0) - (b.orden ?? b.order ?? 0));

            for (let i = 0; i < arr.length; i++) {
                const s = arr[i];
                const id = `S${s.id}`;
                addNode(id, { name: s.nombre, routeCode: code, lat: s.lat, lng: s.lng ?? s.lon });

                if (i < arr.length - 1) {
                    const t = arr[i + 1];
                    const id2 = `S${t.id}`;
                    addNode(id2, { name: t.nombre, routeCode: code, lat: t.lat, lng: t.lng ?? t.lon });

                    const meters = haversine({ lat: s.lat, lng: s.lng ?? s.lon }, { lat: t.lat, lng: t.lng ?? t.lon });
                    const secs = Math.max(1, Math.round(meters / busAvgSpeedMps));
                    addEdge(id, id2, secs, meters, { type: 'BUS', routeCode: code });
                }
            }
        });

        // 2) Conexiones de transferencia entre rutas cercanas (a pie)
        const allRelStops = [];
        routesNeeded.forEach(code => {
            const arr = window.omsaStops.getByRoute(code) || [];
            arr.forEach(s => allRelStops.push({ ...s, lng: s.lng ?? s.lon }));
        });

        function toRad(d){ return d*Math.PI/180; }
        function hv(a,b){
            const R=6371000;
            const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
            const s1=Math.sin(dLat/2)**2;
            const s2=Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
            return 2*R*Math.asin(Math.sqrt(s1+s2));
        }

        for (let i=0;i<allRelStops.length;i++){
            const a = allRelStops[i];
            const aid = `S${a.id}`;
            for (let j=i+1;j<allRelStops.length;j++){
                const b = allRelStops[j];
                if ((a.ruta_codigo||a.codigo_ruta) === (b.ruta_codigo||b.codigo_ruta)) continue;
                const d = hv({lat:a.lat,lng:a.lng},{lat:b.lat,lng:b.lng});
                if (d <= transferRadiusM) {
                    const secs = Math.round(d/1.25);
                    if (secs <= transferMaxWalkMin*60) {
                        const bid = `S${b.id}`;
                        addEdge(aid, bid, secs, d, { type:'WALK', reason:'transfer' });
                        addEdge(bid, aid, secs, d, { type:'WALK', reason:'transfer' });
                    }
                }
            }
        }

        // 3) Nodo origen y destino + edges WALK
        addNode('SRC', { name:'Origen', routeCode:null, lat:origin.lat, lng:origin.lng });
        if (destino) addNode('DST', { name:'Destino', routeCode:null, lat:destino.lat, lng:destino.lng });

        originStops.forEach(s=>{
            const sid = `S${s.id}`;
            addEdge('SRC', sid, s.walk_sec ?? Math.round((s.distance_m||hv(origin,{lat:s.lat,lng:s.lng??s.lon}))/1.25),
                s.walk_m ?? (s.distance_m||0), { type:'WALK', reason:'origin-approach' });
        });

        if (destino && destStops.length) {
            destStops.forEach(s=>{
                const sid = `S${s.id}`;
                addEdge(sid, 'DST', s.walk_sec ?? Math.round((s.distance_m||hv({lat:s.lat,lng:s.lng??s.lon}, destino))/1.25),
                    s.walk_m ?? (s.distance_m||0), { type:'WALK', reason:'dest-approach' });
            });
        }

        return { graph, nodeInfo };
    }

    // plan() SIN fallback de caminata
    async function plan({
        N = 3,
        maxWalkMin = 18,
        transferPenaltyMin = 4,
        transferMaxWalkMin = 8,
        transferRadiusM = 250,
        busAvgSpeedMps = 5.0
    } = {}) {

        if (window.__omsaRoutingBusy) {
            console.warn("[OMSA] plan() ya está corriendo; se ignora esta llamada.");
            return { ok:false, skipped:true };
        }
        window.__omsaRoutingBusy = true;

        try {
            const attempts = [
                { N, maxWalkMin, transferPenaltyMin, transferMaxWalkMin, transferRadiusM },
                { N: Math.max(N, 5), maxWalkMin: Math.max(maxWalkMin, 22), transferPenaltyMin: 3, transferMaxWalkMin: Math.max(transferMaxWalkMin, 10), transferRadiusM: Math.max(transferRadiusM, 400) },
                { N: Math.max(N, 6), maxWalkMin: Math.max(maxWalkMin, 28), transferPenaltyMin: 3, transferMaxWalkMin: Math.max(transferMaxWalkMin, 12), transferRadiusM: Math.max(transferRadiusM, 600) }
            ];

            const runOnce = async (cfg) => {
                await window.omsaStops.waitUntilBuilt(120000);

                const origen = window.omsaTrip?.getOrigen?.();
                const destino = window.omsaTrip?.getDestino?.();
                if (!origen) throw new Error("Falta origen (ubicación o Shift+clic).");

                document.dispatchEvent(new CustomEvent("omsa:route-building", { detail: cfg }));

                let originStops = [], destStops = [];
                if (window.omsaCandidates?.compute) {
                    const cand = await window.omsaCandidates.compute({ N: cfg.N, maxWalkMin: cfg.maxWalkMin });
                    originStops = cand.origen || [];
                    destStops = destino ? (cand.destino || []) : [];
                } else {
                    originStops = window.omsaStops.nearest(origen, cfg.N);
                    destStops = destino ? window.omsaStops.nearest(destino, cfg.N) : [];
                }

                // Mejorar tiempos a pie (no obligatorio, pero ayuda)
                const walkFix = async (a, b) => {
                    try {
                        const { DirectionsService, TravelMode } = await google.maps.importLibrary("routes");
                        const ds = new DirectionsService();
                        const r = await routeAsync(ds, { origin: a, destination: b, travelMode: TravelMode.WALKING });
                        const leg = r?.routes?.[0]?.legs?.[0];
                        return { sec: leg?.duration?.value ?? null, meters: leg?.distance?.value ?? null };
                    } catch { return null; }
                };
                await Promise.all(originStops.map(async s => {
                    const w = await walkFix(origen, { lat: s.lat, lng: s.lng ?? s.lon });
                    if (w) { s.walk_m = w.meters; s.walk_sec = w.sec; }
                }));
                const destinoActual = window.omsaTrip?.getDestino?.();
                if (destinoActual) await Promise.all(destStops.map(async s => {
                    const w = await walkFix({ lat: s.lat, lng: s.lng ?? s.lon }, destinoActual);
                    if (w) { s.walk_m = w.meters; s.walk_sec = w.sec; }
                }));

                const { graph, nodeInfo } = buildGraph({
                    origin: origen,
                    destino: destinoActual,
                    originStops,
                    destStops,
                    transferRadiusM: cfg.transferRadiusM,
                    transferMaxWalkMin: cfg.transferMaxWalkMin,
                    busAvgSpeedMps
                });

                const endId = destinoActual ? 'DST' :
                    (destStops[0] ? `S${destStops[0].id}` :
                    originStops[0] ? `S${originStops[0].id}` : null);
                if (!endId) return null;

                const result = dijkstra('SRC', endId, graph, cfg.transferPenaltyMin * 60);
                if (!result) return null;

                const legs = compressToLegs(result.path, nodeInfo);
                return { ok: true, total_sec: result.totalSec, legs, meta: cfg };
            };

            for (let i = 0; i < attempts.length; i++) {
                const cfg = attempts[i];
                const out = await runOnce(cfg);
                if (out) {
                    document.dispatchEvent(new CustomEvent("omsa:route-ready", { detail: out }));
                    return out;
                }
            }

            const e = { ok:false, error: "No hay ruta disponible entre el origen y el destino." };
            document.dispatchEvent(new CustomEvent("omsa:route-error", { detail: e }));
            return e;

        } finally {
            window.__omsaRoutingBusy = false;
        }
    }

    window.omsaRoute = { plan };
})();


// ============================================================
// SUBTAREA 6 — Render del itinerario + rótulos discretos
// ============================================================
(function setupItineraryRender() {
    const overlays = [];

    function chunkPoints(points, maxPoints = 25) {
        const segments = [];
        if (!points || points.length < 2) return segments;
        let start = 0;
        while (start < points.length - 1) {
            const end = Math.min(start + maxPoints - 1, points.length - 1);
            const origin = points[start];
            const destination = points[end];
            const waypoints = points.slice(start + 1, end).map(p => ({ location: p, stopover: true }));
            segments.push({ origin, destination, waypoints });
            start = end;
        }
        return segments;
    }

    function clearItineraryOverlays() {
        while (overlays.length) {
            const o = overlays.pop();
            try { o.setMap && o.setMap(null); } catch {}
        }
    }
    function addOverlay(o){ overlays.push(o); }

    function toRad(d){ return d*Math.PI/180; }
    function haversine(a,b){
        const R=6371000;
        const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
        const s1=Math.sin(dLat/2)**2;
        const s2=Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
        return 2*R*Math.asin(Math.sqrt(s1+s2));
    }
    function minutes(sec){ return Math.max(0, Math.round(sec/60)); }
    function meters(k){ return Math.round(k); }

    function getBusPathForLeg(routeCode, from, to) {
        const arr = (window.omsaStops?.getByRoute(routeCode) || []).map(p => ({
            lat: p.lat, lng: p.lng ?? p.lon, id: p.id, nombre: p.nombre
        }));
        if (arr.length < 2) return [from, to];

        function nearestIdx(pt){
            let best=-1, bestD=Infinity;
            for (let i=0;i<arr.length;i++){
                const d = haversine(pt, arr[i]);
                if (d < bestD){ bestD=d; best=i; }
            }
            return best;
        }
        let i0 = nearestIdx(from);
        let i1 = nearestIdx(to);
        if (i0 === -1 || i1 === -1) return [from, to];

        if (i0 <= i1) {
            return [from, ...arr.slice(i0+1, i1+1), to];
        } else {
            const slice = arr.slice(i1, i0+1).reverse();
            return [from, ...slice.slice(1), to];
        }
    }

    // drawPolyline: AÑADE clickable:false
    function drawPolyline(path, style){
        const pl = new google.maps.Polyline({
            path,
            map: _gmapSafe(),
            strokeColor: style.color,
            strokeOpacity: style.opacity ?? 1,
            strokeWeight: style.weight ?? 5,
            zIndex: style.z ?? 5,
            icons: style.icons || [],
            clickable: false,             // 👈 clave
        });
        addOverlay(pl);
        return pl;
    }

    // drawDotted: AÑADE clickable:false
    function drawDotted(path, { color = "#1a73e8", z = 100, repeat = "14px", scale = 3.2 } = {}) {
        const pl = new google.maps.Polyline({
            path,
            map: _gmapSafe(),
            strokeOpacity: 0,
            zIndex: z,
            icons: [{
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale,
                    fillColor: color,
                    fillOpacity: 1,
                    strokeColor: color,
                    strokeOpacity: 1
                },
                offset: "0",
                repeat
            }],
            clickable: false,             // 👈 clave
        });
        addOverlay(pl);
        return pl;
    }

    async function drawWalk(from, to) {
        try {
            const { DirectionsService, TravelMode } = await google.maps.importLibrary("routes");
            const ds = new DirectionsService();
            const res = await routeAsync(ds, {
                origin: from,
                destination: to,
                travelMode: TravelMode.WALKING,
                provideRouteAlternatives: false
            });

            const route = res?.routes?.[0];
            let path = route?.overview_path;
            if (!path || !path.length) {
                path = [];
                const legs = route?.legs || [];
                legs.forEach(l => (l.steps || []).forEach(s => {
                    if (Array.isArray(s.path)) path.push(...s.path);
                }));
            }
            if (!path || !path.length) path = [from, to];

            drawDotted(path, { color: "#1a73e8", z: 110, repeat: "14px", scale: 3.2 });
        } catch {
            drawDotted([from, to], { color: "#1a73e8", z: 110, repeat: "14px", scale: 3.2 });
        }
    }

    async function drawBus(routeCode, from, to) {
        const points = getBusPathForLeg(routeCode, from, to);
        if (!points || points.length < 2) return;

        const color = "#2E7D32"; // verde OMSA
        try {
            const { DirectionsService, TravelMode } = await google.maps.importLibrary("routes");
            const ds = new DirectionsService();

            const segments = chunkPoints(points, 25);
            for (const seg of segments) {
                const res = await routeAsync(ds, {
                    origin: seg.origin,
                    destination: seg.destination,
                    waypoints: seg.waypoints,
                    travelMode: TravelMode.DRIVING,
                    optimizeWaypoints: false,
                    provideRouteAlternatives: false
                });

                const route = res?.routes?.[0];
                let path = route?.overview_path;
                if (!path || !path.length) {
                    path = [];
                    const legs = route?.legs || [];
                    legs.forEach(l => (l.steps || []).forEach(s => {
                        if (Array.isArray(s.path)) path.push(...s.path);
                    }));
                }
                if (!path || !path.length) path = [seg.origin, seg.destination];

                // 👇 flechas pequeñas en la ruta
                drawPolyline(path, {
                    color,
                    weight: 5,
                    z: 90,
                    icons: [{
                        icon: {
                            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                            scale: 2.8,
                            strokeColor: color,
                            strokeOpacity: 1,
                            fillColor: color,
                            fillOpacity: 1
                        },
                        offset: "0",
                        repeat: "50px"   // distancia entre flechas
                    }]
                });
            }
        } catch {
            drawPolyline(points, {
                color,
                weight: 5,
                z: 90,
                icons: [{
                    icon: {
                        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                        scale: 2.8,
                        strokeColor: color,
                        strokeOpacity: 1,
                        fillColor: color,
                        fillOpacity: 1
                    },
                    offset: "0",
                    repeat: "50px"
                }]
            });
        }
    }

    // Panel de pasos
    function ensurePanel() {
        let panel = document.getElementById("panel-ruta");
        if (panel) return panel;
        const buscar = document.getElementById("tab-recorrido");
        const parent = buscar || document.body;
        panel = document.createElement("div");
        panel.id = "panel-ruta";
        const title = document.createElement("div");
        title.textContent = "Recorrido";
        title.style.fontWeight = "700";
        title.style.marginBottom = "6px";
        panel.appendChild(title);
        parent.prepend(panel);
        return panel;
    }

    // Fusiona patrones walk + bus + walk cuando el bus es "insignificante"
    function simplifyShortHops(legs) {
        const out = [];
        for (let i = 0; i < legs.length; i++) {
            const prev = out[out.length - 1];
            const cur  = legs[i];
            const next = legs[i + 1];

            // Bus entre dos caminatas
            if (prev && next && prev.type === 'walk' && cur.type === 'bus' && next.type === 'walk') {
            const stops   = cur.stops ?? cur.stop_count ?? 0;
            const busDist = (cur.distance_m ?? (cur.distance_km ? cur.distance_km * 1000 : 0));
            const busMins = cur.duration_min ?? cur.duration ?? 0;
            const walkSum = (prev.distance_m ?? 0) + (next.distance_m ?? 0);

            const veryShortByStops   = stops > 0 && stops < ROUTE_RULES.MIN_BUS_STOPS;
            const veryShortByDist    = busDist > 0 && busDist <= ROUTE_RULES.MAX_SHORT_BUS_DIST_M;
            const veryShortByTime    = busMins > 0 && busMins <= ROUTE_RULES.BUS_STEP_TIME_MIN;

            if (walkSum >= ROUTE_RULES.MIN_ADJ_WALK_SUM_M && (veryShortByStops || veryShortByDist || veryShortByTime)) {
                // 👉 Reemplazamos (prev + cur + next) por UNA caminata
                const merged = {
                type: 'walk',
                distance_m: (prev.distance_m ?? 0) + (next.distance_m ?? 0) + Math.min(busDist || 0, ROUTE_RULES.MAX_SHORT_BUS_DIST_M / 2),
                from: prev.from ?? cur.from ?? 'Origen',
                to:   next.to   ?? cur.to   ?? 'Destino'
                };
                out[out.length - 1] = merged; // sustituye el 'prev'
                i += 1; // saltamos 'next'
                continue;
            }
            }

            out.push(cur);
        }
        return out;
    }


    function renderStepsPanel(legs, totalSec) {
        const panel = ensurePanel();

        // 👉 Activar automáticamente la pestaña "Recorrido" al mostrar pasos
        const btnRec = document.querySelector('.tab[data-tab="recorrido"]');
        const panRec = document.getElementById('tab-recorrido');
        if (btnRec && panRec && !panRec.classList.contains('is-active')) {
            // desactivar lo activo
            document.querySelectorAll('.tab.is-active').forEach(t => t.classList.remove('is-active'));
            document.querySelectorAll('.tabpanel.is-active').forEach(p => p.classList.remove('is-active'));
            // activar "Recorrido"
            btnRec.classList.add('is-active');
            panRec.classList.add('is-active');
        }

        // Mostrar/actualizar banner de próximo bus
        startNextBusBanner();


        panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>
        <div style="opacity:.75;margin-bottom:8px">Tiempo total aprox.: ${minutes(totalSec)} min</div>`;

        const ul = document.createElement("ol");
        ul.style.paddingLeft = "18px";
        ul.style.margin = "0";

        legs.forEach((leg) => {
            const li = document.createElement("li");
            li.style.marginBottom = "6px";
            if (leg.type === "WALK") {
                const dist = leg.meters ? ` (${meters(leg.meters)} m)` : "";
                const reason = leg.routeCode ? "" : (leg.reason === "transfer" ? " (transferencia)" : "");
                li.textContent = `Camina ${minutes(leg.secs)} min${dist}${reason} — ${leg.from?.name || "Inicio"} → ${leg.to?.name || "Destino"}`;
            } else {
                const hops = leg.hops ? `, ${leg.hops} paradas` : "";
                li.textContent = `Toma corredor ${leg.routeCode}${hops} — ${leg.from?.name || ""} → ${leg.to?.name || ""}`;
            }
            ul.appendChild(li);
        });

        panel.appendChild(ul);
    }

    // ====== Rótulos discretos ======
    function showLabel(winRefName, position, text) {
        try { hideLabel(winRefName); } catch {}

        const outer = document.createElement("div");
        outer.style.cssText = `
            background: #dfdfdf;
            border: 0;
            padding: 3px;
            margin: 0;
            border-radius: 8px;
            pointer-events: none;
            transform: translate(64px, 32px);
        `;

        const inner = document.createElement("div");
        inner.textContent = text || "Parada";
        inner.style.cssText = `
            display: inline-block;
            box-sizing: border-box;
            max-width: 100px;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
            font-size: 12px;
            font-weight: bold;
            color: #000;
            padding: 0;
            margin: 0;
        `;

        outer.appendChild(inner);

        const { AdvancedMarkerElement } = google.maps.marker;
        const marker = new AdvancedMarkerElement({
            map: _gmapSafe(),
            position,
            content: outer,
            zIndex: 2000
        });

        if (winRefName === "boarding") boardingLabelWin = marker;
        else alightingLabelWin = marker;
    }

    function hideLabel(winRefName) {
        const ref = (winRefName === "boarding") ? boardingLabelWin : alightingLabelWin;
        if (ref) { try { ref.map = null; } catch {} }
        if (winRefName === "boarding") boardingLabelWin = null;
        else alightingLabelWin = null;
    }

    function offsetMeters(pos, dx = 6, dy = 0) {
        const dLat = dy / 111320;
        const dLng = dx / (111320 * Math.cos(pos.lat * Math.PI/180));
        return { lat: pos.lat + dLat, lng: pos.lng + dLng };
    }

    async function renderItinerary(out) {
        if (!out || !out.ok || !Array.isArray(out.legs)) return;
        clearItineraryOverlays();

        const bounds = new google.maps.LatLngBounds();

        for (const leg of out.legs) {
            const from = { lat: leg.from.lat, lng: leg.from.lng };
            const to   = { lat: leg.to.lat,   lng: leg.to.lng   };

            if (leg.type === "WALK") {
                await drawWalk(from, to);
            } else if (leg.type === "BUS") {
                await drawBus(leg.routeCode, from, to);
            }

            bounds.extend(from); bounds.extend(to);
        }

        try { _gmapSafe().fitBounds(bounds); } catch {}
        renderStepsPanel(out.legs, out.total_sec);

        const legs = out.legs || [];
        const firstBus = legs.find(l => l.type === "BUS");
        const lastBus  = [...legs].reverse().find(l => l.type === "BUS");

        if (firstBus?.from?.lat != null && firstBus?.from?.lng != null) {
            const pos = offsetMeters({ lat: firstBus.from.lat, lng: firstBus.from.lng }, 6, 0);
            const name = firstBus.from.name || "Parada de abordaje";
            showLabel("boarding", pos, name);
        } else {
            hideLabel("boarding");
        }

        if (lastBus?.to?.lat != null && lastBus?.to?.lng != null) {
            const pos = offsetMeters({ lat: lastBus.to.lat, lng: lastBus.to.lng }, 6, 0);
            const name = lastBus.to.name || "Parada de descenso";
            showLabel("alighting", pos, name);
        } else {
            hideLabel("alighting");
        }
    }

    document.addEventListener("omsa:route-building", () => {
        const panel = ensurePanel();
        panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>
        <div style="opacity:.75">Buscando ruta…</div>`;
        clearItineraryOverlays();
        hideLabel("boarding");
        hideLabel("alighting");
        clearItineraryOverlays();
    });

    document.addEventListener("omsa:route-ready", (e) => {
        renderItinerary(e.detail);
    });

    document.addEventListener("omsa:route-error", () => {
        clearItineraryOverlays();
        hideLabel("boarding");
        hideLabel("alighting");
        const panel = ensurePanel();
        panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>
        <div style="opacity:.85;margin-bottom:8px">No hay ruta disponible entre el origen y el destino.</div>`;
    });

    // >>> NUEVO: expongo un limpiador público para el botón "Borrar"
    window.omsaUI = window.omsaUI || {};
    window.omsaUI.renderItinerary = renderItinerary;
    window.omsaUI.clearAll = function () {
        clearItineraryOverlays();
        hideLabel("boarding");
        hideLabel("alighting");
        const panel = document.getElementById("panel-ruta");
        if (panel) panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>`;
    };

})();


// ============================================================
// UI EXTRA: Tabs, FABs, Paradas cercanas, Omnibox modes
// ============================================================
(function extraUI() {
    function qs(sel){ return document.querySelector(sel); }
    function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }

    // Tabs
   // Tabs
    function bindTabs() {
        const tabs   = document.querySelectorAll('.tabs .tab');
        const panels = document.querySelectorAll('.tabpanel');

        if (!tabs.length || !panels.length) return;

        // click en pestañas
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
            const id = tab.dataset.tab; // 'rutas' | 'cercanas' | 'recorrido'

            // desactivar todo
            tabs.forEach(t => t.classList.remove('is-active'));
            panels.forEach(p => p.classList.remove('is-active'));

            // activar la pestaña pulsada y su panel
            tab.classList.add('is-active');
            const panel = document.getElementById(`tab-${id}`);
            if (panel) panel.classList.add('is-active');

            // cargar cercanas si corresponde (con guardas)
            if (id === 'cercanas' && typeof window.loadNearbyStops === 'function') {
                window.loadNearbyStops();
            }
            });
        });

        // sincronizar estado inicial (por si solo el botón tiene is-active)
        const activeTab = document.querySelector('.tabs .tab.is-active') || tabs[0];
        if (activeTab) {
            const id = activeTab.dataset.tab;
            tabs.forEach(t => t.classList.remove('is-active'));
            panels.forEach(p => p.classList.remove('is-active'));
            activeTab.classList.add('is-active');
            const panel = document.getElementById(`tab-${id}`);
            if (panel) panel.classList.add('is-active');
        }
    }

    // >>> BOOT: ejecutar bindTabs al cargar el DOM (una sola vez)
    (function () {
        const boot = () => { try { bindTabs(); } catch (e) { console.warn(e); } };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
            boot();
        }
    })();



    // Modo de búsqueda (places vs omsa)
    function bindModes() {
        const modes = qsa('.mode-btn');
        modes.forEach(btn => {
            btn.addEventListener('click', () => {
                modes.forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-selected','false'); });
                btn.classList.add('is-active'); btn.setAttribute('aria-selected','true');
                const input = qs('#search-box');
                if (btn.dataset.mode === 'places') {
                    input.placeholder = "Buscar destino (Google)…";
                } else {
                    input.placeholder = "Buscar rutas/paradas (OMSA)…";
                }
                // Forzar refresco de resultados del aside
                const ev = new Event('input');
                input.dispatchEvent(ev);
            });
        });
    }

    // FABs
    function bindFABs() {
        const my = qs('#fab-my-location');
        const set = qs('#fab-set-origin-hint');
        const clr = qs('#fab-clear-map');

        my?.addEventListener('click', () => {
            const live = window.__omsaUserLivePos;
            if (live && _gmapSafe()) _gmapSafe().panTo({ lat: live.lat, lng: live.lng });
            else alert("Aún no tengo tu ubicación. Revisa permisos.");
        });

        set?.addEventListener('click', () => {
            alert("Consejo: mantén presionada la tecla Shift y haz clic en el mapa para fijar manualmente tu origen.");
        });

        clr?.addEventListener('click', () => {
            // Limpio las paradas/ruta (línea azul)
            clearRouteOverlays();
            // >>> NUEVO: limpio también itinerario/caminatas/línea verde y panel
            try { window.omsaUI?.clearAll?.(); } catch {}

            // (Opcional) también oculto rótulos si algo quedó colgado
            try { if (boardingLabelWin) boardingLabelWin.map = null; } catch {}
            try { if (alightingLabelWin) alightingLabelWin.map = null; } catch {}

            // 👉 NUEVO: eliminar banner "Próximo bus" y detener su timer
            const banner = document.getElementById('recorrido-banner');
            if (banner) banner.remove();
            if (typeof nextBusTimer !== 'undefined' && nextBusTimer) {
                clearInterval(nextBusTimer);
                nextBusTimer = null;
            }

            // 👉 NUEVO: resetear la tarjeta de Recorrido
            const panel = document.getElementById('panel-ruta');
            if (panel) {
                panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>`;
            }
        });
    }


    // Mini-card acciones
    function bindDestinoCard() {
        const btnGo = qs('#btn-go');
        const btnChange = qs('#btn-change');
        btnGo?.addEventListener('click', () => {
            clearRouteOverlays();
            window.omsaRoute?.plan?.().catch(console.error);
            // Cambiar a pestaña "Buscar" para ver el stepper
            const buscarTab = qsa('.tab').find(t => t.dataset.tab === 'buscar');
            buscarTab?.click();
        });
        btnChange?.addEventListener('click', () => {
            const input = qs('#search-box');
            input?.focus();
            input?.select();
        });
    }

    const MAX_DISTANCE_M = 1500;  // máximo permitido en metros

    // ==================== Paradas cercanas (solo cliente) ====================
    async function loadNearbyStops() {
        try {
            if (!window.omsaStops?.built) await window.omsaStops?.waitUntilBuilt?.();
            const origin = window.omsaTrip?.getOrigen?.();
            if (!origin) return;

            const near = (window.omsaStops?.nearest?.(origin, 12) || [])
                .filter(p => (p.distance_m || Infinity) <= MAX_DISTANCE_M);

            const ul = document.getElementById('nearby-stops');
            if (!ul) return;

            ul.innerHTML = "";

            if (!near.length) {
                ul.innerHTML = `<li class="empty">No hay paradas cercanas en un radio de ${MAX_DISTANCE_M} m.</li>`;
                return;
            }

            near.forEach(p => {
                const li = document.createElement('li');
                const dist = Math.round((p.distance_m || 0));
                li.textContent = `${p.nombre} — ${p.ruta_codigo} (${dist} m)`;
                li.addEventListener('click', async () => {
                    await mostrarRuta(p.ruta_codigo);
                    const mk = markerByParadaId.get(p.id);
                    if (mk) {
                        _gmapSafe().setCenter(mk.getPosition());
                        _gmapSafe().setZoom(16);

                        const g = window.google;
                        if (g?.maps?.event) {
                            g.maps.event.trigger(mk, 'click');
                        } else if (g?.maps) {
                            window._omsaInfoWindow = window._omsaInfoWindow || new g.maps.InfoWindow();
                            window._omsaInfoWindow.setContent(p.nombre);
                            window._omsaInfoWindow.open({ map, anchor: mk });
                        }
                    }
                });
                ul.appendChild(li);
            });
        } catch (e) {
            console.warn("nearby-stops:", e);
        }
    }

    // Enganches a eventos
    document.addEventListener("omsa:stops-index-ready", loadNearbyStops);
    document.addEventListener("omsa:livepos", loadNearbyStops);

    document.getElementById("tab-cercanas-btn")?.addEventListener("click", () => {
        // Carga al abrir la pestaña
        loadNearbyStops();
    });


    // O si usas tabs por ARIA/clases, puedes observar cuándo se activa el panel:
    const _tabCercanas = document.getElementById("tab-cercanas");
    if (_tabCercanas) {
        const obs = new MutationObserver(() => {
            const visible = !_tabCercanas.hasAttribute("hidden") &&
                            getComputedStyle(_tabCercanas).display !== "none";
            if (visible) loadNearbyStops();
        });
        obs.observe(_tabCercanas, { attributes: true, attributeFilter: ["hidden", "style", "class"] });
    }


      // --- BOOT EXTRA: inicializar modes, FABs y mini-card al cargar el DOM
  // --- BOOT EXTRA: inicializar modes, FABs y mini-card al cargar el DOM
    (function () {
        const boot = () => {
        try {
            bindModes();
            bindFABs();
            bindDestinoCard();
        } catch (e) { console.warn(e); }
        };
        if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
        } else {
        boot();
        }
    })();

    // Exponer loadNearbyStops para llamadas externas (p.ej. desde cargarRutas)
    window.loadNearbyStops = loadNearbyStops;




})();
