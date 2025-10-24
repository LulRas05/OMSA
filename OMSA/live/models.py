from django.db import models

class LiveSession(models.Model):
    token = models.CharField(max_length=64, unique=True, db_index=True)
    last_lat = models.FloatField(null=True, blank=True)
    last_lng = models.FloatField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    active = models.BooleanField(default=True)

    def as_dict(self):
        t = int(self.updated_at.timestamp() * 1000) if self.updated_at else None
        return {"lat": self.last_lat, "lng": self.last_lng, "t": t}

    def __str__(self):
        return f"{self.token} ({'on' if self.active else 'off'})"
