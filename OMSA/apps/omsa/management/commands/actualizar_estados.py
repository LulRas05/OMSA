from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction
from apps.omsa.models import ServiciosDiarios, HistorialServicios, Chofer, Autobus

def weekday_to_day_group(d):
    if 0 <= d <= 4:
        return "LV"
    if d == 5:
        return "SA"
    return "DO"

def now_in_window(now_t, start_t, end_t):
    return start_t <= now_t < end_t

class Command(BaseCommand):
    help = "Actualiza estados en vivo y archiva servicios finalizados (mueve ServiciosDiarios -> HistorialServicios)."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Simula sin guardar.")
        parser.add_argument("--verbose", action="store_true", help="Imprime detalles.")

    @transaction.atomic
    def handle(self, *args, **opts):
        dry = opts["dry_run"]
        verbose = opts["verbose"]

        now = timezone.localtime()
        today = now.date()
        now_t = now.time()
        today_group = weekday_to_day_group(today.weekday())

        # -----------------------------------------
        # 1) ACTUALIZAR ESTADOS EN VIVO
        # -----------------------------------------
        qs_hoy = (ServiciosDiarios.objects
                    .select_related("turno", "chofer", "autobus")
                    .filter(fecha=today, turno__day_group=today_group))

        chofer_activo = set()
        bus_activo = set()

        for sd in qs_hoy:
            if now_in_window(now_t, sd.turno.inicio, sd.turno.fin):
                chofer_activo.add(sd.chofer_id)
                bus_activo.add(sd.autobus_id)

        # Choferes involucrados hoy
        choferes_ids = set(qs_hoy.values_list("chofer_id", flat=True))
        # Buses involucrados hoy
        buses_ids = set(qs_hoy.values_list("autobus_id", flat=True))

        # Choferes → asignado si activo, si no disponible
        for ch in Chofer.objects.filter(id__in=choferes_ids):
            if ch.id in chofer_activo:
                updates = {}
                if ch.estado != "asignado":
                    updates["estado"] = "asignado"
                # cache autobus_actual
                sd_act = (ServiciosDiarios.objects
                            .filter(chofer_id=ch.id, turno__inicio__lte=now_t, turno__fin__gt=now_t)
                            .order_by("turno__inicio")
                            .first())
                if sd_act and ch.autobus_actual_id != sd_act.autobus_id:
                    updates["autobus_actual"] = sd_act.autobus
                if updates and not dry:
                    Chofer.objects.filter(pk=ch.pk).update(**updates)
                if updates and verbose:
                    self.stdout.write(f"[CHOFER] {ch} -> {updates}")
            else:
                updates = {}
                if ch.estado != "disponible":
                    updates["estado"] = "disponible"
                if ch.autobus_actual_id is not None:
                    updates["autobus_actual"] = None
                if updates and not dry:
                    Chofer.objects.filter(pk=ch.pk).update(**updates)
                if updates and verbose:
                    self.stdout.write(f"[CHOFER] {ch} -> {updates}")

        # Buses → en_servicio si activo, si no disponible (salvo mantenimiento/fuera)
        for bus in Autobus.objects.filter(id__in=buses_ids):
            if bus.id in bus_activo:
                updates = {}
                if bus.estado != "en_servicio":
                    updates["estado"] = "en_servicio"
                sd_act = (ServiciosDiarios.objects
                            .filter(autobus_id=bus.id, turno__inicio__lte=now_t, turno__fin__gt=now_t)
                            .order_by("turno__inicio")
                            .first())
                if sd_act and bus.chofer_actual_id != sd_act.chofer_id:
                    updates["chofer_actual"] = sd_act.chofer
                if updates and not dry:
                    Autobus.objects.filter(pk=bus.pk).update(**updates)
                if updates and verbose:
                    self.stdout.write(f"[BUS] {bus} -> {updates}")
            else:
                updates = {}
                if bus.estado not in ("mantenimiento", "fuera_de_servicio") and bus.estado != "disponible":
                    updates["estado"] = "disponible"
                if bus.chofer_actual_id is not None:
                    updates["chofer_actual"] = None
                if updates and not dry:
                    Autobus.objects.filter(pk=bus.pk).update(**updates)
                if updates and verbose:
                    self.stdout.write(f"[BUS] {bus} -> {updates}")

        # -----------------------------------------
        # 2) ARCHIVAR SERVICIOS FINALIZADOS
        #   - Fecha < hoy -> siempre se archiva
        #   - Fecha = hoy y ahora >= fin del turno -> se archiva
        # -----------------------------------------
        # a) de días pasados
        a_archivar_pasados = (ServiciosDiarios.objects
                                .select_related("turno", "chofer", "autobus", "ruta")
                                .filter(fecha__lt=today))

        # b) de hoy pero ya finalizados
        a_archivar_hoy = (ServiciosDiarios.objects
                            .select_related("turno", "chofer", "autobus", "ruta")
                            .filter(fecha=today, turno__fin__lte=now_t))

        for sd in list(a_archivar_pasados) + list(a_archivar_hoy):
            if verbose:
                self.stdout.write(f"[ARCHIVAR] {sd}")

            if not dry:
                HistorialServicios.objects.create(
                    chofer=sd.chofer,
                    autobus=sd.autobus,
                    ruta=sd.ruta,
                    fecha=sd.fecha,
                    turno=sd.turno,
                    observaciones=sd.observaciones,
                    created_at=sd.created_at,
                )
                sd.delete()

        if verbose:
            self.stdout.write(self.style.SUCCESS("Actualización + archivado completados."))
