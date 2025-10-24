from django.db import models
from django.core.validators import MinValueValidator, MaxValueValidator, RegexValidator
from django.utils import timezone
from django.core.exceptions import ValidationError

ESTADO_AUTOBUS_CHOICES = (
    ("disponible", "Disponible"),
    ("en_servicio", "En servicio"),
    ("mantenimiento", "En mantenimiento"),
    ("fuera_de_servicio", "Fuera de servicio"),
)

ESTADO_CHOFER_CHOICES = (
    ("disponible", "Disponible"),
    ("asignado", "Asignado"),
    ("descanso", "Descanso"),
    ("licencia", "Licencia"),
    ("suspendido", "Suspendido"),
)

DAY_GROUP_CHOICES = (
    ("LV", "Lunes a Viernes"),
    ("SA", "Sábado"),
    ("DO", "Domingo"),
)

def _weekday_to_day_group_from_date(d):
    wd = d.weekday()  # 0=lun ... 6=dom
    if 0 <= wd <= 4:
        return "LV"
    if wd == 5:
        return "SA"
    return "DO"


    
class Ruta(models.Model):
    nombre = models.CharField(max_length=100)
    origen = models.CharField(max_length=100)
    destino = models.CharField(max_length=100)
    codigo = models.CharField(max_length=20, unique=True)
    activa = models.BooleanField(default=True)

    def __str__(self):
        return f"{self.codigo}: {self.origen} → {self.destino}"
    

class Parada(models.Model):
    ruta = models.ForeignKey(Ruta, on_delete=models.CASCADE, related_name='paradas')
    nombre = models.CharField(max_length=100)
    orden = models.PositiveIntegerField()
    lat = models.FloatField(
        validators=[MinValueValidator(-90.0), MaxValueValidator(90.0)]
    )
    lon = models.FloatField(
        validators=[MinValueValidator(-180.0), MaxValueValidator(180.0)]
    )

    class Meta:
        order_with_respect_to = 'ruta'

    def __str__(self):
        return f"{self.nombre} - (orden {self.ruta.codigo})"
    
    @property
    def orden(self) -> int:
        return getattr(self, '_order', None)

class Autobus(models.Model):
    placa = models.CharField(max_length=20, unique=True)
    modelo = models.CharField(max_length=100)
    color = models.CharField(max_length=50)
    ruta = models.ForeignKey(Ruta, on_delete=models.SET_NULL, null=True, blank=True)
    activo = models.BooleanField(default=True)
    foto = models.ImageField(upload_to='autobuses/', null=True, blank=True)

    estado = models.CharField(
        max_length=32,
        choices=ESTADO_AUTOBUS_CHOICES,
        default="disponible",
    )

    chofer_actual = models.ForeignKey(
        "Chofer",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="autobuses_actuales",
        help_text="Cache del chofer activo hoy. Se actualiza al crear asignaciones de hoy en ventana de turno.",
    )

    class Meta:
        verbose_name = "Autobús"
        verbose_name_plural = "Autobuses"

    def __str__(self):
        return f"{self.placa} - {self.modelo}"
    

class Chofer(models.Model):
    cedula = models.CharField(
        max_length=11,
        unique=True,
        validators=[
            RegexValidator(regex=r"^\d{11}$", message="La cédula debe tener 11 dígitos numéricos."),
        ],
        help_text="11 dígitos, sin guiones.",
    )
    nombre = models.CharField(max_length=120)
    apellido = models.CharField(max_length=120)

    telefono = models.CharField(
        max_length=20,
        blank=True,
        validators=[RegexValidator(regex=r"^[\d\s+\-()]+$", message="Teléfono inválido.")],
    )
    correoelectronico = models.EmailField(blank=True)

    estado = models.CharField(
        max_length=20,
        choices=ESTADO_CHOFER_CHOICES,
        default="disponible",
    )
    activo = models.BooleanField(default=True)

    autobus_actual = models.ForeignKey(
        Autobus,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="choferes_actuales",
        help_text="Cache del autobús activo hoy. Se actualiza al crear asignaciones de hoy en ventana de turno.",
    )

    class Meta:
        ordering = ["apellido", "nombre"]
        verbose_name = "Chofer"
        verbose_name_plural = "Choferes"
        

    def __str__(self):
        return f"{self.nombre} {self.apellido} ({self.cedula})"


