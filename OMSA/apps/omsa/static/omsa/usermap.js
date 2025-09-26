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

let overlaysByRoute = new Map();
const isRouteShown = (code) => overlaysByRoute.has(code);

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

// === OMSA WhatsApp (rehecho desde cero, 1 sola pestaña garantizada) ===
window.OMSA_WA = (function () {
    let winRef = null;           // referencia a la única pestaña/ventana
    let opening = false;         // candado fuerte anti-doble-disparo

    function buildShareUrl(message, link) {
        const txt = [message || "", link || ""].filter(Boolean).join(" ").trim();
        return "https://api.whatsapp.com/send?text=" + encodeURIComponent(txt);
    }

    function open(message, link) {
        if (opening) return true;
        opening = true;

        const url = buildShareUrl(message, link);

        try {
            // 1) Abrimos/reciclamos SIEMPRE la MISMA pestaña nombrada
            //    (primero sin URL para evitar la segunda pestaña en algunos navegadores)
            winRef = window.open("", "omsa-wa");

            if (!winRef || winRef.closed) {
                // 2) Si el popup fue bloqueado, forzamos navegación con un <a> de respaldo
                const a = document.createElement("a");
                a.href = url;
                a.target = "omsa-wa";
                a.rel = "noreferrer noopener";
                document.body.appendChild(a);
                a.click();
                a.remove();
            } else {
                // 3) Navegamos explícitamente en la MISMA pestaña
                try { winRef.opener = null; } catch {}
                winRef.location.assign(url);
            }
        } finally {
            setTimeout(() => { opening = false; }, 1000);
        }
        return true;
    }

    return { open, buildShareUrl };
})();


