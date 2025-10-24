from django.contrib import admin
from .models import *
from django import forms
from datetime import date
from django.utils import timezone

def _weekday_to_day_group_from_date(d):
    wd = d.weekday()  # 0=lun ... 6=dom
    if 0 <= wd <= 4:
        return "LV"
    if wd == 5:
        return "SA"
    return "DO"

def _parse_fecha_str(fecha_str: str):
    """
    Acepta 'YYYY-MM-DD' (datepicker por defecto) o 'DD/MM/YYYY' (según formateo del admin).
    Devuelve datetime.date o None.
    """
    if not fecha_str:
        return None
    fecha_str = fecha_str.strip()
    try:
        # ISO
        if "-" in fecha_str and len(fecha_str) == 10:
            return date.fromisoformat(fecha_str)
        # DD/MM/YYYY
        if "/" in fecha_str:
            dd, mm, yyyy = fecha_str.split("/")
            return date(int(yyyy), int(mm), int(dd))
    except Exception:
        return None
    return None

#HORA DE TURNO
class TurnoForm(forms.ModelForm):
    class Meta:
        model = Turno
        fields = "__all__"
        widgets = {
            # HTML5 time inputs (24h). step está en segundos: 60 = de minuto en minuto
            "inicio": forms.TimeInput(attrs={"type": "time", "step": 60}),
            "fin":    forms.TimeInput(attrs={"type": "time", "step": 60}),
        }

    # Acepta HH:MM o HH:MM:SS
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for f in ("inicio", "fin"):
            self.fields[f].input_formats = ["%H:%M", "%H:%M:%S"]

        

class ServiciosDiariosForm(forms.ModelForm):
    class Meta:
        model = ServiciosDiarios
        fields = "__all__"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        now   = timezone.localtime()
        today = now.date()
        now_t = now.time()

        # --- EDICIÓN (instancia con fecha) ---
        fecha_inst = None
        if "fecha" in self.initial and self.initial["fecha"]:
            fecha_inst = self.initial["fecha"]
        elif self.instance and self.instance.pk:
            fecha_inst = self.instance.fecha

        if fecha_inst:
            dg = _weekday_to_day_group_from_date(fecha_inst)
            qs = Turno.objects.filter(day_group=dg)
            if fecha_inst == today:
                qs = qs.filter(fin__gt=now_t)  # no mostrar turnos ya terminados hoy
            self.fields["turno"].queryset = qs
            self.fields["turno"].disabled = False
        else:
            # CREACIÓN (sin fecha aún): deja todas para que el JS pueda filtrarlas, pero disabled
            self.fields["turno"].queryset = Turno.objects.all().order_by("day_group", "inicio")
            self.fields["turno"].disabled = True
            self.fields["turno"].help_text = "Selecciona la fecha primero para ver los turnos disponibles."

        # --- POST: usar la FECHA enviada ---
        if self.data:
            fecha_str = self.data.get("fecha")
            f = _parse_fecha_str(fecha_str)
            if f:
                dg = _weekday_to_day_group_from_date(f)
                qs = Turno.objects.filter(day_group=dg)
                if f == today:
                    qs = qs.filter(fin__gt=now_t)  # no terminados hoy
                self.fields["turno"].queryset = qs
                self.fields["turno"].disabled = False
                self.fields["turno"].required = True
                self.fields["turno"].widget.attrs.pop("disabled", None)
                self.fields["turno"].help_text = ""



class ParadaInline(admin.TabularInline):
    model = Parada

    readonly_fields = ('orden_readonly',)
    fields = ('orden_readonly', 'nombre', 'lat', 'lon')
    extra = 1
    can_delete = True
    show_change_link = True
    ordering = ('_order',)

    def orden_readonly(self, obj):
        return getattr(obj, '_order', None)
    orden_readonly.short_description = 'Orden'


@admin.register(Ruta)
class RutaAdmin(admin.ModelAdmin):
    list_display = ('codigo', 'origen', 'destino', 'activa')
    search_fields = ('codigo', 'origen', 'destino')
    list_filter = ('activa',)

    change_form_template = "admin/omsa/ruta_change_form.html"
    inlines = [ParadaInline]

    class Media:
        js = (
            'omsa/admin/ruta_admin.js',
            'https://maps.googleapis.com/maps/api/js?key=AIzaSyCl8SfPwcJc8Nl-rmAXhI8G8aPxC56tSJU&callback=omsaAdminInitMap',
        )
        css = {"all": ("omsa/admin/map.css",)}


class ParadaFormSoloLectura(forms.ModelForm):
    # Campo “virtual” solo para mostrar la ruta con look de input
    ruta_nombre = forms.CharField(
        label='Ruta',
        required=False,
        widget=forms.TextInput(attrs={'readonly': 'readonly', 'class': 'vTextField'})
    )

    class Meta:
        model = Parada
        # Excluye el FK real para que no salga en el form
        exclude = ('ruta',)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk and self.instance.ruta_id:
            self.fields['ruta_nombre'].initial = str(self.instance.ruta)