class Turno(models.Model):
    nombre = models.CharField(max_length=64, help_text="Ej: Mañana, Tarde")
    day_group = models.CharField(max_length=2, choices=DAY_GROUP_CHOICES, help_text="Grupo de días al que aplica.")
    inicio = models.TimeField()
    fin = models.TimeField()

    class Meta:
        unique_together = (("nombre", "day_group", "inicio", "fin"),)
        ordering = ["day_group", "inicio"]

    def __str__(self):
        return f"{self.get_day_group_display()} • {self.nombre} ({self.inicio}–{self.fin})"

class ServiciosDiarios(models.Model):
    chofer = models.ForeignKey("Chofer", on_delete=models.PROTECT, related_name="servicios_diarios")
    autobus = models.ForeignKey("Autobus", on_delete=models.PROTECT, related_name="servicios_diarios")
    ruta = models.ForeignKey("Ruta", on_delete=models.PROTECT, related_name="servicios_diarios", null=True, blank=True)

    fecha = models.DateField(help_text="Fecha del día de trabajo.")
    turno = models.ForeignKey("Turno", on_delete=models.PROTECT, related_name="servicios_diarios")

    observaciones = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "Servicio diario"
        verbose_name_plural = "Servicios diarios"
        ordering = ["-fecha", "turno__inicio", "chofer__apellido"]
        constraints = [
            # Evita duplicados exactos
            models.UniqueConstraint(fields=["chofer", "fecha", "turno"], name="uniq_sd_chofer_fecha_turno"),
            models.UniqueConstraint(fields=["autobus", "fecha", "turno"], name="uniq_sd_bus_fecha_turno"),
        ]
        indexes = [
            models.Index(fields=["fecha", "turno"]),
            models.Index(fields=["autobus", "fecha", "turno"]),
            models.Index(fields=["chofer", "fecha", "turno"]),
        ]

    def __str__(self):
        return f"{self.fecha} • {self.turno} • {self.chofer} → {self.autobus}"

    # --- VALIDACIONES DE NEGOCIO ---
    def clean(self):
        errors = {}

        # Requeridos sin tocar relaciones
        if not self.chofer_id:
            errors["chofer"] = "Debes seleccionar un chofer."
        if not self.autobus_id:
            errors["autobus"] = "Debes seleccionar un autobús."
        if not self.fecha:
            errors["fecha"] = "Debes seleccionar la fecha."
        if not self.turno_id:
            errors["turno"] = "Debes seleccionar un turno."

        if errors:
            raise ValidationError(errors)

        # Objetos ya seguros
        chofer = self.chofer
        autobus = self.autobus
        turno  = self.turno

        # 1) No permitir FECHA en el pasado
        tznow  = timezone.localtime()
        today  = tznow.date()
        now_t  = tznow.time()
        if self.fecha < today:
            errors["fecha"] = "No puedes programar en una fecha pasada."

        # 2) Si es HOY, no permitir turnos ya terminados (fin <= ahora)
        if self.fecha == today and turno.fin <= now_t:
            errors["turno"] = "No puedes seleccionar un turno que ya terminó hoy."

        # 3) Day group correcto
        expected_group = _weekday_to_day_group_from_date(self.fecha)
        if turno.day_group != expected_group:
            errors["turno"] = "El turno no corresponde al día de la fecha."

        # 4) Estado/activo de chofer y bus (tus reglas)
        if not getattr(chofer, "activo", True):
            errors["chofer"] = "No puedes asignar un chofer inactivo."
        if chofer.estado in ("licencia", "suspendido", "descanso"):
            errors["chofer"] = f"No puedes asignar un chofer en estado '{chofer.get_estado_display()}'."

        if hasattr(autobus, "activo") and autobus.activo is False:
            errors["autobus"] = "No puedes asignar un autobús inactivo."
        if autobus.estado in ("mantenimiento", "fuera_de_servicio"):
            errors["autobus"] = f"No puedes asignar un autobús en estado '{autobus.get_estado_display()}'."

        # 5) Antisolape chofer y bus en la misma fecha
        qs_bus = (self.__class__.objects
                    .filter(autobus_id=self.autobus_id, fecha=self.fecha))
        if self.pk:
            qs_bus = qs_bus.exclude(pk=self.pk)
        qs_bus = qs_bus.filter(turno__inicio__lt=turno.fin, turno__fin__gt=turno.inicio)
        if qs_bus.exists():
            errors["autobus"] = "El autobús ya tiene otra asignación que se solapa en esta fecha/horario."

        qs_ch = (self.__class__.objects
                    .filter(chofer_id=self.chofer_id, fecha=self.fecha))
        if self.pk:
            qs_ch = qs_ch.exclude(pk=self.pk)
        qs_ch = qs_ch.filter(turno__inicio__lt=turno.fin, turno__fin__gt=turno.inicio)
        if qs_ch.exists():
            errors["chofer"] = "El chofer ya tiene otra asignación que se solapa en esta fecha/horario."

        if errors:
            raise ValidationError(errors)

    def save(self, *args, **kwargs):
        self.full_clean()
        return super().save(*args, **kwargs)


