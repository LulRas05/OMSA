// ------------------------------
// Estado global del panel admin
// ------------------------------
window.omsaAdmin = {
    modo: 'idle',           // 'idle' | 'agregar'
    map: null,              // instancia de google.maps.Map
    markerPreview: null,    // marcador temporal al hacer clic
    ultimoClick: null,      // { lat, lng } del último clic
    inline: null,           // contenedor del inline de Paradas
    formActivoIndex: null,  // índice del form vacío/activo
    inlinePrefix: null,     // p. ej. "parada_set" o el prefijo real del formset
    _addingLock: false,     // lock anti doble-inserción
    _scrollToMapTID: null,  // id del timeout de “scroll al mapa” tras Enter
    _wiredOnce: false,       // evita re-resets del toolbar
    _pendingNewForm: false,   
    _lastTargetIdx: null
};

// Utilidades DOM
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// ------------------------------
// Callback requerido por Google Maps
// Debe llamarse EXACTAMENTE: omsaAdminInitMap
// ------------------------------
window.omsaAdminInitMap = function omsaAdminInitMap() {
    // 1) Contenedor del mapa
    const mapDiv = document.getElementById('map-admin');
    if (!mapDiv) {
        console.warn('[OMSA Admin] No se encontró #map-admin.');
        return;
    }

    // 2) Crear mapa (Santo Domingo por defecto)
    const center = { lat: 18.4861, lng: -69.9312 };
    const map = new google.maps.Map(mapDiv, {
        center,
        zoom: 12,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true
    });
    window.omsaAdmin.map = map;

    // 2.1) Directions (línea por calles)
    if (window.omsaAdmin.initDirections) {
        window.omsaAdmin.initDirections(map);
    }

    // 2.2) Enganchar inline y dibujar desde el principio
    const inline = findParadasInline();
    window.omsaAdmin.inline = inline;
    if (inline) {
        bindInlineDelegatedEvents(inline);
        // makeInlineSortable(inline);

        if (window.omsaAdmin.updateDirectionsDebounced) {
            window.omsaAdmin.updateDirectionsDebounced();
        }
    }

    // 2.3) Reintentos suaves por si el DOM tarda
    if (window.omsaAdmin.kickInitialDraw) {
        window.omsaAdmin.kickInitialDraw();
    }

    // 3) Marcador de vista previa (clic)
    window.omsaAdmin.markerPreview = new google.maps.Marker({
        map,
        draggable: false
    });

    // 4) Toolbar + estado visual (SIN forzar a idle si ya cambió)
    wireToolbar();
    setTimeout(() => wireToolbar(true), 300); // reintento sin resetear modo

    // 5) Click en el mapa → volcar lat/lon al form activo
    map.addListener('click', (e) => {
        if (window.omsaAdmin.modo !== 'agregar') {
            setAyuda('Activa el modo "Agregar paradas" para usar el mapa.');
            return;
        }

        const lat = e.latLng.lat();
        const lng = e.latLng.lng();
        window.omsaAdmin.ultimoClick = { lat, lng };

        // Preview en el mapa
        window.omsaAdmin.markerPreview.setPosition({ lat, lng });
        window.omsaAdmin.markerPreview.setVisible(true);
        setCoordsText(lat, lng);

        // === Elegir la fila ACTIVA ===
        const inlineBox = window.omsaAdmin.inline || findParadasInline();
        const forms = getParadaForms(inlineBox);
        if (!forms.length) {
            setAyuda('No encontré formularios de Paradas.');
            return;
        }

        let idx = window.omsaAdmin.formActivoIndex;
                // 1) si hay inline recién creado por Enter/botón → usa SIEMPRE el último
        if (window.omsaAdmin._pendingNewForm && forms.length) {
            idx = forms.length - 1;
            window.omsaAdmin._pendingNewForm = false;
        }
        // 2) si el usuario seleccionó explícitamente una fila, respétala
        else if (window.omsaAdmin.userSelected && idx != null && forms[idx]) {
            // se mantiene idx
        }
        // 3) si ya habíamos escrito con el mapa en una fila, continúa ahí
        else if (window.omsaAdmin._lastTargetIdx != null && forms[window.omsaAdmin._lastTargetIdx]) {
            idx = window.omsaAdmin._lastTargetIdx;
        }
        // 4) fallback: primer incompleto o última fila si todas completas
        else if (idx == null || !forms[idx]) {
            idx = findFormActivoIndex(forms);
        }

        window.omsaAdmin.formActivoIndex = idx;
        window.omsaAdmin._lastTargetIdx = idx; // ← recuerda el último destino de mapa
        highlightActiveForm(forms, idx);

        // === Escribir SIEMPRE en la fila activa (sobrescribe si ya tenía) ===
        const f = forms[idx];
        const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
        const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);
        if (!latEl || !lonEl) {
            setAyuda('No encontré inputs de lat/lon.');
            return;
        }

        latEl.value = lat.toFixed(6);
        lonEl.value = lng.toFixed(6);
        latEl.dispatchEvent(new Event('input', { bubbles: true }));
        lonEl.dispatchEvent(new Event('input', { bubbles: true }));
        latEl.dispatchEvent(new Event('change', { bubbles: true }));
        lonEl.dispatchEvent(new Event('change', { bubbles: true }));
        setAyuda('Coordenadas actualizadas en la parada seleccionada.');

        updateBtnAgregarOtra(forms, idx);

        // Redibujar línea/puntos
        if (window.omsaAdmin.updateDirectionsDebounced) {
            window.omsaAdmin.updateDirectionsDebounced();
        }
        /*
        try {
            if (window.omsaAdmin._scrollToMapTID) {
                clearTimeout(window.omsaAdmin._scrollToMapTID);
                window.omsaAdmin._scrollToMapTID = null;
            }
        } catch (_) {}
         */

         // Enfocar nombre y centrar fila activa inmediatamente
        scrollActiveFormIntoView();
        focusNombreForm(forms, idx);

    });

    // Mensaje inicial (no cambia modo)
    setAyuda('Activa el modo y haz clic en el mapa.');
};

