from django.db import models

    
class Ruta(models.Model):
    nombre = models.CharField(max_length=100)
    origen = models.CharField(max_length=100)
    destino = models.CharField(max_length=100)
    codigo = models.CharField(max_length=20, unique=True)
    activa = models.BooleanField(default=True)

    def __str__(self):
        return f"{self.codigo}: {self.origen} → {self.destino}"
    
class Parada(models.Model):
    ruta = models.ForeignKey(Ruta, on_delete=models.CASCADE, related_name='paradas')
    nombre = models.CharField(max_length=100)
    orden = models.PositiveIntegerField()
    lat = models.FloatField()
    lon = models.FloatField()

    class Meta:
        ordering = ['orden']

    def __str__(self):
        return f"{self.nombre} - {self.ruta.codigo}"

class Autobus(models.Model):
    placa = models.CharField(max_length=20, unique=True)
    modelo = models.CharField(max_length=100)
    color = models.CharField(max_length=50)
    ruta = models.ForeignKey(Ruta, on_delete=models.SET_NULL, null=True, blank=True)
    activo = models.BooleanField(default=True)
    foto = models.ImageField(upload_to='autobuses/', null=True, blank=True)

    def __str__(self):
        return f"{self.placa} - {self.modelo}"
    
class UbicacionActual(models.Model):
    autobus = models.OneToOneField(Autobus, on_delete=models.CASCADE)
    lat = models.FloatField()
    lon = models.FloatField()
    fecha_hora = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.autobus.placa} - {self.lat}, {self.lon}"
    

class HistorialUbicacion(models.Model):
    autobus = models.ForeignKey(Autobus, on_delete=models.CASCADE)
    lat = models.FloatField()
    lon = models.FloatField()
    fecha_hora = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-fecha_hora']

    def __str__(self):
        return f"{self.autobus.placa} - {self.fecha_hora}"