function escapeHtml(s){ 
    return (s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Iconos (se crean en runtime porque google.* puede no estar aún cargado)
function getNormalStopIcon(){
    return {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 6,
        strokeColor: "#ffffff",
        strokeWeight: 3,
        fillColor: "#2e7d32",
        fillOpacity: 1
    };
}
function getSelectedStopIcon(){
    return {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
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
    // borrar por-ruta
    overlaysByRoute.forEach(entry => {
        try { (entry.markers || []).forEach(m => m.setMap(null)); } catch {}
        try { (entry.renderers || []).forEach(r => r.setMap(null)); } catch {}
    });
    overlaysByRoute.clear();

    // compat
    try { routeMarkers.forEach(m => m.setMap(null)); } catch {}
    try { directionsRenderers.forEach(r => r.setMap(null)); } catch {}
    routeMarkers = [];
    directionsRenderers = [];

    // limpiar índices y selección
    markerByParadaId.clear();
    ultimasParadas = [];
    clearSelectedStop();

    // >>> Re-render de listas para que desaparezcan TODAS las “×”
    try {
        const filtro1 = document.getElementById("search-box")?.value || "";
        renderListaRutasYParadas(filtro1, []);
        const filtro2 = document.getElementById("rutas-search")?.value || "";
        renderListaRutasEnRutasPanel(filtro2, []);
    } catch {}
}


function ocultarRuta(codigo) {
    const entry = overlaysByRoute.get(codigo);
    if (!entry) return;

    // quitar del mapa
    try { (entry.markers || []).forEach(m => m.setMap(null)); } catch {}
    try { (entry.renderers || []).forEach(r => r.setMap(null)); } catch {}

    // liberar ids de paradas
    try { (entry.paradas || []).forEach(p => markerByParadaId.delete(p.id)); } catch {}

    overlaysByRoute.delete(codigo);

    // si la parada seleccionada pertenecía a esta ruta, deseleccionar
    try { clearSelectedStop(); } catch {}

    // refrescar listas (para que desaparezca la “×”)
    try {
        const filtro1 = document.getElementById("search-box")?.value || "";
        renderListaRutasYParadas(filtro1, []);
        const filtro2 = document.getElementById("rutas-search")?.value || "";
        renderListaRutasEnRutasPanel(filtro2, []);
    } catch {}
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

    // Rutas (compacto + botón “×” si está pintada)
    rutas.forEach(r => {
    const li = document.createElement("li");
    li.style.cursor = "pointer";
    li.style.margin = "0";
    li.style.padding = "4px 8px";                 // aún más compacto
    const shown = isRouteShown(r.codigo);

    li.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px">
            <div class="rt-title" style="margin:0">
                <div class="rt-t1">${r.nombre}</div>
                <div class="rt-t2">(${r.origen} → ${r.destino})</div>
            </div>
            ${shown ? `<button class="rt-close" title="Quitar ruta" aria-label="Quitar ruta"
                        style="border:0;background:#eee;border-radius:6px;width:30px;height:30px;cursor:pointer;font-weight:700;line-height:1">×</button>` : ``}
        </div>`;


        li.querySelector('.rt-title').addEventListener('click', () => {
            rutaSeleccionada = r.codigo;
            try { clearSelectedStop?.(); } catch {}
            mostrarRuta(r.codigo);
        });

        const btnX = li.querySelector('.rt-close');
        if (btnX) btnX.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ocultarRuta(r.codigo);
        });

        if (rutaSeleccionada === r.codigo) li.classList.add("ruta--activa");
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

    // Pintar rutas (toggle con “×” para cerrar)
    rutas.forEach(r => {
        const li = document.createElement("li");
        li.style.cursor = "pointer";
        li.style.margin = "0";
        li.style.padding = "15px 5px 15px 10px";                 // aún más compacto
        const shown = isRouteShown(r.codigo);

        li.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr auto;align-items:center;gap:4px">
                <div class="rt-title" style="margin:0">
                    <div class="rt-t1">${r.nombre}</div>
                    <div class="rt-t2">(${r.origen} → ${r.destino})</div>
                </div>
                ${shown ? `<button class="rt-close" title="Quitar ruta" aria-label="Quitar ruta"
                        style="border:0;background:#eee;border-radius:6px;width:20px;height:20px;cursor:pointer;font-weight:700;line-height:1">×</button>` : ``}
            </div>`;

        li.querySelector('.rt-title').addEventListener('click', () => {
            mostrarRuta(r.codigo);
        });

        const btnX = li.querySelector('.rt-close');
        if (btnX) btnX.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ocultarRuta(r.codigo);
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
        li.style.padding = "15px 5px 15px 10px";
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
    // si ya está pintada, solo centra/ajusta
    if (isRouteShown(codigo)) {
        try {
            const entry = overlaysByRoute.get(codigo);
            const b = new google.maps.LatLngBounds();
            (entry.paradas || []).forEach(p => b.extend(new google.maps.LatLng(p.lat, p.lon ?? p.lng)));
            _gmapSafe().fitBounds(b);
        } catch {}
        return;
    }

    try {
        const res = await fetch(`/api/public/paradas/?codigo=${encodeURIComponent(codigo)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const paradas = await res.json();
        if (!paradas.length) return;

        const bounds = new google.maps.LatLngBounds();
        const markers = [];
        const renderers = [];

        paradas.forEach(p => {
            const pos = new google.maps.LatLng(p.lat, p.lon ?? p.lng);
            bounds.extend(pos);
            const marker = new google.maps.Marker({
                map: _gmapSafe(),
                position: pos,
                title: p.nombre,
                zIndex: 100,
                icon: getNormalStopIcon()
            });
            markerByParadaId.set(p.id, marker);
            markers.push(marker);
            routeMarkers.push(marker); // compat

            marker.addListener('click', () => {
                highlightStopById(p.id, p.nombre);
                _gmapSafe().panTo(marker.getPosition());
                _gmapSafe().setZoom(Math.max(_gmapSafe().getZoom(), 16));
            });
        });

        // Polyline con flechas para la ruta (segmentada)
        const { DirectionsService, DirectionsRenderer, TravelMode } = await google.maps.importLibrary("routes");
        const ds = new DirectionsService();
        const points = paradas.map(p => ({ lat: p.lat, lng: p.lon ?? p.lng }));
        const segments = chunkPoints(points, 25);

        for (const seg of segments) {
            const result = await routeAsync(ds, {
                origin: seg.origin,
                destination: seg.destination,
                waypoints: seg.waypoints,
                travelMode: TravelMode.DRIVING,
                optimizeWaypoints: false,
            });
            const dr = new google.maps.DirectionsRenderer({
                map: _gmapSafe(),
                preserveViewport: true,
                suppressMarkers: true,
                polylineOptions: {
                    strokeColor: '#1a73e8',
                    icons: [{
                        icon: {
                            path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
                            scale: 2,
                            strokeOpacity: 0.9,
                            strokeWeight: 2
                        },
                        offset: '50px',
                        repeat: '150px'
                    }]
                }
            });
            dr.setDirections(result);
            renderers.push(dr);
            directionsRenderers.push(dr); // compat
        }

        // guardar entry para poder cerrar esta ruta sola
        overlaysByRoute.set(codigo, { markers, renderers, paradas });

        // centrar
        try { _gmapSafe().fitBounds(bounds); } catch {}

        // refrescar listas para que se muestre la "×"
        try {
            const filtro1 = document.getElementById("search-box")?.value || "";
            renderListaRutasYParadas(filtro1, []);
            const filtro2 = document.getElementById("rutas-search")?.value || "";
            renderListaRutasEnRutasPanel(filtro2, []);
        } catch {}
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
                fillOpacity: 0.08,
                clickable: false,
                zIndex: 1
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


// Guarda la última posición viva para otros módulos (p.ej. Reportes)
document.addEventListener("omsa:livepos", (e) => {
    const { lat, lng } = e.detail || {};
    if (typeof lat === "number" && typeof lng === "number") {
        window._omsaLastPos = { lat, lng };
    }
});

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
            window.omsaShare?.setDestination(destino.lat, destino.lng);
            // manda SOLO el nombre del lugar en el link (si no hay, cae a la dirección)
            window.omsaShare?.setDestinationName?.(place?.name || destino.address || "");


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
            loadNearbyStops();
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

        // --- utilidades distancia (Haversine local a la función) ---
        const toRad = (d)=> d*Math.PI/180;
        function hv(a,b){
            const R=6371000, dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
            const s1=Math.sin(dLat/2)**2, s2=Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
            return 2*R*Math.asin(Math.sqrt(s1+s2));
        }

        // === 1) Cerrar por alcance las rutas necesarias (cadenas de trasbordo caminando) ===
        const originCodes = new Set(originStops.map(s => s.ruta_codigo || s.codigo_ruta).filter(Boolean));
        const destCodes   = new Set(destStops.map(s => s.ruta_codigo   || s.codigo_ruta).filter(Boolean));

        const routesNeeded = new Set([...originCodes, ...destCodes]);

        const allStops = (window.omsaStops?.getAll?.() || []).map(p => ({ ...p, lng: p.lng ?? p.lon }));
        const stopsOf  = (code) => (window.omsaStops?.getByRoute?.(code) || []).map(p => ({ ...p, lng: p.lng ?? p.lon }));

        const maxWalkSec = transferMaxWalkMin * 60;
        const radiusM    = transferRadiusM;

        // --- helpers for transfer direction and corridor similarity ---
        const _cacheRouteOrder = new Map();
        function _getRouteOrder(code){
            if (!_cacheRouteOrder.has(code)) _cacheRouteOrder.set(code, routeOrderCacheFor(code));
            return _cacheRouteOrder.get(code);
        }
        function _idxOnRoute(code, stopId){
            const { idToIdx } = _getRouteOrder(code) || {};
            return idToIdx ? idToIdx.get(stopId) : null;
        }
        function _destIdx(code){
            if (!destino) return null;
            return nearestIndexOnRoute(code, destino);
        }

        function _isForwardToDest(code, stopId){
            const order = _getRouteOrder(code) || {};
            const arr = order.arr || [];
            const idToIdx = order.idToIdx || null;
            const i = idToIdx ? idToIdx.get(stopId) : null;
            if (!Array.isArray(arr) || i == null) return true;

            const dir = _dirAtStop(code, stopId);
            const s = arr[i];
            const b2d = (destino && typeof destino.lat === 'number' && typeof destino.lng === 'number')
                ? _bearing({lat:s.lat,lng:s.lng},{lat:destino.lat,lng:destino.lng})
                : null;

            const ANGLE_FWD = 85; // ← más estricto
            if (dir != null && b2d != null) {
                return _angleDiff(dir, b2d) <= ANGLE_FWD;
            }

            const di = _destIdx(code);
            const si = _idxOnRoute(code, stopId);
            if (di == null || di < 0 || si == null) return true;
            return si <= di;
        }


        function _bearing(a,b){
            const phi1 = a.lat*Math.PI/180, phi2 = b.lat*Math.PI/180;
            const lam1 = a.lng*Math.PI/180, lam2 = b.lng*Math.PI/180;
            const y = Math.sin(lam2-lam1)*Math.cos(phi2);
            const x = Math.cos(phi1)*Math.sin(phi2)-Math.sin(phi1)*Math.cos(phi2)*Math.cos(lam2-lam1);
            const th = Math.atan2(y,x);
            return (th*180/Math.PI+360)%360;
        }
        function _dirAtStop(code, stopId){
            const { arr, idToIdx } = _getRouteOrder(code) || {};
            if (!arr || !idToIdx) return null;
            const i = idToIdx.get(stopId);
            if (i == null) return null;
            const prev = arr[Math.max(0, i-1)];
            const next = arr[Math.min(arr.length-1, i+1)];
            if (!prev || !next) return null;
            return _bearing({lat:prev.lat,lng:prev.lng},{lat:next.lat,lng:next.lng});
        }
        function _angleDiff(a,b){
            const d = Math.abs(a-b)%360;
            return d>180 ? 360-d : d;
        }


        // BFS por rutas: si desde una ruta puedo caminar a otra dentro del radio/tiempo, la añado
        const queue = [...routesNeeded];
        const MAX_ROUTES_SAFE = 80;  // salvaguarda

        while (queue.length && routesNeeded.size < MAX_ROUTES_SAFE) {
            const code = queue.shift();
            const arrA = stopsOf(code);
            for (const a of arrA) {
                for (const b of allStops) {
                    const bCode = b.ruta_codigo || b.codigo_ruta;
                    if (!bCode || bCode === code || routesNeeded.has(bCode)) continue;
                    const d = hv({lat:a.lat, lng:a.lng}, {lat:b.lat, lng:b.lng});
                    if (d <= radiusM && (d/1.25) <= maxWalkSec) {
                        routesNeeded.add(bCode);
                        queue.push(bCode);
                    }
                }
            }
        }

        // === 2) Nodos + aristas BUS (adelante) para TODAS las rutas necesarias ===
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

                    const meters = hv({ lat: s.lat, lng: s.lng ?? s.lon }, { lat: t.lat, lng: t.lng ?? t.lon });
                    const secs = Math.max(1, Math.round(meters / busAvgSpeedMps));
                    addEdge(id, id2, secs, meters, { type: 'BUS', routeCode: code });
                }
            }
        });

        // === 3) Trasbordos WALK entre TODAS las rutas necesarias ===
        const allRelStops = [];
        routesNeeded.forEach(code => {
            (window.omsaStops.getByRoute(code) || []).forEach(s => allRelStops.push({ ...s, lng: s.lng ?? s.lon }));
        });

        for (let i=0;i<allRelStops.length;i++){
            const a = allRelStops[i];
            const aid = `S${a.id}`;
            for (let j=i+1;j<allRelStops.length;j++){
                const b = allRelStops[j];
                if ((a.ruta_codigo||a.codigo_ruta) === (b.ruta_codigo||b.codigo_ruta)) continue;
                const d = hv({lat:a.lat,lng:a.lng},{lat:b.lat,lng:b.lng});
                const secs = Math.round(d/1.25);
                if (d <= radiusM && secs <= maxWalkSec) {
                    const bid = `S${b.id}`;
                    const codeA = a.ruta_codigo||a.codigo_ruta;
                    const codeB = b.ruta_codigo||b.codigo_ruta;

                    // 3.1) Bloquear trasbordos hacia paradas "en contra" del destino en la nueva ruta
                    const allowAB = _isForwardToDest(codeB, b.id);
                    const allowBA = _isForwardToDest(codeA, a.id);

                    // 3.2) Penalizar trasbordos innecesarios entre corredores paralelos muy cercanos
                    let extraPenaltySecAB = 0, extraPenaltySecBA = 0;
                    const dirA = _dirAtStop(codeA, a.id);
                    const dirB = _dirAtStop(codeB, b.id);
                    if (dirA != null && dirB != null) {
                        const ang = _angleDiff(dirA, dirB);
                        if (d <= 100 && ang <= 30) {
                            extraPenaltySecAB += 360; // +6 min
                            extraPenaltySecBA += 360;
                        }
                    }

                    if (allowAB) addEdge(aid, bid, secs + extraPenaltySecAB, d, { type:'WALK', reason:'transfer' });
                    if (allowBA) addEdge(bid, aid, secs + extraPenaltySecBA, d, { type:'WALK', reason:'transfer' });
                }
            }
        }

        // === 4) SRC/DST + enlaces a pie ===
        addNode('SRC', { name:'Origen', routeCode:null, lat:origin.lat, lng:origin.lng });
        if (destino) addNode('DST', { name:'Destino', routeCode:null, lat:destino.lat, lng:destino.lng });

        let addedForward = 0;
        const fallback = [];

        originStops.forEach(s=>{
            const sid = `S${s.id}`;
            const meters = s.walk_m ?? hv(origin, { lat: s.lat, lng: s.lng ?? s.lon });
            const secs   = s.walk_sec ?? Math.round(meters / 1.25);
            const code   = s.ruta_codigo || s.codigo_ruta;

            // Sólo enlazar al origen si la parada está en el sentido del destino.
            const allow = !destino || _isForwardToDest(code, s.id);
            if (allow) {
                addEdge('SRC', sid, secs, meters, { type: 'WALK', reason: 'origin-approach' });
                addedForward++;
            } else {
                fallback.push({ sid, secs, meters });
            }
        });

        // Si no hubo ninguna “a favor”, deja las originales para no quedarte sin ruta.
        if (!addedForward) {
            fallback.forEach(({ sid, secs, meters }) => {
                addEdge('SRC', sid, secs, meters, { type: 'WALK', reason: 'origin-approach(backward-ok)' });
            });
        }

        if (destino && destStops.length) {
            destStops.forEach(s=>{
                const sid = `S${s.id}`;
                const meters = s.walk_m ?? hv({lat:s.lat, lng:s.lng??s.lon}, destino);
                const secs   = s.walk_sec ?? Math.round(meters/1.25);
                addEdge(sid, 'DST', secs, meters, { type:'WALK', reason:'dest-approach' });
            });
        }

        return { graph, nodeInfo };
    }

    // --- Preferir abordaje en el sentido del destino ---------------------------
    function routeOrderCacheFor(code) {
        const arr = (window.omsaStops?.getByRoute?.(code) || [])
            .slice()
            .sort((a,b)=> (a.orden ?? a.order ?? 0) - (b.orden ?? b.order ?? 0))
            .map(p => ({ id:p.id, lat:p.lat, lng:p.lng ?? p.lon, nombre:p.nombre }));
        const idToIdx = new Map();
        arr.forEach((s,i)=> idToIdx.set(s.id, i));
        return { arr, idToIdx };
    }

    function nearestIndexOnRoute(code, point) {
    const { arr } = routeOrderCacheFor(code);
    if (!arr.length || !point) return -1;
    let best = -1, dBest = Infinity;
    for (let i=0;i<arr.length;i++){
        const d = haversine(point, { lat: arr[i].lat, lng: arr[i].lng });
        if (d < dBest) { dBest = d; best = i; }
    }
    return best;
    }

    /**
     * Abordaje: prioriza SIEMPRE el sentido hacia el destino.
     * - Usa un umbral más estricto (≤85°) entre el rumbo del corredor en la parada
     *   y el rumbo parada→destino.
     * - Si la parada "correcta" quedó fuera del TOP-N, inyecta paradas a ≤110 m
     *   del origen cuyo rumbo sí apunte al destino (típico "cruzar la calle").
     * - Ordena por (mejor alineación → menor caminata → menos paradas hasta el
     *   punto de la ruta más cercano al destino).
     */
    function preferForwardOriginStops(originStops, destinoPoint) {
        if (!destinoPoint) return originStops;

        const ANGLE_FWD = 100;           // ← más estricto
        const INJECT_R_M = 180;         // ← “cruzar la calle”
        const NEAR_SCAN_N = 30;         // candidatos cercanos a origen para inyectar

        // ===== helpers de rumbos/alineación (independientes de buildGraph) =====
        const toRad = (d) => d * Math.PI / 180;
        function bearing(a, b) {
            const phi1 = toRad(a.lat), phi2 = toRad(b.lat);
            const lam1 = toRad(a.lng), lam2 = toRad(b.lng);
            const y = Math.sin(lam2 - lam1) * Math.cos(phi2);
            const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lam2 - lam1);
            const th = Math.atan2(y, x);
            return (th * 180 / Math.PI + 360) % 360;
        }
        function angleDiff(a, b) {
            const d = Math.abs(a - b) % 360;
            return d > 180 ? 360 - d : d;
        }
        function dirAtStop(code, stopId) {
            const { arr, idToIdx } = routeOrderCacheFor(code) || {};
            if (!arr || !idToIdx) return null;
            const i = idToIdx.get(stopId);
            if (i == null) return null;
            const prev = arr[Math.max(0, i - 1)];
            const next = arr[Math.min(arr.length - 1, i + 1)];
            if (!prev || !next) return null;
            return bearing({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng });
        }

        // ===== 1) Inyectar paradas “al frente” cercanas al ORIGEN si no vinieron =====
        try {
            const origen = window.omsaTrip?.getOrigen?.();
            if (origen && window.omsaStops?.nearest) {
                const near = window.omsaStops.nearest(origen, NEAR_SCAN_N) || [];
                const seen = new Set(originStops.map(s => s.id));
                for (const p of near) {
                    if (seen.has(p.id)) continue;
                    const wMeters = p.distance_m ?? 0;
                    if (wMeters > INJECT_R_M) continue; // solo muy cerca (cruzar)
                    const code = p.ruta_codigo || p.codigo_ruta;
                    const hdg  = dirAtStop(code, p.id);
                    const b2d  = bearing({ lat: p.lat, lng: p.lng ?? p.lon }, { lat: destinoPoint.lat, lng: destinoPoint.lng });
                    const ok   = (hdg != null) ? (angleDiff(hdg, b2d) <= ANGLE_FWD) : true;
                    if (ok) {
                        originStops.push({
                            ...p,
                            walk_m: Math.round(wMeters),
                            walk_sec: Math.round((wMeters || 0) / 1.25)
                        });
                        seen.add(p.id);
                    }
                }
            }
        } catch {}

        if (!originStops || !originStops.length) return originStops;

        // ===== 2) Clasificar por alineación (adelante/atrás) =====
        const forward = [];
        const backward = [];

        for (const s of originStops) {
            const code = s.ruta_codigo || s.codigo_ruta;
            const hdg  = dirAtStop(code, s.id);
            const b2d  = bearing({ lat: s.lat, lng: s.lng ?? s.lon }, { lat: destinoPoint.lat, lng: destinoPoint.lng });

            let isForward;
            if (hdg != null && Number.isFinite(b2d)) {
                isForward = (angleDiff(hdg, b2d) <= ANGLE_FWD);
            } else {
                // Fallback por índices (si no tuviéramos rumbos)
                const idToIdx = routeOrderCacheFor(code).idToIdx;
                const idxStop = idToIdx ? idToIdx.get(s.id) : null;
                const idxDest = nearestIndexOnRoute(code, destinoPoint);
                isForward = (idxStop == null || idxDest == null || idxDest < 0) ? true : (idxStop <= idxDest);
            }

            (isForward ? forward : backward).push({
                ...s,
                __align: (() => {
                    if (hdg == null || !Number.isFinite(b2d)) return 999;
                    return angleDiff(hdg, b2d);
                })()
            });
        }

        // ===== 3) Ordenar por mejor alineación → menor caminata → menos paradas hasta destino =====
        function stopsToDest(s) {
            const code = s.ruta_codigo || s.codigo_ruta;
            const idToIdx = routeOrderCacheFor(code).idToIdx;
            const idxStop = idToIdx ? idToIdx.get(s.id) : null;
            const idxDest = nearestIndexOnRoute(code, destinoPoint);
            if (idxStop == null || idxDest == null || idxDest < 0) return Number.POSITIVE_INFINITY;
            const d = idxDest - idxStop;
            return d >= 0 ? d : Number.POSITIVE_INFINITY; // “en contra” = malo
        }

        const cmp = (a, b) => {
            if (a.__align !== b.__align) return a.__align - b.__align;
            const wa = (a.walk_sec ?? 0) || (a.walk_m ?? a.distance_m ?? Infinity);
            const wb = (b.walk_sec ?? 0) || (b.walk_m ?? b.distance_m ?? Infinity);
            if (wa !== wb) return wa - wb;
            return stopsToDest(a) - stopsToDest(b);
        };

        forward.sort(cmp);
        backward.sort(cmp);

        if (forward.length) return forward;

        // Si de verdad no hay ninguna “a favor”, deja la mejor “en contra” por corredor
        const bestPerRoute = [];
        const seen = new Set();
        for (const s of backward) {
            const code = s.ruta_codigo || s.codigo_ruta || '';
            if (seen.has(code)) continue;
            seen.add(code);
            bestPerRoute.push(s);
        }
        return bestPerRoute;
    }




        async function plan({
            N = 3,
            maxWalkMin = 18,
            transferPenaltyMin = 7, // subir de 4 → 7 min
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

                const origen        = window.omsaTrip?.getOrigen?.();
                const destinoActual = window.omsaTrip?.getDestino?.();
                if (!origen) throw new Error("Falta origen (ubicación o Shift+clic).");

                document.dispatchEvent(new CustomEvent("omsa:route-building", { detail: cfg }));

                // 1) Candidatos
                let originStops = [], destStops = [];
                if (window.omsaCandidates?.compute) {
                    const cand = await window.omsaCandidates.compute({ N: cfg.N, maxWalkMin: cfg.maxWalkMin });
                    originStops = cand.origen || [];
                    destStops   = destinoActual ? (cand.destino || []) : [];
                } else {
                    originStops = window.omsaStops.nearest(origen, cfg.N);
                    destStops   = destinoActual ? window.omsaStops.nearest(destinoActual, cfg.N) : [];
                }

                // 2) Afinar caminatas (opcional, ayuda a decidir mejor)
                const walkFix = async (a, b) => {
                    try {
                    const { DirectionsService, TravelMode } = await google.maps.importLibrary("routes");
                    const ds = new DirectionsService();
                    const r  = await routeAsync(ds, { origin: a, destination: b, travelMode: TravelMode.WALKING });
                    const l  = r?.routes?.[0]?.legs?.[0];
                    return { sec: l?.duration?.value ?? null, meters: l?.distance?.value ?? null };
                    } catch { return null; }
                };
                await Promise.all(originStops.map(async s => {
                    const w = await walkFix(origen, { lat: s.lat, lng: s.lng ?? s.lon });
                    if (w) { s.walk_m = w.meters; s.walk_sec = w.sec; }
                }));
                if (destinoActual) {
                    await Promise.all(destStops.map(async s => {
                    const w = await walkFix({ lat: s.lat, lng: s.lng ?? s.lon }, destinoActual);
                    if (w) { s.walk_m = w.meters; s.walk_sec = w.sec; }
                    }));
                }

                // 3) 👉 Aquí sí: prioriza abordar en sentido del destino
                originStops = preferForwardOriginStops(originStops, destinoActual, 250);

                // 4) Grafo y ruteo
                const { graph, nodeInfo } = buildGraph({
                    origin: origen,
                    destino: destinoActual,
                    originStops,
                    destStops,
                    transferRadiusM: cfg.transferRadiusM,
                    transferMaxWalkMin: cfg.transferMaxWalkMin,
                    busAvgSpeedMps
                });

                const endId = destinoActual ? 'DST'
                    : (destStops[0] ? `S${destStops[0].id}`
                    : originStops[0] ? `S${originStops[0].id}` : null);
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
    let _shareSegs = []; // segmentos de ruta para compartir


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

            const ptsW = (path || []).map(ll => ({ 
            lat: typeof ll.lat === 'function' ? ll.lat() : ll.lat, 
            lng: typeof ll.lng === 'function' ? ll.lng() : ll.lng 
            }));
            _shareSegs.push(ptsW);
            window._omsaRoutePaths = _shareSegs; // por si el módulo lo toma en automático


            drawDotted(path, { color: "#1a73e8", z: 110, repeat: "14px", scale: 3.2 });
        } catch {
            drawDotted([from, to], { color: "#1a73e8", z: 110, repeat: "14px", scale: 3.2 });
        }
    }

    async function drawBus(routeCode, from, to, color = "#2E7D32") {
        const points = getBusPathForLeg(routeCode, from, to);
        if (!points || points.length < 2) return;

        //const color = "#2E7D32"; // verde OMSA
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

                const ptsB = (path || []).map(ll => ({ 
                lat: typeof ll.lat === 'function' ? ll.lat() : ll.lat, 
                lng: typeof ll.lng === 'function' ? ll.lng() : ll.lng 
                }));
                _shareSegs.push(ptsB);
                window._omsaRoutePaths = _shareSegs;


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
            document.querySelectorAll('.tab.is-active').forEach(t => t.classList.remove('is-active'));
            document.querySelectorAll('.tabpanel.is-active').forEach(p => p.classList.remove('is-active'));
            btnRec.classList.add('is-active');
            panRec.classList.add('is-active');
        }

        // Mostrar/actualizar banner de próximo bus (tu comportamiento actual)
        startNextBusBanner();

        // Cabecera: en modo viewer NUNCA mostramos el botón de compartir
        const isViewer = new URLSearchParams(location.search).has("follow") ||
                        document.documentElement.classList.contains("omsa-viewer");
        const canShare = !isViewer && !!(window.omsaTrip?.getDestino?.());

        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <div style="font-weight:700;flex:1">Recorrido</div>
                ${canShare ? `<button id="omsa-share-btn" type="button"
                        style="padding:4px 10px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;cursor:pointer;font-size:12px">
                    Compartir viaje
                </button>` : ``}
            </div>
            <div style="opacity:.75;margin-bottom:8px">Tiempo total aprox.: ${Math.max(0, Math.round(totalSec/60))} min</div>
        `;



        const ul = document.createElement("ol");
        ul.style.paddingLeft = "18px";
        ul.style.margin = "0";

        legs.forEach((leg) => {
            const li = document.createElement("li");
            li.style.marginBottom = "6px";
            if (leg.type === "WALK") {
                const meters = Math.round(leg.meters || 0);
                const dist = meters ? ` (${meters} m)` : "";
                const reason = leg.routeCode ? "" : (leg.reason === "transfer" ? " (transferencia)" : "");
                li.textContent = `Camina ${Math.max(0, Math.round(leg.secs/60))} min${dist}${reason} — ${leg.from?.name || "Inicio"} → ${leg.to?.name || "Destino"}`;
            } else {
                const hops = leg.hops ? `, ${leg.hops} paradas` : "";
                li.textContent = `Toma corredor ${leg.routeCode}${hops} — ${leg.from?.name || ""} → ${leg.to?.name || ""}`;
            }
            ul.appendChild(li);
        });
        panel.appendChild(ul);

        const btn = panel.querySelector('#omsa-share-btn');
        btn?.addEventListener('click', async (e) => {
            e.preventDefault(); e.stopPropagation();
            try {
                const ok = await (window.omsaTriggerShare?.());
                if (ok) btn.textContent = 'Compartiendo…';
            } catch (e2) {
                console.warn(e2);
                alert('No pude abrir el cuadro de compartir. Intenta nuevamente.');
            }
        });

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
        _shareSegs = []; // limpiar segmentos a compartir


        const bounds = new google.maps.LatLngBounds();

        // Colores por corredor dentro de este itinerario.
        // El primero mantiene el verde actual; los demás alternan.
        const _busPalette = ["#2E7D32", "#E65100", "#8E24AA", "#D81B60", "#00897B", "#6D4C41", "#CBDCEB"];
        const _busColorByRoute = new Map();
        let _busColorIdx = 0;

        function colorForRoute(routeCode){
            if (_busColorByRoute.has(routeCode)) return _busColorByRoute.get(routeCode);
            const c = _busPalette[Math.min(_busColorIdx, _busPalette.length - 1)];
            _busColorByRoute.set(routeCode, c);
            _busColorIdx += 1;
            return c;
        }

        for (const leg of out.legs) {
            const from = { lat: leg.from.lat, lng: leg.from.lng };
            const to   = { lat: leg.to.lat,   lng: leg.to.lng   };

            if (leg.type === "WALK") {
                await drawWalk(from, to);
            } else if (leg.type === "BUS") {
                const color = colorForRoute(leg.routeCode);
                await drawBus(leg.routeCode, from, to, color);
            }

            bounds.extend(from); bounds.extend(to);
        }

        try { _gmapSafe().fitBounds(bounds); } catch {}
        renderStepsPanel(out.legs, out.total_sec);

        window.setFollowDestino = function (nombreDestino) {
            const box = document.getElementById("follow-destino");
            if (box) box.textContent = "Destino: " + (nombreDestino || "(desconocido)");
        };


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

         // === Compartir la línea de trayecto (si la tenemos) ===
        try {
            const flat = (_shareSegs || []).flat();
            if (flat.length) {
                window.omsaShare?.setRoute(flat);
            }
        } catch(e) { /* noop */ }

        try {
            window.omsaRoute = window.omsaRoute || {};
            window.omsaRoute.getLegs = () => Array.isArray(out.legs) ? out.legs.slice() : [];
        } catch {}
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
        // 1) limpiar overlays y rótulos
        clearItineraryOverlays();
        hideLabel("boarding");
        hideLabel("alighting");

        // 2) quitar el banner de próximo bus y detener su timer
        try {
            const b = document.getElementById("recorrido-banner");
            if (b) b.remove();
            if (nextBusTimer) { clearInterval(nextBusTimer); nextBusTimer = null; }
        } catch {}

        // 3) pintar el mensaje de “no hay ruta”
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

    // 👇 quitar el banner de próximo bus y su intervalo
    try {
        const b = document.getElementById("recorrido-banner");
        if (b) b.remove();
        if (nextBusTimer) { clearInterval(nextBusTimer); nextBusTimer = null; }
    } catch {}

    const panel = document.getElementById("panel-ruta");
    if (panel) panel.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Recorrido</div>`;
    window._omsaRoutePaths = [];
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

    // ------------------------------------------------------------
    // Modo SEGUIMIENTO (cuando entra con ?follow=TOKEN)
    // ------------------------------------------------------------
    (function setupFollowViewer() {
    const token = new URLSearchParams(location.search).get("follow");
    if (!token) return; // Solo aplica si hay follow en la URL

    // 1) Quitar buscador y botones Ir/Cambiar
    document.querySelector("#search-form")?.remove();
    document.querySelector("#search-box")?.remove();
    document.querySelector("#btn-go, .btn-ir")?.remove();
    document.querySelector("#btn-change, .btn-cambiar")?.remove();

    // 2) Mostrar la mini-card de destino del header y la llenamos
    const card   = document.getElementById("destino-card");
    const titleEl = document.getElementById("destino-title");
    const addrEl  = document.getElementById("destino-addr");
    if (card && titleEl && addrEl) {
        card.hidden = false;
        titleEl.textContent = "Destino";
        addrEl.textContent  = "";
    }


    // 3) Eliminar FABs / controles flotantes del mapa en el viewer
    document.querySelectorAll(".fab, .fab--primary, .fab--secondary").forEach(el => el.remove());

    // 4) Leyenda: dejar solo “Ruta OMSA” (verde)
    // 4) Leyenda: eliminarla por completo en modo viewer
        const legendRoot = document.querySelector("#legend, .legend");
        if (legendRoot) legendRoot.remove();

        // Por si la leyenda se inyecta tarde, observa y elimínala cuando aparezca.
        const __legendObs = new MutationObserver(() => {
            const lg = document.querySelector("#legend, .legend");
            if (lg) { lg.remove(); __legendObs.disconnect(); }
        });
        __legendObs.observe(document.body, { childList: true, subtree: true });


    // 5) Quitar pestañas que no aplican y dejar solo “Recorrido”
    // (Si existen esas pestañas en tu HTML)
    document.querySelector("#tab-rutas, a[href='#tab-rutas'], [data-tab='rutas']")?.closest(".tab")?.remove();
    document.querySelector("#tab-cercanas, a[href='#tab-cercanas'], [data-tab='paradas'], [data-tab='cercanas']")?.closest(".tab")?.remove();
    // El panel de contenido de esas pestañas
    document.querySelector("#rutas, #panel-rutas, #tab-rutas")?.remove();
    document.querySelector("#paradas, #panel-paradas, #tab-cercanas")?.remove();

    // 6) No pedir geolocalización al espectador
    try {
        if (navigator.geolocation) {
        const nop = () => {};
        navigator.geolocation.getCurrentPosition = nop;
        navigator.geolocation.watchPosition = nop;
        }
    } catch {}

    // 7) Forzar la pestaña “Recorrido” activa (y su panel) SOLO en follow
    function forceRecorridoActive() {
        document.querySelectorAll(".tabs .tab").forEach(n => n.classList.remove("is-active"));
        document.querySelectorAll(".tabpanel").forEach(n => n.classList.remove("is-active"));
        // botón de la pestaña
        (document.querySelector(".tabs .tab[data-tab='recorrido']") ||
        document.querySelector(".tabs .tab a[href='#tab-recorrido']")?.closest(".tab"))
        ?.classList.add("is-active");
        // panel de la pestaña
        (document.getElementById("tab-recorrido") ||
        document.querySelector("#recorrido, #panel-recorrido, #tab-recorrido"))
        ?.classList.add("is-active");
    }
    forceRecorridoActive();
    document.addEventListener("omsa:route-ready", () => { forceRecorridoActive(); });

    // 8) API para que el rótulo se rellene cuando haya ruta (la llamas desde renderItinerary)
    window.setFollowDestino = function (nombreDestino) {
        const box = document.getElementById("follow-destino");
        if (box) box.textContent = "Destino: " + (nombreDestino || "");
    };
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
            // limpio también itinerario/caminatas/línea verde y panel
            try { window.omsaUI?.clearAll?.(); } catch {}

             // borrar origen manual (Shift+clic) y su marker
            try { window.omsaTrip?.clearOrigenOverride?.(); } catch {}

            // limpiar legs expuestas para Reportes
            try {
                window.omsaRoute = window.omsaRoute || {};
                window.omsaRoute.getLegs = () => [];
            } catch {}

            // 3) Recentrar al punto azul si lo tenemos y usarlo como origen por defecto
            try {
                const live = window.__omsaUserLivePos; // se actualiza con "omsa:livepos"
                if (live && _gmapSafe()) {
                _gmapSafe().panTo({ lat: live.lat, lng: live.lng });
                // opcional: asegurar un zoom cómodo
                _gmapSafe().setZoom(Math.max(_gmapSafe().getZoom() || 0, 14));
                }
            } catch {}

            // 4) Refrescar dependencias del origen (paradas cercanas, etc.)
            try { window.loadNearbyStops?.(); } catch {}
            // Reportes: informar que se limpió el destino
            document.dispatchEvent(new CustomEvent('omsa:destination:cleared'));

            // >>> Solo detener el share (tumbar el VIEWER) sin bloquear al PASAJERO
            try {
                const sharing = !!(window.omsaShare && typeof window.omsaShare.isActive === 'function' && window.omsaShare.isActive());
                if (sharing) {
                    window.omsaShare.stop?.();   // hace POST /{token}/end en tu backend
                    // NO llamar a window.omsaHardBlock aquí (pasajero sigue normal)
                }
            } catch {}
        });

    }


    // Mini-card acciones
    function bindDestinoCard() {
        const btnGo = qs('#btn-go');
        const btnChange = qs('#btn-change');
        btnGo?.addEventListener('click', () => {
            clearRouteOverlays();
            window.omsaRoute?.plan?.().catch(console.error);

            // >>> Reportes: informar que ya hay destino (toma el destino desde omsaTrip)
            const d = window.omsaTrip?.getDestino?.();
            document.dispatchEvent(new CustomEvent('omsa:destination:set', { detail: { dest: d } }));

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


window.OMSA_FORCE_WA = true;
// ============================================================================
// LIVE SHARE — link con token + WhatsApp + publicación/seguimiento opcional
// Configura (opcional) una base para publicar/leer posiciones:
//   <script>window.OMSA_LIVE_BASE="/api/public/live";</script>
//   POST   ${BASE}/{token}        body: {lat,lng,t}
//   GET    ${BASE}/{token}/last   -> {lat,lng,t}
// ============================================================================
// ============================================================================
// LIVE SHARE v2 — duración + detener + HUD + WhatsApp (sheet) + POLLING viewer
// ============================================================================
// ============================================================================
// LIVE SHARE v2 — duración + detener + HUD + WhatsApp + POLYLINE compartida
//  - Incluye en el link el trayecto actual (param r= encoded polyline)
//  - El viewer lo dibuja como una sola línea
// ============================================================================
(function setupLiveShare(){
    const cfg = {
        // Valor por defecto seguro (si no lo defines en HTML): /api/public/live
        base: (document.body?.dataset?.liveBase || window.OMSA_LIVE_BASE || "/api/public/live").trim()
    };

    // estado: activo, token, hasta, timer, HUD, marker del viewer, destino/modo y polyline codificado
    const st = {
        active:false, token:null, until:null, timer:null, hud:null,
        viewerMarker:null, dest:null, mode:"DRIVING", routeEnc:null
    };

    // ========= helpers polylines (encode/decode) =========
    // Light encoder/decoder del formato "Encoded Polyline Algorithm Format"
    function encodePath(path){
        let lastLat=0,lastLng=0,out='';
        for (const p of path){
        const lat = Math.round(p.lat*1e5), lng = Math.round(p.lng*1e5);
        let dLat = lat-lastLat, dLng = lng-lastLng;
        [dLat,dLng].forEach(v=>{
            v = v<0 ? ~(v<<1) : v<<1;
            while(v>=0x20){ out+=String.fromCharCode((0x20|(v&0x1f))+63); v>>=5; }
            out+=String.fromCharCode(v+63);
        });
        lastLat=lat; lastLng=lng;
        }
        return out;
    }
    function decodePath(str){
        let index=0,lat=0,lng=0,path=[];
        while(index<str.length){
        let b,shift=0,result=0;
        do{ b=str.charCodeAt(index++)-63; result|=(b&0x1f)<<shift; shift+=5; }while(b>=0x20);
        const dlat=((result&1)?~(result>>1):(result>>1));
        shift=0; result=0;
        do{ b=str.charCodeAt(index++)-63; result|=(b&0x1f)<<shift; shift+=5; }while(b>=0x20);
        const dlng=((result&1)?~(result>>1):(result>>1));
        lat+=dlat; lng+=dlng;
        path.push({lat:lat/1e5, lng:lng/1e5});
        }
        return path;
    }
    // tomar cada N puntos para que la URL no explote
    function samplePath(path, maxPts=400){
        if (!path || path.length<=maxPts) return path||[];
        const step = Math.ceil(path.length/maxPts);
        const out=[]; for(let i=0;i<path.length;i+=step) out.push(path[i]);
        // asegura último punto
        if (out[out.length-1]!==path[path.length-1]) out.push(path[path.length-1]);
        return out;
    }

    // ========= estado básico =========
    function genToken(){ return (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase(); }
    function ensureToken(){ if(!st.token) st.token = genToken(); return st.token; }

    function setDestination(lat, lng){ if (typeof lat==="number"&&typeof lng==="number") st.dest={lat,lng}; }
    // nuevo: nombre legible del destino para ponerlo en el link
    function setDestinationName(name){ st.destName = (name || "").toString().slice(0,120); }

    function setMode(mode){
        const m=String(mode||"").toUpperCase();
        if (["DRIVING","WALKING","TRANSIT","BICYCLING"].includes(m)) st.mode=m;
    }


    // Intenta capturar el polyline actual de tu app automáticamente
    function tryCaptureRouteEnc(){
        if (st.routeEnc) return st.routeEnc;

        // 1) Si expusiste un polyline global
        if (window._omsaRoutePolyline && typeof window._omsaRoutePolyline.getPath==="function"){
        const arr = window._omsaRoutePolyline.getPath().getArray().map(ll=>({lat:ll.lat(),lng:ll.lng()}));
        st.routeEnc = encodePath(samplePath(arr));
        return st.routeEnc;
        }
        // 2) Si expusiste arrays de puntos (p.ej. window._omsaRoutePath = [{lat,lng},...])
        if (Array.isArray(window._omsaRoutePath) && window._omsaRoutePath.length){
        st.routeEnc = encodePath(samplePath(window._omsaRoutePath));
        return st.routeEnc;
        }
        // 3) Si expusiste varias secciones (las unimos)
        if (Array.isArray(window._omsaRoutePaths) && window._omsaRoutePaths.length){
        const flat = [];
        window._omsaRoutePaths.forEach(seg=>{
            if (Array.isArray(seg)) seg.forEach(p=>flat.push(p));
        });
        if (flat.length){ st.routeEnc = encodePath(samplePath(flat)); return st.routeEnc; }
        }
        return null;
    }

    // Usa tu origen público si lo defines (evita 127.0.0.1 en links)
    function viewerURL(){
        const origin = (window.OMSA_PUBLIC_ORIGIN || location.origin);
        const u = new URL(location.pathname, origin);
        u.searchParams.set("follow", ensureToken());

        // destino (si lo tienes)
        if (st.dest) u.searchParams.set("d", `${st.dest.lat.toFixed(6)},${st.dest.lng.toFixed(6)}`);
        // nombre del destino (opcional, legible)
        if (st.destName) u.searchParams.set("dn", st.destName);
        // modo (opcional)
        if (st.mode && st.mode!=="DRIVING") u.searchParams.set("m", st.mode);
        // trayecto codificado
        const enc = tryCaptureRouteEnc();
        if (enc) u.searchParams.set("r", enc);

        return u.toString();
    }
    

    function fmtMinsLeft(){
        if (!st.until) return "sin límite";
        const ms = Math.max(0, st.until - Date.now());
        const m  = Math.round(ms/60000);
        return m <= 1 ? "1 min" : `${m} min`;
    }
    function showHUD(show){
        if (show && !st.hud) {
        const hud = document.createElement('div');
        hud.id = "omsa-stop-share";
        hud.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:99999;background:#111;color:#fff;padding:8px 10px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.25);display:flex;gap:8px;align-items:center;font-size:12px";
        hud.innerHTML = `<span id="omsa-share-left">Compartiendo (${fmtMinsLeft()})</span>
            <button id="omsa-stop-btn" style="background:#fff;color:#111;border:none;border-radius:8px;padding:6px 8px;cursor:pointer">Detener</button>`;
        document.body.appendChild(hud);
        hud.querySelector('#omsa-stop-btn').addEventListener('click', stopShare);
        st.hud = hud;
        }
        if (!show && st.hud) { st.hud.remove(); st.hud=null; }
        if (show && st.hud) {
        const span = st.hud.querySelector('#omsa-share-left');
        if (span) span.textContent = `Compartiendo (${fmtMinsLeft()})`;
        }
    }
    function scheduleAutoStop(){
        clearTimeout(st.timer);
        if (!st.until) return; // sin límite
        const ms = st.until - Date.now();
        if (ms <= 0) { stopShare(); return; }
        st.timer = setTimeout(stopShare, ms);
    }
    async function stopShare(){
        st.active=false; st.until=null; clearTimeout(st.timer); showHUD(false);
        try {
        if (cfg.base && st.token) {
            const url = `${cfg.base.replace(/\/$/,'')}/${st.token}/end`;
            await fetch(url, { method:'POST' }).catch(()=>{});
        }
        } catch {}
        try { const btn = document.querySelector('#omsa-share-btn'); if (btn) btn.textContent = 'Compartir viaje'; } catch {}
    }

        // === Bloqueador duro reutilizable (sin botones, no descartable) ===
    window.omsaHardBlock = function(msg){
        try { document.getElementById('omsa-viewer-wait')?.remove(); } catch {}
        try {
            document.documentElement.style.overflow = 'hidden';
            document.body.style.overflow = 'hidden';
        } catch {}

        const overlay = document.createElement('div');
        overlay.id = 'omsa-hard-block';
        overlay.setAttribute('aria-modal','true');
        overlay.setAttribute('role','dialog');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = `
            <div tabindex="-1" style="background:#fff;max-width:480px;width:92%;border-radius:12px;padding:20px 18px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.25);user-select:none">
                <div style="font-weight:800;font-size:18px;margin-bottom:8px">Ubicación cerrada</div>
                <div style="font-size:14px;color:#444">
                    ${msg || 'Has detenido el compartir de tu ubicación.'}
                </div>
            </div>`;
        document.body.appendChild(overlay);

        try { overlay.querySelector('[tabindex="-1"]')?.focus({ preventScroll:true }); } catch {}

        function trap(e){ try { e.stopPropagation(); e.preventDefault(); } catch{} }
        ['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchmove','touchend','keydown','keyup','wheel','contextmenu','dragstart']
            .forEach(ev => document.addEventListener(ev, trap, true));
    };

    // Publicar cada actualización (si está activo y no caducó)
    document.addEventListener("omsa:livepos", (e) => {
        if (!st.active) return;
        if (st.until && Date.now() >= st.until) { stopShare(); return; }
        const d = e?.detail; if (!d || !cfg.base) return;
        const url = `${cfg.base.replace(/\/$/,'')}/${st.token}`;
        const body = JSON.stringify({ lat:d.lat, lng:d.lng, t: Date.now() });
        try {
        if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], {type:'application/json'}));
        else fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body }).catch(()=>{});
        } catch {}
    });

    // === COMPARTIR (con duración) ===
    async function promptShare(){
        const choose = window._omsaShareSheet?.openDuration;
        const mins = choose ? await choose() : (confirm("¿Compartir por 30 min?\n\nAceptar: Sí\nCancelar: No") ? 30 : null);
        if (mins === null) return;
        ensureToken();

        const url  = viewerURL();
        const text = "Sigue mi viaje OMSA en tiempo real:";

        st.until = (mins && mins>0) ? (Date.now() + mins*60000) : null; // 0 = sin límite
        st.active = true;
        scheduleAutoStop(); showHUD(true);

        if (navigator.share && !window.OMSA_FORCE_WA) {
        try { await navigator.share({ title:"Compartir viaje", text, url }); return; } catch {}
        }
        const sheet = window._omsaShareSheet?.open;
        const choice = sheet ? await sheet() : (confirm("¿Compar...\nAceptar: WhatsApp\nCancelar: Copiar enlace") ? 'wa' : 'copy');
        if (choice==='wa'){ window.OMSA_WA.open(text, url); return; }
        if (choice==='copy'){
            try { await navigator.clipboard.writeText(url); alert("¡Link copiado!\n\n"+url); }
            catch { prompt("Copia el enlace:", url); }
            return;
        }
    }
    function isActive(){ return !!st.active; }

    // Exponer API pública
    window.omsaShare = {
        promptShare, isActive, stop: stopShare,
        setDestination, setDestinationName, setMode,
        setRoute(route){ // route = google.maps.Polyline o array [{lat,lng},...]
        try{
            let arr=null;
            if (route && typeof route.getPath==="function"){
            arr = route.getPath().getArray().map(ll=>({lat:ll.lat(),lng:ll.lng()}));
            } else if (Array.isArray(route)) {
            arr = route.map(p=>({lat:+p.lat, lng:+p.lng})).filter(p=>!isNaN(p.lat)&&!isNaN(p.lng));
            }
            if (arr && arr.length){ st.routeEnc = encodePath(samplePath(arr)); }
        }catch{}
        }
    };

    // === VIEWER (POLLING) — dibuja la ruta compartida y sigue la posición ===
    (function bootViewer(){
        const token = new URLSearchParams(location.search).get("follow");
        if (!token) return;
        if (!cfg.base) { console.info("[OMSA] Viewer sin backend/BaaS: no habrá movimiento en vivo."); return; }

        // ⚠️ URL para leer la última posición (FALTABA)
        const urlLast = `${cfg.base.replace(/\/$/,'')}/${encodeURIComponent(token)}/last`;

        // Marcar modo viewer (para CSS, si hiciera falta)
        document.documentElement.classList.add("omsa-viewer");

        // Ocultar SIEMPRE cualquier botón "Compartir viaje" en modo viewer
        (function hideShareButtonForViewer() {
            function killShareButtons() {
                // elimina por selectores conocidos
                document.querySelectorAll("#omsa-share-btn,#shareTripBtn,[data-share-trip],.btn-share-trip").forEach(el => el.remove());
                // y por texto de fallback
                Array.from(document.querySelectorAll("button, a, .btn")).forEach(el => {
                    const t = (el.textContent || "").trim().toLowerCase();
                    if (t.startsWith("compartir viaje")) el.remove();
                });
            }

            // 1) quita los que ya existan
            killShareButtons();

            // 2) observa TODO el DOM durante la sesión y remueve cualquier reaparición
            const mo = new MutationObserver(() => killShareButtons());
            mo.observe(document.documentElement, { childList: true, subtree: true });

            // 3) defensa extra: si alguien ejecuta el disparador, que no haga nada
            try { window.omsaTriggerShare = async () => false; } catch {}
        })();


        const rParam  = new URLSearchParams(location.search).get("r");
        const dParam  = new URLSearchParams(location.search).get("d");
        const dnParam = new URLSearchParams(location.search).get("dn"); // nombre legible

        // ==== ventana de gracia y overlays ====
        const POLL_MS = 1500;                 // intervalo del polling
        const GIVEUP_AFTER_MS = 10000;        // 70 s de espera antes de bloquear por falta de datos
        let giveUpAt = Date.now() + GIVEUP_AFTER_MS;
        window.__viewerBlocked = false;

        function blockViewer(msg) {
            if (window.__viewerBlocked) return;
            window.__viewerBlocked = true;

            // si hay overlay de "esperando ubicación", quítalo
            try { document.getElementById('omsa-viewer-wait')?.remove(); } catch {}

            // limpiar la URL (opcional, evita re-entrar al viewer si recargan)
            try {
                const u = new URL(location.href);
                ['follow','r','d','dn','da','m'].forEach(k => u.searchParams.delete(k));
                history.replaceState({}, '', u.toString());
            } catch {}

            // bloquear scroll del documento
            try { document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden'; } catch {}

            // overlay a pantalla completa, sin botones
            const overlay = document.createElement('div');
            overlay.id = 'omsa-viewer-block';
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('role', 'dialog');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647;display:flex;align-items:center;justify-content:center';
            overlay.innerHTML = `
                <div tabindex="-1" style="background:#fff;max-width:480px;width:92%;border-radius:12px;padding:20px 18px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.25);user-select:none">
                    <div style="font-weight:800;font-size:18px;margin-bottom:8px">Link no disponible</div>
                    <div style="font-size:14px;color:#444">
                        ${msg || 'La ubicación en tiempo real fue cerrada o el enlace ya no está activo.'}
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            // llevar el foco al contenedor para que Tab no navegue por detrás
            try { overlay.querySelector('[tabindex="-1"]')?.focus({ preventScroll:true }); } catch {}

            // BLOQUEO DURO: anular toda interacción detrás del overlay
            function trap(e){
                try { e.stopPropagation(); e.preventDefault(); } catch(_){}
            }
            const evts = ['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchmove','touchend','keydown','keyup','wheel','contextmenu'];
            evts.forEach(ev => document.addEventListener(ev, trap, true));

            // impedir que Escape cierre algo por detrás
            document.addEventListener('keydown', function onEsc(e){
                if (e.key === 'Escape') { trap(e); }
            }, true);

            // impedir drags/selecciones detrás
            document.addEventListener('dragstart', trap, true);
        }


        let waitingShown = false;
        function showWaiting(){
            if (waitingShown || window.__viewerBlocked) return;
            waitingShown = true;
            const el = document.createElement('div');
            el.id = 'omsa-viewer-wait';
            el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99998;background:rgba(255,255,255,.85)';
            el.innerHTML = '<div style="background:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.15);font-size:14px">Esperando ubicación del pasajero…</div>';
            document.body.appendChild(el);
        }
        function hideWaiting(){ document.getElementById('omsa-viewer-wait')?.remove(); waitingShown=false; }

        // =======================================================

        let first = true, viewerMarker = null, routePolyline = null;
        let followDest = null, plannedOnce = false;

        // helper: decide si la respuesta indica fin/expiración
        // Solo bloquear si es claramente revocado/expirado (NO por 404 inicial)
        function isEndedResponse(r, data) {
            if (!r) return false; // error de red: no bloquees
            if (r.status === 403 || r.status === 410) return true; // prohibido / expirado explícito
            if (r.ok && (data && (data.ended === true || data.status === 'ended' || data.active === false))) return true;
            return false; // 404 o sin lat/lng NO se consideran “terminado”
        }

        // Si el link trae ?d=lat,lng, fijamos y mostramos en la mini-card
        if (dParam) {
            const m = dParam.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (m) {
                followDest = { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
                try { window.omsaTrip?.setDestino?.(followDest); } catch {}
                // Pintar mini-card
                // Pintar mini-card
                const card   = document.getElementById("destino-card");
                const titleEl = document.getElementById("destino-title");
                const addrEl  = document.getElementById("destino-addr");
                if (card && titleEl && addrEl) {
                    card.hidden = false;
                    // Título fijo "Destino"
                    titleEl.textContent = (dnParam && dnParam.trim()) ? dnParam.trim() : "";
                    // En la línea inferior mostramos SOLO el nombre del lugar
                    addrEl.textContent  = (dnParam && dnParam.trim()) ? dnParam.trim() : "";
                }

            }
        }


        function _getMap(){ return (typeof window._gmapSafe === 'function') ? window._gmapSafe() : window.map; }

        // Espera a que el mapa esté listo y luego dibuja la línea compartida
        async function waitForMap() {
            return new Promise((resolve) => {
                let n = 0;
                const t = setInterval(() => {
                const ok = !!(window.google && google.maps && _getMap());
                if (ok || n > 200) { clearInterval(t); resolve(ok); }
                n++;
                }, 100);
            });
            }

            function drawSharedRoute() {
            if (!rParam) return;
            try {
                const pts = decodePath(rParam);
                if (!pts || !pts.length) return;
                    routePolyline = new google.maps.Polyline({
                    path: pts,
                    geodesic: true,
                    map: _getMap(),
                    strokeColor: "#1e8e3e",
                    strokeOpacity: 1,
                    strokeWeight: 4,
                    zIndex: 1200
                });

                // 👉 Si no hay destino, renderiza un "recorrido" simple con el trazado compartido
                try {
                    if (!followDest && Array.isArray(pts) && pts.length >= 2) {
                        const first = pts[0], last = pts[pts.length - 1];
                        const out = {
                            ok: true,
                            total_sec: null,
                            legs: [{
                                type: "BUS",
                                routeCode: null,         // no lo sabemos aquí
                                from: { lat: first.lat, lng: first.lng, name: "Inicio del trayecto" },
                                to:   { lat: last.lat,  lng: last.lng,  name: "Fin del trayecto" }
                            }]
                        };
                        // Reutiliza tu renderer estándar
                        document.dispatchEvent(new CustomEvent("omsa:route-ready", { detail: out }));
                    }
                } catch {}

                const bounds = new google.maps.LatLngBounds();
                pts.forEach(p => bounds.extend(p));
                const gmap = _getMap();
                if (gmap) gmap.fitBounds(bounds);
            } catch {}
        }

        waitForMap().then((ok) => { if (ok) drawSharedRoute(); });

        // Validación inicial: si ya está vencido, bloquea y no arranques el polling
        (async () => {
            try {
                const r = await fetch(urlLast, { cache:'no-store' });
                let data = null; try { data = await r.json(); } catch {}
                if (isEndedResponse(r, data)) {
                    blockViewer('El enlace para ver este viaje ya no está activo.');
                    return;
                }
            } catch {}
            showWaiting();
            // si está OK, empieza a sondear normalmente
            poll();
        })();


        async function poll(){
            if (window.__viewerBlocked) return;

            try {
                const r = await fetch(urlLast, { cache:'no-store' });

                // Revocado/expirado explícito -> bloquear de inmediato
                if (r.status === 403 || r.status === 410) {
                    blockViewer('El enlace ya no está activo.');
                    return;
                }

                // 404 = aún no hay posición publicada (tu backend trabaja así)
                if (r.status === 404) {
                    showWaiting();
                    if (Date.now() >= giveUpAt) {
                        blockViewer('No se ha recibido la ubicación del pasajero. El enlace ha expirado.');
                        return;
                    }
                    setTimeout(poll, POLL_MS);
                    return;
                }

                // Intentar leer JSON cuando no es 404/403/410
                let data = null;
                try { data = await r.json(); } catch {}

                // Si el backend marca final explícito en el JSON
                if (data && (data.ended === true || data.status === 'ended' || data.active === false)) {
                    blockViewer('El enlace fue detenido por el pasajero.');
                    return;
                }

                // Sin lat/lng válidos -> tratar como "sin datos"
                if (!data || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
                    showWaiting();
                    if (Date.now() >= giveUpAt) {
                        blockViewer('No se ha recibido la ubicación del pasajero. El enlace podría haber expirado o aún no se ha iniciado el envío.');
                        return;
                    }
                    setTimeout(poll, POLL_MS);
                    return;
                }

                // Hay datos válidos
                hideWaiting();

                const { lat, lng } = data;
                const gmap = _getMap();
                if (!viewerMarker) {
                    viewerMarker = new google.maps.Marker({
                        map: gmap,
                        position: { lat, lng },
                        zIndex: 2500,
                        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7,
                                strokeColor:"#fff", strokeWeight:3, fillColor:"#1a73e8", fillOpacity:1 }
                    });
                } else {
                    viewerMarker.setPosition({ lat, lng });
                }

                try {
                    document.dispatchEvent(new CustomEvent("omsa:livepos", { detail: { lat, lng } }));
                } catch {}

                // Planificar solo una vez cuando ya tenemos destino y primera posición
                if (!plannedOnce && followDest && typeof window.omsaRoute?.plan === "function") {
                    try {
                        await window.omsaRoute.plan({});
                        plannedOnce = true;
                    } catch (e) { /* noop */ }
                }

                if (first && gmap) { gmap.panTo({ lat, lng }); first=false; }

                // Al recibir datos, extender la ventana de gracia para pérdidas temporales
                giveUpAt = Date.now() + GIVEUP_AFTER_MS;

            } catch {
                // error transitorio de red: seguimos intentando
            }

            if (!window.__viewerBlocked) setTimeout(poll, POLL_MS);
        }



    })();

})();


// ============================================================================
// Disparador robusto de "Compartir" (usa el módulo si está disponible;
// si no, aplica fallback: Web Share API → WhatsApp → Copiar enlace).
// ============================================================================
(function bootTriggerShare() {

    // Candado a nivel disparador para evitar dobles llamadas por el mismo clic
    let __omsaCallingShare = false;

    // Exponer un disparador único para el botón (sin fallback que abra WhatsApp)
    window.omsaTriggerShare = async function () {
        if (__omsaCallingShare) return true;
        __omsaCallingShare = true;

        try {
            if (window.omsaShare && typeof window.omsaShare.promptShare === "function") {
                await window.omsaShare.promptShare();
                return (typeof window.omsaShare.isActive === "function")
                    ? !!window.omsaShare.isActive()
                    : true;
            }
            alert("No se pudo iniciar el compartir. Vuelve a intentarlo cuando el mapa termine de cargar.");
            return false;
        } finally {
            setTimeout(() => { __omsaCallingShare = false; }, 800);
        }
    };
})();


// ============================================================================
// UI: hoja de compartir OMSA (modal ligero) — share + duración
// ============================================================================
(function installOmsaShareSheet(){
    if (window._omsaShareSheet) return; // evitar duplicados

    const css = `
        .omsa-share-overlay{position:fixed;inset:0;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center;z-index:99999;animation:omsaFade .12s ease-out}
        .omsa-share-sheet{background:#ffffff;color:#111;max-width:380px;width:92vw;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:16px 14px}
        @media (prefers-color-scheme: dark){ .omsa-share-sheet{background:#1b1b1b;color:#eaeaea;box-shadow:0 10px 30px rgba(0,0,0,.45)} }
        .omsa-share-title{font-weight:700;font-size:16px;margin-bottom:6px}
        .omsa-share-desc{opacity:.7;font-size:13px;margin-bottom:12px}
        .omsa-share-btns{display:flex;flex-direction:column;gap:10px}
        .omsa-btn{border:1px solid #e5e7eb;background:#f9fafb;color:#111;border-radius:10px;padding:10px 12px;font-size:14px;cursor:pointer;transition:filter .15s ease, transform .02s ease}
        @media (prefers-color-scheme: dark){ .omsa-btn{background:#262626;border-color:#3a3a3a;color:#eaeaea} }
        .omsa-btn:hover{filter:brightness(.97)} .omsa-btn:active{transform:scale(.99)}
        .omsa-btn.wa{background:#25D366;border-color:#25D366;color:#0b0b0b;font-weight:800}
        .omsa-btn.copy{background:#fff;color:#000} .omsa-btn.cancel{background:#fff;color:#444}
        @keyframes omsaFade{from{opacity:0}to{opacity:1}}
        `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Sheet de opciones (WhatsApp / Copiar / Cancelar)
    function open() {
        return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'omsa-share-overlay';
        overlay.innerHTML = `
            <div class="omsa-share-sheet" role="dialog" aria-modal="true" aria-label="Compartir viaje">
            <div class="omsa-share-title">Compartir viaje</div>
            <div class="omsa-share-desc">Elige una opción</div>
            <div class="omsa-share-btns">
                <button class="omsa-btn wa">Enviar por WhatsApp</button>
                <button class="omsa-btn copy">Guardar enlace</button>
                <button class="omsa-btn cancel">Cancelar</button>
            </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = (v)=>{ overlay.remove(); resolve(v); };
        overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close('cancel'); });
        overlay.querySelector('.wa').addEventListener('click',   ()=> close('wa'));
        overlay.querySelector('.copy').addEventListener('click', ()=> close('copy'));
        overlay.querySelector('.cancel').addEventListener('click',()=> close('cancel'));
        overlay.querySelector('.wa').focus();
        document.addEventListener('keydown', function onKey(e){ if(e.key==='Escape'){ document.removeEventListener('keydown', onKey); close('cancel'); }});
        });
    }

    // Sheet de DURACIÓN (15/30/60/120 min / Siempre / Cancelar)
    function openDuration() {
        return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'omsa-share-overlay';
        overlay.innerHTML = `
            <div class="omsa-share-sheet" role="dialog" aria-modal="true" aria-label="Tiempo de compartir">
            <div class="omsa-share-title">Tiempo para compartir</div>
            <div class="omsa-share-desc">¿Por cuánto tiempo quieres compartir tu ubicación?</div>
            <div class="omsa-share-btns">
                <button class="omsa-btn d15">15 minutos</button>
                <button class="omsa-btn d30">30 minutos</button>
                <button class="omsa-btn d60">1 hora</button>
                <button class="omsa-btn d120">2 horas</button>
                <button class="omsa-btn d0">Siempre (hasta detener)</button>
                <button class="omsa-btn cancel">Cancelar</button>
            </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = (v)=>{ overlay.remove(); resolve(v); };
        overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(null); });
        overlay.querySelector('.d15').addEventListener('click', ()=> close(15));
        overlay.querySelector('.d30').addEventListener('click', ()=> close(30));
        overlay.querySelector('.d60').addEventListener('click', ()=> close(60));
        overlay.querySelector('.d120').addEventListener('click',()=> close(120));
        overlay.querySelector('.d0').addEventListener('click',  ()=> close(0)); // 0 = sin límite
        overlay.querySelector('.cancel').addEventListener('click',()=> close(null));
        overlay.querySelector('.d30').focus();
        document.addEventListener('keydown', function onKey(e){ if(e.key==='Escape'){ document.removeEventListener('keydown', onKey); close(null); }});
        });
    }

    window._omsaShareSheet = { open, openDuration };
})();