// ------------------------------
// Barra de herramientas y estado
// ------------------------------
function wireToolbar(preserveMode = false) {
    const toolbar = document.getElementById('od-toolbar');
    if (!toolbar) {
        console.warn('[OMSA Admin] No se encontró #od-toolbar.');
        return;
    }

    // Evita que el segundo cableado te devuelva a idle si ya activaste
    const modoActual = window.omsaAdmin.modo;

    // limpiar listeners previos clonando el nodo
    toolbar.replaceWith(toolbar.cloneNode(true));
    const tb = document.getElementById('od-toolbar');

    // Delegación robusta: sube hasta el botón real (aunque hagas clic en un <span>)
    tb.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest('#btn-modo-agregar, #btn-agregar-otra, #btn-limpiar-ultimo');
        if (!btn) return;
        const id = btn.id;

        if (id === 'btn-modo-agregar') {
            if (window.omsaAdmin.modo === 'idle') {
                setModo('agregar');
                setAyuda('Haz clic en el mapa para fijar lat/lon.');
                const inline = findParadasInline();
                window.omsaAdmin.inline = inline;

                if (inline) {
                    const forms = getParadaForms(inline);
                    const idx = findFormActivoIndex(forms);
                    window.omsaAdmin.formActivoIndex = idx;
                    highlightActiveForm(forms, idx);
                    updateBtnAgregarOtra(forms, idx);
                    bindInlineDelegatedEvents(inline);
                    scrollActiveFormIntoView();
                    focusNombreForm(forms, idx);
                } else {
                    setAyuda('No encontré el inline "Paradas".');
                }

                const b = tb.querySelector('#btn-limpiar-ultimo'); if (b) b.disabled = false;
            } else {
                setModo('idle');
                setAyuda('Modo desactivado.');
                const bOtra = tb.querySelector('#btn-agregar-otra');
                const bLimpiar = tb.querySelector('#btn-limpiar-ultimo');
                if (bOtra) bOtra.disabled = true;
                if (bLimpiar) bLimpiar.disabled = true;
                if (window.omsaAdmin.markerPreview) window.omsaAdmin.markerPreview.setVisible(false);
            }
            // Sincroniza texto del botón según modo nuevo
            _syncToolbarButtons();
        }

        if (id === 'btn-agregar-otra') {
            addAnotherParada();
            _syncToolbarButtons();
        }

        if (id === 'btn-limpiar-ultimo') {
            limpiarCoordsFormActivo();
            if (window.omsaAdmin.markerPreview) window.omsaAdmin.markerPreview.setVisible(false);
            window.omsaAdmin.ultimoClick = null;
            setCoordsText(null, null);
            setAyuda('Coordenadas limpiadas.');
            _syncToolbarButtons();
        }
    });

    // No fuerces a idle si ya estabas en agregar o si preservamos
    if (!preserveMode && !window.omsaAdmin._wiredOnce) {
        setModo('idle');
        window.omsaAdmin._wiredOnce = true;
    } else {
        // respeta el modo existente
        setModo(modoActual);
    }

    _syncToolbarButtons();
}

