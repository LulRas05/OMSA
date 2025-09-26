from django.urls import path
from . import views

urlpatterns = [
    path("api/public/live/<str:token>", views.upsert_position, name="live_upsert"),     # POST {lat,lng}
    path("api/public/live/<str:token>/last", views.last_position, name="live_last"),   # GET última pos
    path("api/public/live/<str:token>/end", views.end_session, name="live_end"),       # POST para cerrar
]
