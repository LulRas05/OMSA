from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from live.views_api import crear_calificacion
from rest_framework.routers import DefaultRouter
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from rest_framework_simplejwt.views import (
    TokenObtainPairView,
    TokenRefreshView,
)

router = DefaultRouter()

urlpatterns = [
    # ? admin panel
    path('admin/', admin.site.urls),

    # ? apps
    path('', include('apps.omsa.urls')),

    # ? drf
    path('api/', include(router.urls)),

    path("api/calificaciones/", crear_calificacion, name="api_crear_calificacion"),

    # ? Login 
    path('api/token/', TokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('api/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),

    # ? Swagger
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/swagger/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    path('api/docs/redoc/', SpectacularRedocView.as_view(url_name='schema'), name='redoc'),

    # ? GeoLoc
    path("", include("live.urls")),
] 

# Solo para entorno de desarrollo
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])

