from rest_framework import serializers
from .models import *


class RutaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Ruta
        fields = '__all__'

class ParadaSerializer(serializers.ModelSerializer):
    ruta = serializers.IntegerField(source= '_order', read_only = True)
    class Meta:
        model = Parada
        fields = '__all__'

class AutobusSerializer(serializers.ModelSerializer):
    class Meta:
        model = Autobus 
        fields = '__all__'

class RutaPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = Ruta
        fields = ["codigo", "nombre", "origen", "destino", "activa"]

class ParadaPublicSerializer(serializers.ModelSerializer):
    orden = serializers.IntegerField(source="_order", read_only=True)
    ruta_codigo = serializers.CharField(source="ruta.codigo", read_only=True)

    class Meta:
        model = Parada
        fields = ["id", "nombre", "lat", "lon", "orden", "ruta_codigo"]

class ReporteSerializer(serializers.ModelSerializer):
    ruta_codigo = serializers.CharField(write_only=True)

    class Meta:
        model = Reporte
        fields = ["id", "nombre", "descripcion", "ruta", "ruta_codigo", "creado_en"]
        read_only_fields = ["id", "ruta", "creado_en"]

    def create(self, validated_data):
        codigo = validated_data.pop("ruta_codigo", "").strip()
        try:
            ruta = Ruta.objects.get(codigo=codigo)
        except Ruta.DoesNotExist:
            raise serializers.ValidationError({"ruta_codigo": "Ruta no encontrada"})
        return Reporte.objects.create(ruta=ruta, **validated_data)



