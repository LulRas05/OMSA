from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from django.utils import timezone

from .models import ServiciosDiarios, Chofer, Autobus

def _weekday_to_day_group(dt_date):
    wd = dt_date.weekday()
    if 0 <= wd <= 4:
        return "LV"
    if wd == 5:
        return "SA"
    return "DO"

def _now_in_turno_window(fecha, turno, tznow=None):
    if tznow is None:
        tznow = timezone.localtime()
    today = tznow.date()
    if fecha != today:
        return False
    today_group = _weekday_to_day_group(today)
    if turno.day_group != today_group:
        return False
    now_t = tznow.time()
    return turno.inicio <= now_t < turno.fin


@receiver(post_save, sender=ServiciosDiarios)
def sd_aplicar_estados_si_ventana_vigente(sender, instance: ServiciosDiarios, created, **kwargs):
    """
    Si se crea/guarda un servicio diario y estamos DENTRO de su ventana hoy,
    pone chofer=asignado y bus=en_servicio + cachea relaciones.
    """
    tznow = timezone.localtime()
    if not _now_in_turno_window(instance.fecha, instance.turno, tznow=tznow):
        return

    chofer = instance.chofer
    autobus = instance.autobus

    updates_chofer = {}
    updates_bus = {}

    if chofer.autobus_actual_id != autobus.id:
        updates_chofer["autobus_actual"] = autobus
    if chofer.estado != "asignado":
        updates_chofer["estado"] = "asignado"

    if autobus.chofer_actual_id != chofer.id:
        updates_bus["chofer_actual"] = chofer
    if autobus.estado != "en_servicio":
        updates_bus["estado"] = "en_servicio"

    if updates_chofer:
        Chofer.objects.filter(pk=chofer.pk).update(**updates_chofer)
    if updates_bus:
        Autobus.objects.filter(pk=autobus.pk).update(**updates_bus)


@receiver(post_delete, sender=ServiciosDiarios)
def sd_liberar_si_no_hay_otro_activo(sender, instance: ServiciosDiarios, **kwargs):
    """
    Al borrar un servicio diario, si NO queda otro servicio activo AHORA para el chofer/bus,
    los pone disponibles y limpia caches.
    """
    now = timezone.localtime()
    today = now.date()
    now_t = now.time()
    today_group = _weekday_to_day_group(today)

    chofer = instance.chofer
    autobus = instance.autobus

    # ¿El chofer tiene otro servicio activo ahora?
    chofer_activo = ServiciosDiarios.objects.filter(
        chofer=chofer, fecha=today, turno__day_group=today_group,
        turno__inicio__lte=now_t, turno__fin__gt=now_t
    ).exists()

    if not chofer_activo:
        upd = {}
        if chofer.estado != "disponible":
            upd["estado"] = "disponible"
        if chofer.autobus_actual_id is not None:
            upd["autobus_actual"] = None
        if upd:
            Chofer.objects.filter(pk=chofer.pk).update(**upd)

    # ¿El bus tiene otro servicio activo ahora?
    bus_activo = ServiciosDiarios.objects.filter(
        autobus=autobus, fecha=today, turno__day_group=today_group,
        turno__inicio__lte=now_t, turno__fin__gt=now_t
    ).exists()

    if not bus_activo:
        upd = {}
        if autobus.estado not in ("mantenimiento", "fuera_de_servicio", "disponible"):
            upd["estado"] = "disponible"
        if autobus.chofer_actual_id is not None:
            upd["chofer_actual"] = None
        if upd:
            Autobus.objects.filter(pk=autobus.pk).update(**upd)
