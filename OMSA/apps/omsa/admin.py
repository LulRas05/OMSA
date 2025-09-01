from django.contrib import admin
from .models import *

# Register your models here.
class RutaAdmin(admin.ModelAdmin):
    list_display = ('codigo', 'origen', 'destino', 'activa')
    search_fields = ('codigo', 'origen', 'destino')
    list_filter = ('activa',)

class ParadaAdmin(admin.ModelAdmin):
    list_display = ('ruta', 'nombre', 'orden', 'lat', 'lon')
    search_fields = ('nombre',)
    list_filter = ('ruta',)

class AutobusAdmin(admin.ModelAdmin):
    list_display = ('placa', 'modelo', 'ruta', 'activo')
    search_fields = ('placa', 'modelo')
    list_filter = ('activo', 'ruta')

class UbicacionActualAdmin(admin.ModelAdmin):
    list_display = ('autobus', 'lat', 'lon', 'fecha_hora')
    search_fields = ('autobus__placa',)
    list_filter = ('autobus',)

class HistorialUbicacionAdmin(admin.ModelAdmin):
    list_display = ('autobus', 'lat', 'lon', 'fecha_hora')
    search_fields = ('autobus__placa',)
    list_filter = ('autobus',)

admin.site.register(Ruta, RutaAdmin)
admin.site.register(Parada, ParadaAdmin)
admin.site.register(Autobus, AutobusAdmin)
# admin.site.register(UbicacionActual, UbicacionActualAdmin)
# admin.site.register(HistorialUbicacion, HistorialUbicacionAdmin)