function _syncToolbarButtons() {
    const tb = document.getElementById('od-toolbar');
    if (!tb) return;

    // Texto del botón de modo
    const btnModo = tb.querySelector('#btn-modo-agregar');
    if (btnModo) {
        btnModo.textContent = (window.omsaAdmin.modo === 'agregar') ? 'Desactivar agregar paradas' : 'Activar agregar paradas';
    }

    // Habilitar/deshabilitar según modo + validez del form activo
    const btnOtra = tb.querySelector('#btn-agregar-otra');
    const btnLimpiar = tb.querySelector('#btn-limpiar-ultimo');

    const inline = window.omsaAdmin.inline || findParadasInline();
    const forms = getParadaForms(inline);
    const idx = window.omsaAdmin.formActivoIndex;

    const puedeAgregar = (window.omsaAdmin.modo === 'agregar') && canAgregarActual(forms, idx);

    if (btnOtra) btnOtra.disabled = !puedeAgregar;
    if (btnLimpiar) btnLimpiar.disabled = (window.omsaAdmin.modo !== 'agregar');
}

function setModo(nuevo) {
    window.omsaAdmin.modo = nuevo;

    const estadoBox = document.getElementById('estado-admin');
    const btnModo = document.getElementById('btn-modo-agregar');

    if (estadoBox && typeof estadoBox.querySelector === 'function') {
        const span = estadoBox.querySelector('[data-role="modo"]');
        if (span) span.textContent = String(nuevo);
    }

    if (btnModo) {
        btnModo.textContent = (nuevo === 'agregar') ? 'Desactivar agregar paradas' : 'Activar agregar paradas';
    }
}