class HistorialServicios(models.Model):
    """
    Copia de ServiciosDiarios para conservar el historial.
    Se llena moviendo (archivando) registros ya finalizados.
    """
    chofer = models.ForeignKey("Chofer", on_delete=models.PROTECT, related_name="historial_servicios")
    autobus = models.ForeignKey("Autobus", on_delete=models.PROTECT, related_name="historial_servicios")
    ruta = models.ForeignKey("Ruta", on_delete=models.PROTECT, related_name="historial_servicios", null=True, blank=True)

    fecha = models.DateField()
    turno = models.ForeignKey("Turno", on_delete=models.PROTECT, related_name="historial_servicios")

    observaciones = models.TextField(blank=True)
    created_at = models.DateTimeField()  # preservamos la fecha de creación original
    archived_at = models.DateTimeField(auto_now_add=True)  # cuándo se movió al historial

    class Meta:
        verbose_name = "Historial de servicios"
        verbose_name_plural = "Historial de servicios"
        ordering = ["-fecha", "turno__inicio", "chofer__apellido"]
        indexes = [
            models.Index(fields=["fecha", "turno"]),
            models.Index(fields=["autobus", "fecha", "turno"]),
            models.Index(fields=["chofer", "fecha", "turno"]),
        ]

    def __str__(self):
        return f"[HIST] {self.fecha} • {self.turno} • {self.chofer} → {self.autobus}"
    

    
class UbicacionActual(models.Model):
    autobus = models.OneToOneField(Autobus, on_delete=models.CASCADE)
    lat = models.FloatField()
    lon = models.FloatField()
    fecha_hora = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.autobus.placa} - {self.lat}, {self.lon}"
    

class HistorialUbicacion(models.Model):
    autobus = models.ForeignKey(Autobus, on_delete=models.CASCADE)
    lat = models.FloatField()
    lon = models.FloatField()
    fecha_hora = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-fecha_hora']

    def __str__(self):
        return f"{self.autobus.placa} - {self.fecha_hora}"
    

class Reporte(models.Model):
    TIPO_CHOICES = (
        ("robo", "Robo"),
        ("objeto_perdido", "Objeto perdido"),
        ("conduccion_temeraria", "Conducción Temeraria"),
        ("sugerencia", "Sugerencia"),
    )
    nombre = models.CharField(max_length=32, choices=TIPO_CHOICES)
    descripcion = models.CharField(max_length=200)  # 20 palabras aprox. caben holgadamente
    ruta = models.ForeignKey(Ruta, on_delete=models.PROTECT, related_name="reportes")
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en"]

    def __str__(self):
        dt_local = timezone.localtime(self.creado_en)  # ← convertir a la zona del proyecto
        return f"{self.get_nombre_display()} • {self.ruta.codigo} • {dt_local:%Y-%m-%d %H:%M}"
    

class CalificacionRuta(models.Model):
    ruta = models.ForeignKey(Ruta, on_delete=models.PROTECT, related_name="calificaciones")
    puntuacion = models.PositiveSmallIntegerField(validators=[MinValueValidator(1), MaxValueValidator(5)])
    comentario = models.CharField(max_length=200, blank=True)
    # opcional: para deduplicar calificación por sesión/seguimiento
    follow_id = models.CharField(max_length=64, blank=True, default="")
    creado_en = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-creado_en"]

    def __str__(self):
        from django.utils import timezone
        dt_local = timezone.localtime(self.creado_en)
        return f"⭐ {self.puntuacion} • {self.ruta.codigo} • {dt_local:%Y-%m-%d %H:%M}"
