from django.contrib import admin
from .models import *

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


class ParadaAdmin(admin.ModelAdmin):
    list_display = ('ruta', 'orden_admin', 'nombre', 'lat', 'lon')
    search_fields = ('nombre',)
    list_filter = ('ruta',)
    ordering = ('ruta', '_order', 'id')

    def orden_admin(self, obj):
        return getattr(obj, '_order', None)
    orden_admin.short_description = 'Orden'
    orden_admin.admin_order_field = '_order'


class AutobusAdmin(admin.ModelAdmin):
    list_display = ('placa', 'modelo', 'ruta', 'activo')
    search_fields = ('placa', 'modelo')
    list_filter = ('activo', 'ruta')


admin.site.register(Parada, ParadaAdmin)
admin.site.register(Autobus, AutobusAdmin)
#admin.site.register(Ruta, RutaAdmin)
# admin.site.register(UbicacionActual, UbicacionActualAdmin)
# admin.site.register(HistorialUbicacion, HistorialUbicacionAdmin)