function setCoordsText(lat, lng) {
    const estadoBox = document.getElementById('estado-admin');
    if (!estadoBox || typeof estadoBox.querySelector !== 'function') return;
    const span = estadoBox.querySelector('[data-role="coords"]');
    if (!span) return;
    span.textContent = (lat == null || lng == null) ? '—' : `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

// Fallback: si el callback no corrió pero Maps ya está disponible
document.addEventListener('DOMContentLoaded', () => {
    const ok = !!(window.google && window.google.maps);
    if (ok && $('#map-admin') && !window.omsaAdmin.map) {
        try { window.omsaAdminInitMap(); } catch (e) { console.error(e); }
    }
    // Además, por si el mapa ya existía pero aún no dibujó:
    if (window.omsaAdmin && window.omsaAdmin.kickInitialDraw) {
        window.omsaAdmin.kickInitialDraw();
    }
});

function setAyuda(texto) { const p = $('#ayuda-admin'); if (p) p.textContent = String(texto); }

// ------------------------------
// Inline helpers
// ------------------------------
function findParadasInline() {
    const mgmts = document.querySelectorAll('input[name$="-TOTAL_FORMS"]');
    for (const mgmt of mgmts) {
        const name = mgmt.getAttribute('name');
        const prefix = name.replace(/-TOTAL_FORMS$/, '');
        const group = mgmt.closest(`#${prefix}-group`) || mgmt.closest('.inline-group') || mgmt.closest('.card, .module, fieldset') || null;
        if (!group) continue;
        const has = group.querySelector(
            `input[name^="${prefix}-"][name$="-lat"], input[name^="${prefix}-"][name$="-latitud"], input[name^="${prefix}-"][name$="-lon"], input[name^="${prefix}-"][name$="-longitud"]`
        );
        if (has) { window.omsaAdmin.inlinePrefix = prefix; return group; }
    }
    const byId2 = $('#parada_set-group'); if (byId2) { window.omsaAdmin.inlinePrefix = 'parada_set'; return byId2; }
    const candidates = $all('.inline-group, .card, .module, fieldset');
    for (const el of candidates) {
        if (el.querySelector('input[name^="parada_set-"]')) { window.omsaAdmin.inlinePrefix = 'parada_set'; return el; }
    }
    window.omsaAdmin.inlinePrefix = null; return null;
}

function getParadaForms(inlineBox) {
    if (!inlineBox) return [];
    const prefix = window.omsaAdmin.inlinePrefix || 'parada_set';
    const rows = inlineBox.querySelectorAll('tr.form-row, div.inline-related');
    return Array.from(rows).filter(row => {
        if (row.classList.contains('empty-form')) return false;
        if (row.querySelector('input[name*="__prefix__"]')) return false;
        return row.querySelector(
            `input[name^="${prefix}-"][name$="-nombre"], input[name^="${prefix}-"][name$="-lat"], input[name^="${prefix}-"][name$="-latitud"], input[name^="${prefix}-"][name$="-lon"], input[name^="${prefix}-"][name$="-longitud"]`
        );
    });
}

function pickField(formEl, candidates) {
    for (const sel of candidates) { const el = formEl.querySelector(sel); if (el) return el; }
    return null;
}

function findFormActivoIndex(forms) {
    for (let i = 0; i < forms.length; i++) {
        const f = forms[i];
        const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
        const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);
        const latV = latEl ? latEl.value.trim() : '';
        const lonV = lonEl ? lonEl.value.trim() : '';
        if (!latV || !lonV) return i;
    }
    return forms.length ? forms.length - 1 : null;
}

function highlightActiveForm(forms, idx) {
    const inlineBox = window.omsaAdmin.inline || findParadasInline();

    if (inlineBox) inlineBox.querySelectorAll('.omsa-form-activo').forEach(el => el.classList.remove('omsa-form-activo'));
    forms.forEach((f, i) => f.classList.toggle('omsa-form-activo', i === idx));
}

function updateBtnAgregarOtra(forms, idx) {
    const btn = $('#btn-agregar-otra'); if (!btn) return;
    const habilitado = (window.omsaAdmin.modo === 'agregar') && canAgregarActual(forms, idx);
    btn.disabled = !habilitado;
    btn.title = btn.disabled ? 'Completa Nombre, Lat y Lon' : 'Agregar otra parada';
}

