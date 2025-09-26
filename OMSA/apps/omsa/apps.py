from django.apps import AppConfig

class OmsaConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.omsa'

    def ready(self):
        # Carga señales al iniciar la app
        from . import signals  # noqa: F401
