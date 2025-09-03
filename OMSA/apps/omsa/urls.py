from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import *


router = DefaultRouter()
router.register(r'rutas', RutaViewSet, basename='ruta')
router.register(r'paradas', ParadaViewSet, basename='parada')
router.register(r'autobuses', AutobusViewSet, basename='autobus')

urlpatterns = [
    path('api/', include(router.urls)),
    path("api/public/rutas/", RutasPublicAPIView.as_view(), name="rutas_public"),
    path("api/public/paradas/", ParadasPorRutasAPIView.as_view(), name="paradas_por_ruta"),
    path("api/public/paradas/buscar/", BuscarParadasAPIView.as_view(), name="paradas_buscar"),
    path("", user_home, name="home"),
]