function bindInlineDelegatedEvents(inlineBox) {
    if (!inlineBox || inlineBox.dataset.omsaDelegated === '1') return;

    const onAny = (ev) => {
        const row = ev.target && ev.target.closest('tr.form-row, div.inline-related'); if (!row) return;
        const forms = getParadaForms(inlineBox);
        const idx = forms.indexOf(row); if (idx === -1) return;
        window.omsaAdmin.formActivoIndex = idx;
        window.omsaAdmin.userSelected = true;              // ⬅ bandera: usuario eligió
        highlightActiveForm(forms, idx);
        updateBtnAgregarOtra(forms, idx);
        _syncToolbarButtons();
        if (window.omsaAdmin.updateDirectionsDebounced) window.omsaAdmin.updateDirectionsDebounced();
    };

    const onKeyDown = (ev) => {
        const t = ev.target; if (!t || t.tagName !== 'INPUT') return;
        const n = (t.getAttribute('name') || '');
        const isNombre = n.endsWith('-nombre') || /-nombre"]?$/.test(n);
        if (!isNombre) return;
        if (ev.key === 'Enter') {
            const forms = getParadaForms(inlineBox);
            const row = t.closest('tr.form-row, div.inline-related');
            const idx = forms.indexOf(row);
            if (canAgregarActual(forms, idx) && window.omsaAdmin.modo === 'agregar') {
                ev.preventDefault(); ev.stopPropagation();
                addAnotherParada({ scrollToForm: false });

                window.omsaAdmin._pendingNewForm = true;
                window.omsaAdmin.userSelected = false;
                window.omsaAdmin.formActivoIndex = null;

                try { t.blur(); } catch (_){}

                scrollMapIntoView();  // sin tiempos ni colas
            }
        }
    };

    // NUEVO: seleccionar fila con un simple clic en cualquier parte de la fila
    const onClickRow = (ev) => {
        const row = ev.target && ev.target.closest('tr.form-row, div.inline-related'); if (!row) return;
        const forms = getParadaForms(inlineBox);
        const idx = forms.indexOf(row); if (idx === -1) return;
        window.omsaAdmin.formActivoIndex = idx;
        window.omsaAdmin.userSelected = true;              // ⬅ bandera
        highlightActiveForm(forms, idx);
        updateBtnAgregarOtra(forms, idx);
        _syncToolbarButtons();
    };

    inlineBox.addEventListener('input', onAny, true);
    inlineBox.addEventListener('change', onAny, true);
    inlineBox.addEventListener('keydown', onKeyDown, true);
    inlineBox.addEventListener('click', onClickRow, true); // ⬅ NUEVO
    inlineBox.dataset.omsaDelegated = '1';
}

function limpiarCoordsFormActivo() {
    const inlineBox = window.omsaAdmin.inline || findParadasInline();
    const forms = getParadaForms(inlineBox);
    const idx = window.omsaAdmin.formActivoIndex;
    if (idx == null || !forms[idx]) return;

    const f = forms[idx];
    const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
    const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);

    if (latEl) {
        latEl.value = '';
        latEl.dispatchEvent(new Event('input', { bubbles: true }));
        latEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (lonEl) {
        lonEl.value = '';
        lonEl.dispatchEvent(new Event('input', { bubbles: true }));
        lonEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateBtnAgregarOtra(forms, idx);
    _syncToolbarButtons();
    if (window.omsaAdmin.updateDirectionsDebounced) window.omsaAdmin.updateDirectionsDebounced();
}

function findAddAnotherButton(inlineBox) {
    if (!inlineBox) return null;
    let btn = inlineBox.querySelector('.add-row a, .add-row button, a.add-row, button.add-row');
    if (btn) return btn;
    const candidates = inlineBox.querySelectorAll('a, button');
    btn = Array.from(candidates).find(el => /agregar|añadir|add another|add item|add row/i.test((el.textContent || '').trim()));
    return btn || null;
}

function addAnotherParada(opts) {
    const options = Object.assign({ scrollToForm: true }, opts || {});
    const inline = window.omsaAdmin.inline || findParadasInline();
    if (!inline) { setAyuda('No encontré el inline "Paradas".'); return; }
    if (window.omsaAdmin._addingLock) return;
    window.omsaAdmin._addingLock = true;

    const formsB = getParadaForms(inline);
    const idxB = window.omsaAdmin.formActivoIndex;
    if (idxB != null && formsB[idxB]) {
        const f = formsB[idxB];
        const nombreEl = pickField(f, ["input[name$='-nombre']"]);
        const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
        const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);
        const ok = nombreEl && latEl && lonEl && nombreEl.value.trim() && latEl.value.trim() && lonEl.value.trim();
        if (!ok) { setAyuda('Completa Nombre, Lat y Lon antes de agregar.'); window.omsaAdmin._addingLock = false; return; }
    }

    const addBtn = findAddAnotherButton(inline);
    if (!addBtn) { setAyuda('No encontré el botón "Agregar" del inline.'); window.omsaAdmin._addingLock = false; return; }

    window.omsaAdmin._pendingNewForm = true;

    addBtn.click();

    setTimeout(() => {
        const forms = getParadaForms(inline);
        const newIdx = forms.length ? forms.length - 1 : null;
        window.omsaAdmin.formActivoIndex = newIdx;
        highlightActiveForm(forms, newIdx);
        updateBtnAgregarOtra(forms, newIdx);
        _syncToolbarButtons();
        if (options.scrollToForm) { scrollActiveFormIntoView(); focusNombreForm(forms, newIdx); }
        setAyuda('Nuevo formulario listo.');
        if (window.omsaAdmin.updateDirectionsDebounced) window.omsaAdmin.updateDirectionsDebounced();
        window.omsaAdmin._addingLock = false;
    }, 120);
}

