from django.shortcuts import render
from rest_framework import viewsets
from .models import *
from .serializers import *
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
import unicodedata
# Create your views here.

def user_home(request):
    return render(request, "omsa/userhome.html")

def _normalize(txt: str) -> str:
    txt = txt or ""
    txt = unicodedata.normalize("NFD", txt)
    return "".join(ch for ch in txt if unicodedata.category(ch) != "Mn").lower()


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
        codigo = request.query_params.get('codigo')
        if not codigo:
            return Response({"detail": "Falta parámetro 'codigo'."}, status=status.HTTP_400_BAD_REQUEST)

        ruta = Ruta.objects.filter(codigo=codigo, activa=True).first()
        if not ruta:
            return Response({"detail": "Ruta no encontrada o inactiva."}, status=status.HTTP_404_NOT_FOUND)

        paradas = (
            Parada.objects
            .filter(ruta=ruta)
            .order_by('_order', 'id')
            .select_related('ruta')
        )
        data = ParadaPublicSerializer(paradas, many=True).data
        return Response(data, status=status.HTTP_200_OK)
    

from django.db.models import Q  # 👈 importa Q al inicio

class BuscarParadasAPIView(APIView):
    """
    GET /api/public/paradas/buscar/?q=texto
    Devuelve hasta 20 paradas cuyo nombre contenga q, ignorando acentos y mayúsculas.
    """
    def get(self, request):
        q = (request.GET.get("q") or "").strip()
        if not q:
            return Response([], status=status.HTTP_200_OK)

        nq = _normalize(q)
        qs = (Parada.objects
                .select_related("ruta")
                .filter(ruta__activa=True)
                .only("id", "nombre", "lat", "lon", "_order", "ruta__codigo")
                .order_by("nombre"))

        # Filtramos en Python normalizando acentos y minúsculas
        filtradas = [p for p in qs if nq in _normalize(p.nombre)]
        data = ParadaPublicSerializer(filtradas[:20], many=True).data
        return Response(data, status=status.HTTP_200_OK)