class ParadaAdmin(admin.ModelAdmin):
    form = ParadaFormSoloLectura 
    list_display = ('ruta', 'orden_admin', 'nombre', 'lat', 'lon')
    search_fields = ('nombre',)
    list_filter = ('ruta',)
    ordering = ('ruta', '_order', 'id')

    fields = ('ruta_nombre', 'nombre', 'lat', 'lon' )

    def orden_admin(self, obj):
        return getattr(obj, '_order', None)
    orden_admin.short_description = 'Orden'
    orden_admin.admin_order_field = '_order'


class AutobusAdmin(admin.ModelAdmin):
    list_display = ('placa', 'modelo', 'ruta', 'estado', 'chofer_actual', 'activo')
    search_fields = ('placa', 'modelo')
    list_filter = ('estado', 'activo', 'ruta')
    autocomplete_fields = ('chofer_actual',)

    def get_search_results(self, request, queryset, search_term):
        queryset, use_distinct = super().get_search_results(request, queryset, search_term)
        if request.path.endswith("/autocomplete/") \
            and request.GET.get("app_label") == "omsa" \
            and request.GET.get("model_name") in ("serviciosdiarios",) \
            and request.GET.get("field_name") == "autobus":
            queryset = queryset.filter(activo=True).exclude(
                estado__in=["mantenimiento", "fuera_de_servicio"]
            )
        return queryset, use_distinct

@admin.register(Chofer)
class ChoferAdmin(admin.ModelAdmin):
    list_display = ("cedula", "apellido", "nombre", "estado", "activo", "autobus_actual")
    list_filter = ("estado", "activo")
    search_fields = ("cedula", "nombre", "apellido", "telefono", "correoelectronico")
    autocomplete_fields = ("autobus_actual",)

    # ✅ Filtra los resultados del autocomplete cuando el campo que consulta es ServiciosDiarios.chofer
    def get_search_results(self, request, queryset, search_term):
        queryset, use_distinct = super().get_search_results(request, queryset, search_term)

        # Este view se usa para todos los autocompletes; acotamos solo al de ServiciosDiarios.chofer
        if request.path.endswith("/autocomplete/") \
            and request.GET.get("app_label") == "omsa" \
            and request.GET.get("model_name") in ("serviciosdiarios",) \
            and request.GET.get("field_name") == "chofer":
            queryset = queryset.filter(activo=True).exclude(
                estado__in=["licencia", "suspendido", "descanso"]
            )
        return queryset, use_distinct

@admin.register(Turno)
class TurnoAdmin(admin.ModelAdmin):
    form = TurnoForm
    list_display = ("nombre", "day_group", "inicio", "fin")
    list_filter = ("day_group",)
    ordering = ("day_group", "inicio")
    search_fields = ("nombre", "day_group")

    class Media:
        # Oculta los atajos "Ahora / Medianoche" del admin clásico
        css = {"all": ("omsa/admin/ocultar_atajos.css",)}

@admin.register(ServiciosDiarios)
class ServiciosDiariosAdmin(admin.ModelAdmin):
    form = ServiciosDiariosForm
    list_display = ("fecha", "turno", "chofer", "autobus", "ruta", "created_at")
    list_filter = ("fecha", "turno__day_group", "autobus__estado", "chofer__estado")
    search_fields = ("chofer__cedula","chofer__nombre","chofer__apellido","autobus__placa","ruta__nombre")
    # IMPORTANTE: NO incluir 'turno' aquí
    autocomplete_fields = ("chofer","autobus","ruta")
    date_hierarchy = "fecha"

    class Media:
        # Asegúrate de tener este archivo en static/omsa/js/ (ver paso 2)
        js = ("omsa/admin/servicios_diarios_admin.js",)

@admin.register(HistorialServicios)
class HistorialServiciosAdmin(admin.ModelAdmin):
    list_display = ("fecha", "turno", "chofer", "autobus", "ruta", "created_at", "archived_at")
    list_filter = ("fecha", "turno__day_group")
    search_fields = ("chofer__cedula","chofer__nombre","chofer__apellido","autobus__placa","ruta__nombre")
    autocomplete_fields = ("chofer","autobus","ruta","turno")
    date_hierarchy = "fecha"


@admin.register(Reporte)
class ReporteAdmin(admin.ModelAdmin):
    list_display = ("id", "nombre", "ruta", "creado_en", "descripcion_short")
    list_filter = ("nombre", "ruta")
    search_fields = ("descripcion", "ruta__nombre", "ruta__codigo")
    date_hierarchy = "creado_en"
    ordering = ("-creado_en",)

    def descripcion_short(self, obj):
        txt = obj.descripcion or ""
        return (txt[:80] + "…") if len(txt) > 80 else txt
    descripcion_short.short_description = "Descripción"


@admin.register(CalificacionRuta)
class CalificacionRutaAdmin(admin.ModelAdmin):
    list_display = ("id", "ruta", "puntuacion", "creado_en", "comentario")
    list_filter = ("puntuacion", "ruta")
    search_fields = ("ruta__codigo", "comentario")
    ordering = ("-creado_en",)


admin.site.register(Parada, ParadaAdmin)
admin.site.register(Autobus, AutobusAdmin)
#admin.site.register(Ruta, RutaAdmin)
# admin.site.register(UbicacionActual, UbicacionActualAdmin)
# admin.site.register(HistorialUbicacion, HistorialUbicacionAdmin)