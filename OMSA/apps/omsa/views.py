from django.shortcuts import render
from rest_framework import viewsets
from .models import *
from .serializers import *
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
# Create your views here.

def user_home(request):
    return render(request, "omsa/userhome.html")

class RutaViewSet(viewsets.ModelViewSet):
    queryset = Ruta.objects.all()
    serializer_class = RutaSerializer

class ParadaViewSet(viewsets.ModelViewSet):
    queryset = Parada.objects.all()
    serializer_class = ParadaSerializer

class AutobusViewSet(viewsets.ModelViewSet):
    queryset = Autobus.objects.all()
    serializer_class = AutobusSerializer

class RutasPublicAPIView(APIView):
    def get(self, request):
        rutas = Ruta.objects.filter(activa=True).order_by("codigo")
        data = RutaPublicSerializer(rutas, many=True).data
        return Response(data)

class ParadasPorRutasAPIView(APIView):
    def get(self, request):
        codigo = request.GET.get("codigo")
        if not codigo:
            return Response({"detail": "Falta parámetro 'codigo'."}, status=status.HTTP_400_BAD_REQUEST)

        # ⬇⬇⬇ CAMBIO: active -> activa
        ruta = Ruta.objects.filter(codigo=codigo, activa=True).first()
        if not ruta:
            return Response({"detail": "Ruta no encontrada o inactiva."}, status=status.HTTP_404_NOT_FOUND)

        paradas = Parada.objects.filter(ruta=ruta).order_by("orden")
        data = ParadaPublicSerializer(paradas, many=True).data
        return Response(data, status=status.HTTP_200_OK)
    

from django.db.models import Q  # 👈 importa Q al inicio

class BuscarParadasAPIView(APIView):
    """
    GET /api/public/paradas/buscar/?q=texto
    Devuelve hasta 20 paradas cuyo nombre contenga q (case-insensitive).
    """
    def get(self, request):
        q = request.GET.get("q", "").strip()
        if not q:
            return Response([], status=status.HTTP_200_OK)

        # 👇 corregido: "icontain" -> "icontains", y con indentación correcta
        paradas = (Parada.objects
                    .select_related("ruta")
                    .filter(Q(nombre__icontains=q))
                    .order_by("nombre")[:20])

        data = ParadaPublicSerializer(paradas, many=True).data
        return Response(data, status=status.HTTP_200_OK)
