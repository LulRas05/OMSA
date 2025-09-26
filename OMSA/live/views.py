import json, re
from django.http import JsonResponse, HttpResponseBadRequest, HttpResponseNotAllowed, HttpResponseNotFound
from django.views.decorators.csrf import csrf_exempt
from django.utils import timezone
from django.utils.cache import patch_cache_control
from .models import LiveSession

TOKEN_RE = re.compile(r"^[A-Z0-9]{8,80}$", re.I)

def _bad(msg="Bad request"):
    return HttpResponseBadRequest(msg)

def _nocache(resp):
    patch_cache_control(resp, no_cache=True, no_store=True, must_revalidate=True, max_age=0)
    return resp

@csrf_exempt
def upsert_position(request, token: str):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    if not TOKEN_RE.match(token or ""):
        return _bad("Invalid token")

    try:
        payload = json.loads(request.body or "{}")
        lat = float(payload["lat"])
        lng = float(payload["lng"])
    except Exception:
        return _bad("Invalid JSON: expected {lat,lng}")

    sess, _ = LiveSession.objects.get_or_create(token=token)
    sess.last_lat = lat
    sess.last_lng = lng
    sess.updated_at = timezone.now()
    sess.active = True
    sess.save(update_fields=["last_lat", "last_lng", "updated_at", "active"])
    return _nocache(JsonResponse({"ok": True}))

def last_position(request, token: str):
    if not TOKEN_RE.match(token or ""):
        return _bad("Invalid token")
    try:
        sess = LiveSession.objects.get(token=token, active=True)
    except LiveSession.DoesNotExist:
        return HttpResponseNotFound("Unknown token")
    return _nocache(JsonResponse(sess.as_dict()))

@csrf_exempt
def end_session(request, token: str):
    if request.method != "POST":
        return HttpResponseNotAllowed(["POST"])
    if not TOKEN_RE.match(token or ""):
        return _bad("Invalid token")
    LiveSession.objects.filter(token=token).update(active=False)
    return _nocache(JsonResponse({"ok": True}))
