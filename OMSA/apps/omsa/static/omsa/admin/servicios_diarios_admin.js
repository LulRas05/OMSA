(function () {
    document.addEventListener("DOMContentLoaded", function () {
        var fechaInput = document.getElementById("id_fecha");
        var turnoSelect = document.getElementById("id_turno");
        if (!fechaInput || !turnoSelect) return;

        var prefixMap = { LV: "Lunes a Viernes", SA: "Sábado", DO: "Domingo" };

        function parseDateString(value) {
        if (!value) return null;
        value = (value + "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            var d1 = new Date(value + "T00:00:00");
            return isNaN(d1) ? null : d1;
        }
        var m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (m) {
            var dd = m[1], mm = m[2], yyyy = m[3];
            var d2 = new Date(yyyy + "-" + mm + "-" + dd + "T00:00:00");
            return isNaN(d2) ? null : d2;
        }
        return null;
        }

        function formatForField(d) {
        // Respeta el formato actual del input
        var raw = fechaInput.value;
        if (raw && raw.indexOf("/") > -1) {
            var dd = String(d.getDate()).padStart(2, "0");
            var mm = String(d.getMonth() + 1).padStart(2, "0");
            var yyyy = d.getFullYear();
            return dd + "/" + mm + "/" + yyyy;
        }
        // ISO
        return d.toISOString().slice(0, 10);
        }

        function dayGroupFromDate(d) {
        var dow = d.getDay(); // 0=Dom,1=Lun,...,6=Sáb
        if (dow >= 1 && dow <= 5) return "LV";
        if (dow === 6) return "SA";
        return "DO";
        }

        function timeToMinutes(hhmmss) {
        var parts = (hhmmss || "").split(":");
        var hh = parseInt(parts[0] || "0", 10);
        var mm = parseInt(parts[1] || "0", 10);
        return hh * 60 + mm;
        }

        function extractEndMinutes(optText) {
        // Intenta leer: "(06:00:00–14:30:00)" o "(06:00–14:30)"
        var m = optText.match(/\((\d{2}:\d{2}(?::\d{2})?)\s*[–-]\s*(\d{2}:\d{2}(?::\d{2})?)\)/);
        if (!m) return null;
        return timeToMinutes(m[2]);
        }

        function disableTurno() {
        turnoSelect.disabled = true;
        var ph = turnoSelect.querySelector("option[value='']");
        if (!ph) {
            ph = document.createElement("option");
            ph.value = "";
            turnoSelect.insertBefore(ph, turnoSelect.firstChild);
        }
        ph.textContent = "Selecciona la fecha primero…";
        turnoSelect.value = "";
        for (var i = 0; i < turnoSelect.options.length; i++) {
            turnoSelect.options[i].hidden = false;
            turnoSelect.options[i].disabled = false;
        }
        }

        function enableAndFilterTurno(d) {
        var dg = dayGroupFromDate(d);
        var isToday = (new Date().toDateString() === d.toDateString());
        var now = new Date();
        var nowMin = now.getHours() * 60 + now.getMinutes();

        turnoSelect.disabled = false;
        var ph = turnoSelect.querySelector("option[value='']");
        if (!ph) {
            ph = document.createElement("option");
            ph.value = "";
            turnoSelect.insertBefore(ph, turnoSelect.firstChild);
        }
        ph.textContent = "Selecciona un turno…";

        var prefix = prefixMap[dg] || "";
        for (var i = 0; i < turnoSelect.options.length; i++) {
            var opt = turnoSelect.options[i];
            if (!opt.value) { opt.hidden = false; opt.disabled = false; continue; }

            var text = (opt.text || "").trim();
            var visible = text.indexOf(prefix) === 0;

            // Si es HOY, además oculta turnos cuyo fin ya pasó
            if (visible && isToday) {
            var endMin = extractEndMinutes(text);
            if (endMin !== null && endMin <= nowMin) visible = false;
            }

            opt.hidden = !visible;
            opt.disabled = !visible;
            if (!visible && opt.selected) turnoSelect.value = "";
        }
        }

        function applyFilter() {
        var d = parseDateString(fechaInput.value);
        if (!d) { disableTurno(); return; }

        // No permitir fechas en el pasado (UI)
        var today = new Date();
        today.setHours(0,0,0,0);
        if (d < today) {
            // fuerza a hoy
            fechaInput.value = formatForField(today);
            d = today;
        }

        enableAndFilterTurno(d);
        }

        // Inicial
        applyFilter();

        ["change","input","blur","keyup"].forEach(function (ev) {
        fechaInput.addEventListener(ev, applyFilter);
        });

        document.querySelectorAll(".datetimeshortcuts a").forEach(function (a) {
        a.addEventListener("click", function () { setTimeout(applyFilter, 30); });
        });

        // Asegurar que no quede disabled al enviar (por si acaso)
        document.addEventListener("submit", function () {
        if (turnoSelect) turnoSelect.disabled = false;
        }, true);

        // Fallback: detectar cambios silenciosos
        var lastVal = fechaInput.value;
        setInterval(function () {
        if (fechaInput.value !== lastVal) {
            lastVal = fechaInput.value;
            applyFilter();
        }
        }, 300);
    });
})();