// ============================================================================
// UI: Modal de calificación de ruta (5 estrellas, opcional)
// ============================================================================
(function ensureRatingModal() {
    if (document.getElementById("omsa-rate-modal")) return;

    const el = document.createElement("div");
    el.id = "omsa-rate-modal";
    el.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9999;";
    el.innerHTML = `
        <div style="background:#fff;max-width:420px;width:92%;border-radius:12px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.25);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <h3 style="margin:0;font-size:18px;">Califica tu experiencia</h3>
                <button id="omsa-rate-close" aria-label="Cerrar" style="border:0;background:transparent;font-size:20px;cursor:pointer;">×</button>
            </div>
            <p style="margin:8px 0 12px 0;font-size:14px;color:#444;">
                ¿Qué tal estuvo tu viaje en la ruta <span id="omsa-rate-route-label"></span>?
            </p>
            <div id="omsa-rate-stars" style="font-size:28px;cursor:pointer;user-select:none;line-height:1.2;" aria-label="Elegir de 1 a 5 estrellas">
                <span data-v="1">☆</span><span data-v="2">☆</span><span data-v="3">☆</span><span data-v="4">☆</span><span data-v="5">☆</span>
            </div>
            <textarea id="omsa-rate-comment" placeholder="Comentario (opcional)" maxlength="200" style="margin-top:12px;width:100%;height:70px;padding:8px;border-radius:8px;border:1px solid #ddd;"></textarea>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
                <button id="omsa-rate-skip" style="padding:8px 12px;border-radius:8px;border:1px solid #ddd;background:#f7f7f7;cursor:pointer;">Ahora no</button>
                <button id="omsa-rate-send" style="padding:8px 14px;border-radius:8px;border:0;background:#16a34a;color:#fff;cursor:pointer;">Enviar</button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
})();


// ============================================================================
// Calificación de ruta: lógica de estrellas + POST + “llegando a última parada”
// ============================================================================
(function setupRouteRating(){
    // --- estado interno ---
    let ratingValue = 5;
    let targetStop = null;              // {lat,lng} de la última parada del último BUS
    let targetRouteCode = null;         // código de la ruta a calificar
    let armed = false;                  // watcher armado
    const GEO_THRESHOLD_M = 40;         // distancia para disparar el modal
    const COOLDOWN_H = 6;               // evita mostrar de nuevo por X horas/route

    // --- helpers UI modal ---
    function setStars(v){
        ratingValue = v;
        document.querySelectorAll("#omsa-rate-stars span").forEach(s=>{
            const val = +s.getAttribute("data-v");
            s.textContent = val <= v ? "★" : "☆";
        });
    }
    function showModal(label){
        const modal = document.getElementById("omsa-rate-modal");
        if (!modal) return;
        document.getElementById("omsa-rate-route-label").textContent = label || (targetRouteCode || "");
        setStars(5);
        document.getElementById("omsa-rate-comment").value = "";
        modal.style.display = "flex";
    }
    function hideModal(){
        const modal = document.getElementById("omsa-rate-modal");
        if (modal) modal.style.display = "none";
    }

    // --- binding de UI (una sola vez) ---
    (function bindOnce(){
        const modal = document.getElementById("omsa-rate-modal");
        if (!modal) return;

        modal.addEventListener("click", (e) => {
            if (e.target.id === "omsa-rate-modal") hideModal();
        });
        document.getElementById("omsa-rate-close")?.addEventListener("click", hideModal);
        document.getElementById("omsa-rate-skip")?.addEventListener("click", hideModal);
        document.getElementById("omsa-rate-send")?.addEventListener("click", sendRating);

        document.querySelectorAll("#omsa-rate-stars span").forEach(s=>{
            s.addEventListener("click", ()=> setStars(+s.getAttribute("data-v")));
        });
    })();

    // --- utilidades ---
    function distMeters(a,b){
        const R=6371000, toRad=d=>d*Math.PI/180;
        const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
        const s1=Math.sin(dLat/2)**2;
        const s2=Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
        return 2*R*Math.asin(Math.sqrt(s1+s2));
    }
    function csrf(){
        const m=document.cookie.match(/csrftoken=([^;]+)/);
        return m ? m[1] : "";
    }
    function routeCodesFromLegs(){
        try{
            const legs = (window.omsaRoute?.getLegs?.() || []);
            return legs.filter(l=>l && l.type==='BUS' && l.routeCode).map(l=>l.routeCode);
        }catch{ return []; }
    }
    function cooldownKey(route){ return "omsa_rated_" + (route || "unknown"); }

    // --- envío ---
    async function sendRating(){
        try{
            // payload: mismo esquema que reportes (para que backend resuelva la ruta)
            const payload = {
                puntuacion: ratingValue,
                comentario: (document.getElementById("omsa-rate-comment").value || "").trim().slice(0,200),
                route_code_current: targetRouteCode || null,
                route_codes: routeCodesFromLegs(),
                // opcionales si los manejas:
                follow_id: (window.follow_id || null)
            };

            const res = await fetch("/api/calificaciones/", {
                method: "POST",
                headers: { "Content-Type":"application/json", "X-CSRFToken": csrf() },
                body: JSON.stringify(payload),
                credentials: "same-origin"
            });

            let data = {};
            try { data = await res.json(); } catch {}
            if (res.ok && data && data.ok) {
                // marca cooldown
                if (targetRouteCode) localStorage.setItem(cooldownKey(targetRouteCode), String(Date.now()));
                hideModal();
            } else {
                alert(data?.error || "No se pudo guardar la calificación.");
                // puedes mostrar un toast con data.error si quieres
                hideModal();
            }
        } catch(e){
            hideModal();
        }
    }

    // --- armar watcher cuando hay ruta lista ---
    // --- armar watcher cuando hay ruta lista ---
    function armWatcherFor(out){
        // 1) buscar el ÚLTIMO tramo BUS del itinerario
        const legs = (out && out.legs) || [];
        const lastBus = [...legs].reverse().find(l =>
            l && l.type === "BUS" &&
            l.to && typeof l.to.lat === "number" && typeof l.to.lng === "number"
        );
        if (!lastBus) {
            targetStop = null; targetRouteCode = null; armed = false;
            return;
        }
        targetStop = { lat: lastBus.to.lat, lng: lastBus.to.lng };
        targetRouteCode = String(lastBus.routeCode || "");
        armed = true;
    }


    // --- escuchar la ruta lista (evento que tú ya emites) ---
    // --- escuchar la ruta lista (evento que tú ya emites) ---
    document.addEventListener("omsa:route-ready", (e)=>{
        try { armWatcherFor(e.detail); } catch {}
    });


    // --- limpiar cuando limpias el mapa/destino ---
    document.addEventListener("omsa:destination:cleared", ()=>{
        targetStop = null; targetRouteCode = null; armed = false;
    });

    // --- cada update de ubicación: si está armado, medir y disparar ---
    document.addEventListener("omsa:livepos", (e)=>{
        if (!armed || !targetStop) return;
        const you = e?.detail;
        if (!you || typeof you.lat!=="number" || typeof you.lng!=="number") return;

        const d = distMeters({lat:you.lat,lng:you.lng}, targetStop);
        if (d > GEO_THRESHOLD_M) return;

        // ¿ya se calificó esta ruta recientemente?
        if (targetRouteCode) {
            const ts = Number(localStorage.getItem(cooldownKey(targetRouteCode)) || 0);
            if (ts && (Date.now() - ts) < COOLDOWN_H*60*60*1000) {
                armed = false; // no lo muestres otra vez
                return;
            }
        }

        // mostrar y desarmar
        showModal(targetRouteCode);
        armed = false;
    });
})();

// ============================================================================
// Estilos de estrellas del modal (solo color de las estrellas)
// ============================================================================
(function installRatingStyles(){
    if (document.getElementById("omsa-rate-style")) return;
    const css = `
    #omsa-rate-stars { background: transparent !important; }
    #omsa-rate-stars span { color: var(--star-empty, #facc15); /* gris claro */ transition: transform .08s ease; }
    #omsa-rate-stars span.filled { color: var(--star-filled, #facc15); /* dorado */ }
    #omsa-rate-stars span:hover { transform: scale(1.05); }
    `;
    const style = document.createElement("style");
    style.id = "omsa-rate-style";
    style.textContent = css;
    document.head.appendChild(style);
})();


// ============================================================
// Bottom-sheet DRAG (móvil) + ajuste por teclado virtual
// ============================================================
(function setupDraggableAside(){
    const aside   = document.querySelector('.aside');
    const grabber = document.querySelector('.aside__grabber');
    if (!aside || !grabber) return;

    // Estado
    const st = {
        startY: 0,
        startH: 0,
        lastH: null,         // recuerda la última altura “manual”
        dragging: false
    };

    // Helpers
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const vh = () => Math.max(1, window.visualViewport ? window.visualViewport.height : window.innerHeight);

    function setSheet(px) {
        // límites en PX derivados de las variables CSS
        const css = getComputedStyle(document.documentElement);
        const minVh = parseFloat(css.getPropertyValue('--sheet-h-min')) || 20;
        const maxVh = parseFloat(css.getPropertyValue('--sheet-h-max')) || 90;

        const minPx = vh() * (minVh / 100);
        const maxPx = vh() * (maxVh / 100);
        const h = clamp(px, minPx, maxPx);

        // Guardamos en VH para que FAB/leyenda (que usan var(--sheet-h)) se sincronicen
        const asVh = (h / vh()) * 100;
        document.documentElement.style.setProperty('--sheet-h', `${asVh}vh`);
        st.lastH = h;
    }

    function getSheetPx() {
        const cur = getComputedStyle(document.documentElement)
            .getPropertyValue('--sheet-h').trim();
        const num = parseFloat(cur);
        if (cur.endsWith('vh') || cur.endsWith('dvh')) return vh() * (num / 100);
        if (cur.endsWith('px')) return num;
        return vh() * 0.45; // fallback ~45vh
    }

    // Drag con Pointer Events
    function onStart(e){
        st.dragging = true;
        aside.classList.add('dragging');
        st.startY = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? 0;
        st.startH = getSheetPx();
        try { e.target.setPointerCapture?.(e.pointerId); } catch {}
    }
    function onMove(e){
        if (!st.dragging) return;
        const y = e.clientY ?? (e.touches && e.touches[0]?.clientY) ?? st.startY;
        const dy = st.startY - y;       // arrastrar hacia arriba => aumenta altura
        setSheet(st.startH + dy);
    }
    function onEnd(){
        if (!st.dragging) return;
        st.dragging = false;
        aside.classList.remove('dragging');
    }

    // Zonas que pueden iniciar el drag: el “grabber” y la barra de pestañas
    const tabsBar   = document.querySelector('.tabs'); // ajusta si tu barra tiene otra clase
    const startZones = [grabber, tabsBar].filter(Boolean);

    // Eventos de inicio (pointer/touch) en todas las zonas válidas
    startZones.forEach(el => {
        el.addEventListener('pointerdown', onStart);
        el.addEventListener('touchstart',  onStart, { passive: true });
    });

    // Seguimiento global del drag (igual que antes)
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup',   onEnd);
    window.addEventListener('touchmove',   onMove, { passive: true });
    window.addEventListener('touchend',    onEnd);

    // Doble-tap en el grabber para “toggle” entre colapsado/expandido rápido
    let lastTap = 0;
    grabber.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 300) {
            const target = st.lastH && st.lastH > vh()*0.6 ? vh()*0.28 : vh()*0.75;
            setSheet(target);
        }
        lastTap = now;
    });

    // Auto-elevar cuando aparece el teclado (inputs/textarea dentro del aside)
    document.addEventListener('focusin', (ev) => {
        const el = ev.target;
        if (aside.contains(el) &&
            (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
            setSheet(vh() * 0.78);      // ← ya lo tenías
            updateKbSafeVar();          // ← NUEVO: reserva espacio inferior
        }
    });
    document.addEventListener('focusout', (ev) => {
        if (aside.contains(ev.target)) {
            if (st.lastH) setSheet(st.lastH); // ← ya lo tenías
            clearKbSafeVar();                 // ← NUEVO: quita la reserva
        }
    });

    // Ajuste fino con visualViewport (cuando el teclado cambia el alto real)
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            const h = getSheetPx();
            const max = vh() * 0.9;
            if (h > max) setSheet(max);
            updateKbSafeVar();  // ← NUEVO: recalcula el padding seguro al cambiar el viewport
        });
    }

    // Altura inicial según tu estilo (45vh)
    setSheet(getSheetPx());

    // ================= NUEVAS FUNCIONES =================
    function updateKbSafeVar() {
        if (!window.visualViewport) return;
        const gap = Math.max(0, window.innerHeight - window.visualViewport.height);
        document.documentElement.style.setProperty('--kb-safe', (gap ? gap + 8 : 0) + 'px');
    }
    function clearKbSafeVar() {
        document.documentElement.style.setProperty('--kb-safe', '0px');
    }
    // ====================================================

})();

// --- Subtarea 1: habilitar tab "Reportes" solo si hay destino ---
(function () {
    const btnReportes = document.getElementById('tab-reportes-btn');
    const tabReportes = document.getElementById('tab-reportes');
    const formWrap = document.getElementById('reportes-form-wrap');
    const placeholder = document.getElementById('reportes-placeholder');

    if (!btnReportes || !tabReportes) return;

    function showReportsTab() {
        btnReportes.style.display = '';
        tabReportes.style.display = '';
        if (placeholder) placeholder.style.display = 'none';
        if (formWrap) formWrap.style.display = '';
        btnReportes.setAttribute('aria-selected', 'false');
    }

    function hideReportsTab() {
        btnReportes.style.display = 'none';
        tabReportes.style.display = 'none';
        if (placeholder) placeholder.style.display = '';
        if (formWrap) formWrap.style.display = 'none';
        btnReportes.setAttribute('aria-selected', 'false');
    }

    // Exponer por si quieres llamarlo manualmente
    window._reportesUI = { enable: showReportsTab, disable: hideReportsTab };

    // Escuchar eventos globales (los disparamos en el punto siguiente)
    document.addEventListener('omsa:destination:set', showReportsTab);
    document.addEventListener('omsa:destination:cleared', hideReportsTab);
    document.addEventListener('omsa:route-error', hideReportsTab);

    // Estado inicial
    hideReportsTab();
})();

// --- Subtarea 2: Lógica del formulario de Reportes (40 chars + envío POST) ---
(function setupReportesForm(){
    const sel  = document.getElementById('reporte-tipo');
    const txt  = document.getElementById('reporte-texto');
    const cnt  = document.getElementById('reporte-cont');
    const btn  = document.getElementById('reporte-enviar');
    const msg  = document.getElementById('reporte-msg');
    const wrap = document.getElementById('reportes-form-wrap');
    const ph   = document.getElementById('reportes-placeholder');

    if (!sel || !txt || !cnt || !btn) return;

    const MAX_DESC = 40;

    function charCount(s){ return (s || '').length; }
    function updateCounter(){ cnt.textContent = String(Math.min(MAX_DESC, charCount(txt.value))); }
    function updateButton(){
        const okTipo = !!sel.value;
        const okTxt  = charCount(txt.value) > 0;
        btn.disabled = !(okTipo && okTxt);
    }
    function clearForm(){
        sel.value = '';
        txt.value = '';
        updateCounter();
        updateButton();
        // (no borres el mensaje aquí)
    }
    function getCSRFToken(){
        const m = document.cookie.match(/csrftoken=([^;]+)/);
        return m ? m[1] : '';
    }

    // Eventos de entrada
    txt.addEventListener('input', () => { updateCounter(); updateButton(); });
    sel.addEventListener('change', updateButton);

    // Mostrar/ocultar según destino
    document.addEventListener('omsa:destination:set', () => {
        clearForm();
        if (ph)   ph.style.display   = 'none';
        if (wrap) wrap.style.display = '';
    });
    document.addEventListener('omsa:destination:cleared', () => {
        clearForm();
        if (ph)   ph.style.display   = '';
        if (wrap) wrap.style.display = 'none';
    });

  // Click ENVIAR
    btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (btn.disabled) return;

        // 1) Detectar legs del itinerario (expuestas por renderItinerary)
        const legs = (window.omsaRoute?.getLegs?.() || []);
        const currentBusLeg =
        legs.find(l => l?.type === 'BUS' && (l?.active || l?.isActive)) ||
        legs.find(l => l?.type === 'BUS');

        const payload = {
        tipo: sel.value,
        descripcion: (txt.value || '').trim().slice(0, 40),
        route_codes: legs.filter(l => l?.type === 'BUS' && l?.routeCode).map(l => l.routeCode),
        route_code_current: currentBusLeg?.routeCode || null,
        user_latlng: (window._omsaLastPos ? { lat: window._omsaLastPos.lat, lng: window._omsaLastPos.lng } : null)
        };


        // 2) UI: estado enviando
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = 'Enviando…';
        if (msg) msg.textContent = '';

        // 3) POST
        try {
                const res = await fetch('/api/reportes/', {
                method: 'POST',
                headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            });
            
        let data = {};
        let errText = '';
        try {
            data = await res.json();
        } catch {
            try {errText = await res.text(); } catch {errText = '';}
        }

        //const data = await res.json().catch(() => ({}));

        if (!res.ok || !data?.ok) {
            const err = data?.error || `Error ${res.status}`;
            if (msg) msg.textContent = err;
        } else {
            // Limpiar form
            clearForm();
            cnt.textContent = '0';
            btn.disabled = true;
            if (msg) msg.textContent = 'Reporte enviado ✅';
        }
        } catch (err) {
        if (msg) msg.textContent = 'Error de red.';
        console.error(err);
        } finally {
        btn.textContent = oldText;
        updateButton();
        }
    });

    // Inicializar
    updateCounter();
    updateButton();
})();








