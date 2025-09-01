let map;
let routeMarkers = [];
let directionsRenderers = [];

let rutasCache = [];               // cache de rutas
let rutaSeleccionada = null;
let ultimasParadas = [];           // NUEVO: paradas de la última ruta mostrada
let markerByParadaId = new Map();  // NUEVO: para ubicar rápidamente un marker por id

function normalizar(txt) {
  return (txt || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function clearRouteOverlays() {
  routeMarkers.forEach(m => m.setMap(null));
  routeMarkers = [];
  directionsRenderers.forEach(r => r.setMap(null));
  directionsRenderers = [];
  markerByParadaId.clear();               // NUEVO
  ultimasParadas = [];                    // NUEVO
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
}

// === Helpers de render de lista ===
function renderListaRutasYParadas(filtro = "", paradasEncontradas = []) {
  const ul = document.getElementById("lista-rutas");
  ul.innerHTML = "";

  const f = normalizar(filtro);

  // 1) Rutas filtradas (como antes)
  const rutas = rutasCache.filter(r => {
    const texto = `${r.codigo} ${r.nombre} ${r.origen} ${r.destino}`;
    return normalizar(texto).includes(f);
  });

  rutas.forEach(r => {
    const li = document.createElement("li");
    li.textContent = `${r.nombre} \n (${r.origen} → ${r.destino})`;
    li.style.cursor = "pointer";
    if (rutaSeleccionada === r.codigo) li.classList.add("ruta--activa");
    li.addEventListener("click", () => {
      rutaSeleccionada = r.codigo;
      renderListaRutasYParadas(filtro, paradasEncontradas);
      mostrarRuta(r.codigo);
    });
    ul.appendChild(li);
  });

  // 2) Paradas filtradas (si hay filtro y resultados)
  if (f && paradasEncontradas.length) {
    // separador simple (no cambia HTML, solo un <li>)
    const sep = document.createElement("li");
    sep.textContent = "— Paradas —";
    sep.style.margin = "8px 0";
    sep.style.opacity = "0.7";
    ul.appendChild(sep);

    paradasEncontradas.forEach(p => {
      const li = document.createElement("li");
      li.style.cursor = "pointer";
      li.textContent = `Parada: ${p.nombre} [${p.ruta_codigo}]`;
      li.addEventListener("click", async () => {
        // Dibuja la ruta de esa parada y centra en la parada
        rutaSeleccionada = p.ruta_codigo;
        renderListaRutasYParadas(filtro, paradasEncontradas);
        await mostrarRuta(p.ruta_codigo);   // dibuja ruta y markers

        // localizar marker por id de parada y centrar
        const mk = markerByParadaId.get(p.id);
        if (mk) {
          map.setCenter(mk.getPosition());
          map.setZoom(16);
          // opcional: animación o InfoWindow
          // mk.setAnimation(google.maps.Animation.BOUNCE);
        }
      });
      ul.appendChild(li);
    });
  }
}

// === Cargar rutas + enlazar buscador ===
async function cargarRutas() {
  try {
    const res = await fetch("/api/public/rutas/");
    rutasCache = await res.json();

    // render inicial sin filtro
    renderListaRutasYParadas("", []);

    // buscador (debounce)
    const search = document.getElementById("search-box");
    if (search && !search.dataset.bound) {
      let timer = null;
      search.addEventListener("input", async (e) => {
        clearTimeout(timer);
        const value = e.target.value;
        timer = setTimeout(async () => {
          // buscar paradas por nombre SOLO si hay texto
          let paradasEncontradas = [];
          const q = value.trim();
          if (q.length >= 2) {
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
  } catch (err) {
    console.error("Error cargando rutas", err);
  }
}

// === Directions por tramos (igual que tarea 2) ===
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

async function mostrarRuta(codigo) {
  try {
    const res = await fetch(`/api/public/paradas/?codigo=${encodeURIComponent(codigo)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const paradas = await res.json();

    clearRouteOverlays();
    if (!paradas.length) return;

    ultimasParadas = paradas; // NUEVO: guardamos para lookup
    const bounds = new google.maps.LatLngBounds();
    const points = paradas.map(p => ({ lat: p.lat, lng: p.lon }));

    paradas.forEach((p, idx) => {
      const pos = { lat: p.lat, lng: p.lon };
      const marker = new google.maps.Marker({
        map,
        position: pos,
        label: String(idx + 1),
        title: p.nombre
      });
      routeMarkers.push(marker);
      markerByParadaId.set(p.id, marker); // NUEVO: indexamos por id
      bounds.extend(pos);
    });

    const { DirectionsService, DirectionsRenderer, TravelMode } = await google.maps.importLibrary("routes");
    const ds = new DirectionsService();

    const segments = chunkPoints(points, 25);
    for (const seg of segments) {
      const result = await ds.route({
        origin: seg.origin,
        destination: seg.destination,
        waypoints: seg.waypoints,
        travelMode: TravelMode.DRIVING,
        optimizeWaypoints: false,
      });
      const dr = new DirectionsRenderer({
        map,
        preserveViewport: true,
        suppressMarkers: true,
      });
      dr.setDirections(result);
      directionsRenderers.push(dr);
    }

    map.fitBounds(bounds);
  } catch (err) {
    console.error("Error mostrando paradas:", err);
  }
}

window.addEventListener("DOMContentLoaded", cargarRutas);
initMap();
