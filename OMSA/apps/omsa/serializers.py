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