function canAgregarActual(forms, idx) {
    if (idx == null || !forms[idx]) return false;
    const f = forms[idx];
    const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
    const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);
    const nombreEl = pickField(f, ["input[name$='-nombre']"]);
    return !!(latEl && lonEl && nombreEl && latEl.value.trim() && lonEl.value.trim() && nombreEl.value.trim());
}

function scrollActiveFormIntoView() {
    const inline = window.omsaAdmin.inline || findParadasInline(); if (!inline) return;
    const forms = getParadaForms(inline);
    const idx = window.omsaAdmin.formActivoIndex; if (idx == null || !forms[idx]) return;
    const row = forms[idx];
    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
}

function focusNombreForm(forms, idx) {
    if (idx == null || !forms[idx]) return;
    const nombreEl = pickField(forms[idx], ["input[name$='-nombre']"]);
    if (nombreEl && !nombreEl.value.trim()) { nombreEl.focus(); try { const len = nombreEl.value.length; nombreEl.setSelectionRange(len, len); } catch (e) {} }
}

function scrollMapIntoView() {
    const el = document.getElementById('map-admin');
    if (!el) return;

    // Quita el foco activo para evitar que el navegador vuelva a subir/bajar por focus
    try { if (document.activeElement) document.activeElement.blur(); } catch(_) {}

    // Scroll absoluto a la posición del mapa (funciona igual si el contenedor
    // scrollable es <body> o un contenedor del admin)
    const rect = el.getBoundingClientRect();
    const y = rect.top + (window.pageYOffset || document.documentElement.scrollTop) - 80; // un margen
    window.scrollTo({ top: y, behavior: 'smooth' });
}



// NUEVO: agenda el scroll al mapa y evita dobles ejecuciones
/*
function queueScrollToMap(delay = 160) {
    try { if (window.omsaAdmin._scrollToMapTID) clearTimeout(window.omsaAdmin._scrollToMapTID); } catch (_) {}
    window.omsaAdmin._scrollToMapTID = setTimeout(() => {
        scrollMapIntoView();
        window.omsaAdmin._scrollToMapTID = null;
    }, delay);
}
    */

/* =========================================================
   DIRECTIONS EN EL ADMIN (línea por calles entre paradas)
   + Punticos numerados de cada parada
   ========================================================= */
(function () {
    const MAX_WAYPOINTS = 23; // límite seguro por request

    window.omsaAdmin = window.omsaAdmin || {};
    window.omsaAdmin.directionsService = null;
    window.omsaAdmin.directionsRenderers = [];
    window.omsaAdmin._routeDebounceTID = null;
    window.omsaAdmin._prevPtsHash = '';
    window.omsaAdmin.stopMarkers = window.omsaAdmin.stopMarkers || [];

    function _clearStopMarkers() {
        for (const m of window.omsaAdmin.stopMarkers) { try { m.setMap(null); } catch (_) {} }
        window.omsaAdmin.stopMarkers = [];
    }

    function _updateStopMarkers(pts) {
        const map = window.omsaAdmin.map; if (!map) return;
        if (!pts || !pts.length) { _clearStopMarkers(); return; }
        if (window.omsaAdmin.stopMarkers.length !== pts.length) _clearStopMarkers();

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            let mk = window.omsaAdmin.stopMarkers[i];
            if (!mk) {
                mk = new google.maps.Marker({
                    map,
                    position: p,
                    clickable: true,
                    draggable: false,
                    zIndex: 20,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 7,
                        fillColor: '#0d6efd',
                        fillOpacity: 1,
                        strokeColor: '#ffffff',
                        strokeWeight: 2
                    },
                    label: {
                        text: String(i + 1),
                        color: '#ffffff',
                        fontSize: '10px',
                        fontWeight: '700'
                    }
                });

                mk.addListener('click', () => {
                        const inline = window.omsaAdmin.inline || findParadasInline();
                        const forms = getParadaForms(inline);
                        if (!forms.length) return;
                        const idx = Math.min(i, forms.length - 1);
                        window.omsaAdmin.formActivoIndex = idx;
                        window.omsaAdmin.userSelected = true;              // bandera
                        highlightActiveForm(forms, idx);
                        updateBtnAgregarOtra(forms, idx);
                        _syncToolbarButtons();
                        scrollActiveFormIntoView();
                    });

                window.omsaAdmin.stopMarkers[i] = mk;
            } else {
                mk.setPosition(p);
                mk.setLabel({ text: String(i + 1), color: '#ffffff', fontSize: '10px', fontWeight: '700' });
            }
        }

        // elimina marcadores sobrantes si se redujeron paradas
        for (let j = pts.length; j < window.omsaAdmin.stopMarkers.length; j++) {
            const extra = window.omsaAdmin.stopMarkers[j];
            try { extra.setMap(null); } catch (_) {}
        }
        window.omsaAdmin.stopMarkers.length = pts.length;
    }

    window.omsaAdmin.initDirections = function (map) {
        if (!map || !(window.google && google.maps)) return;
        if (!window.omsaAdmin.directionsService) {
            window.omsaAdmin.directionsService = new google.maps.DirectionsService();
        }
        _clearAllRenderers();
        _wireDirectionsObservers();
        window.omsaAdmin.updateDirectionsDebounced();
    };

    window.omsaAdmin.updateDirectionsDebounced = function () {
        clearTimeout(window.omsaAdmin._routeDebounceTID);
        window.omsaAdmin._routeDebounceTID = setTimeout(_updateDirections, 400);
    };

    function _wireDirectionsObservers() {
        const inline = document.querySelector('#parada_set-group') || document;
        inline.addEventListener('change', (ev) => {
            const n = (ev.target && ev.target.name) || '';
            if (/-lat$|latitud$|-lon$|longitud$|-order$|_order/.test(n)) {
                window.omsaAdmin.updateDirectionsDebounced();
            }
        });
        const mo = new MutationObserver(() => window.omsaAdmin.updateDirectionsDebounced());
        mo.observe(inline, { childList: true, subtree: true });
    }

    function _getParadasEnOrden() {
        const cont = document.querySelector('#parada_set-group') || document;
        const forms = getParadaForms(cont);
        const pts = [];
        for (const f of forms) {
            const latEl = pickField(f, ["input[name$='-lat']", "input[name$='-latitud']"]);
            const lonEl = pickField(f, ["input[name$='-lon']", "input[name$='-longitud']"]);
            if (!latEl || !lonEl) continue;
            const lat = parseFloat(latEl.value);
            const lng = parseFloat(lonEl.value);
            if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng });
        }
        return pts;
    }

    function _updateDirections() {
        const pts = _getParadasEnOrden();

        // punticos siempre
        _updateStopMarkers(pts);

        // si no hay 2+, limpiar línea y salir
        if (!pts || pts.length < 2) { _clearAllRenderers(); return; }

        // evitar redibujar si no cambió nada
        const hash = pts.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
        if (hash === window.omsaAdmin._prevPtsHash) return;
        window.omsaAdmin._prevPtsHash = hash;

        _clearAllRenderers();

        // “Chunking” por límite de waypoints
        let i = 0;
        while (i < pts.length - 1) {
            const origin = pts[i];
            let end = Math.min(i + 1 + MAX_WAYPOINTS, pts.length - 1);
            const destination = pts[end];
            const waypoints = pts.slice(i + 1, end).map(p => ({ location: new google.maps.LatLng(p.lat, p.lng), stopover: false }));

            const req = {
                origin: new google.maps.LatLng(origin.lat, origin.lng),
                destination: new google.maps.LatLng(destination.lat, destination.lng),
                waypoints,
                travelMode: google.maps.TravelMode.DRIVING,
                optimizeWaypoints: false,
                provideRouteAlternatives: false,
                region: "DO"
            };

            ((reqCopy, iCopy, endCopy) => {
                window.omsaAdmin.directionsService.route(reqCopy, (result, status) => {
                    if (status === google.maps.DirectionsStatus.OK && result && result.routes && result.routes.length) {
                        const renderer = new google.maps.DirectionsRenderer({
                            map: window.omsaAdmin.map,
                            suppressMarkers: true,
                            preserveViewport: true,
                            polylineOptions: { strokeWeight: 5, strokeOpacity: 0.9, strokeColor: '#17a517' }
                        });
                        renderer.setDirections(result);
                        window.omsaAdmin.directionsRenderers.push(renderer);
                    } else {
                        // Fallback recto si falla Directions
                        const path = [pts[iCopy]].concat(pts.slice(iCopy + 1, endCopy)).concat([pts[endCopy]]).map(p => ({ lat: p.lat, lng: p.lng }));
                        const pl = new google.maps.Polyline({ path, strokeWeight: 3, strokeOpacity: 0.6, strokeColor: '#17a517' });
                        pl.setMap(window.omsaAdmin.map);
                        window.omsaAdmin.directionsRenderers.push({ setMap: () => pl.setMap(null) });
                    }
                });
            })(req, i, end);

            i = end;
        }
    }

    function _clearAllRenderers() {
        if (Array.isArray(window.omsaAdmin.directionsRenderers)) {
            for (const r of window.omsaAdmin.directionsRenderers) { try { r.setMap(null); } catch (_) {} }
        }
        window.omsaAdmin.directionsRenderers = [];
    }

    // Arranque inicial: dibuja paradas/línea al abrir una ruta ya existente (exportada)
    window.omsaAdmin.kickInitialDraw = function () {
        let tries = 0;
        const MAX_TRIES = 10;     // ~3s si interval=300ms
        const INTERVAL_MS = 300;

        const tick = () => {
            tries++;
            const map = window.omsaAdmin && window.omsaAdmin.map;
            if (!map) { if (tries < MAX_TRIES) return setTimeout(tick, INTERVAL_MS); return; }

            const inline = window.omsaAdmin.inline || findParadasInline();
            if (inline && inline.dataset && inline.dataset.omsaDelegated !== '1') {
                bindInlineDelegatedEvents(inline);
                // makeInlineSortable(inline);
            }

            const pts = _getParadasEnOrden();
            _updateStopMarkers(pts || []);

            if (Array.isArray(pts) && pts.length >= 2) {
                window.omsaAdmin.updateDirectionsDebounced();
                return;
            }
            if (tries < MAX_TRIES) setTimeout(tick, INTERVAL_MS);
        };

        tick();
    };
})();


