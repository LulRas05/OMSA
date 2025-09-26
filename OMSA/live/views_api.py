from django.http import JsonResponse
from django.views.decorators.http import require_POST
from django.views.decorators.csrf import csrf_exempt
from django.db import transaction
from django.core.cache import cache
import hashlib
import json

from apps.omsa.models import Ruta, Reporte, CalificacionRuta

TIPOS_PERMITIDOS = {
    "robo",
    "objeto_perdido",
    "conduccion_temeraria",
    "sugerencia",      # singular
    "sugerencias",     # plural
}
MAX_DESC = 40

@csrf_exempt
@require_POST
def crear_reporte(request):
    try:
        data = json.loads(request.body.decode("utf-8"))
    except Exception:
        return JsonResponse({"ok": False, "error": "JSON inválido."}, status=400)

    tipo = (data.get("tipo") or "").strip().lower()
    descripcion = (data.get("descripcion") or "").strip()
    route_codes = data.get("route_codes") or []
    route_code_current = (data.get("route_code_current") or "").strip() or None
    user_latlng = data.get("user_latlng") or None

    # rate-limit + anti-duplicados
    ip = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip() or request.META.get("REMOTE_ADDR", "") or "anon"
    rl_key = f"reportes:rl:{ip}"
    if cache.get(rl_key):
        return JsonResponse({"ok": False, "error": "Estás enviando reportes muy rápido. Intenta en unos segundos."}, status=429)
    cache.set(rl_key, 1, timeout=15)

    sig = hashlib.sha256(f"{ip}|{tipo}|{descripcion}".encode("utf-8")).hexdigest()
    dd_key = f"reportes:dup:{sig}"
    if cache.get(dd_key):
        return JsonResponse({"ok": False, "error": "Reporte duplicado recientemente."}, status=409)
    cache.set(dd_key, 1, timeout=30)

    # validaciones
    if tipo not in TIPOS_PERMITIDOS:
        return JsonResponse({"ok": False, "error": "Tipo inválido."}, status=400)
    if not descripcion:
        return JsonResponse({"ok": False, "error": "Descripción requerida."}, status=400)
    if len(descripcion) > MAX_DESC:
        return JsonResponse({"ok": False, "error": f"Descripción excede {MAX_DESC} caracteres."}, status=400)

    # ruta: preferir la “actual”, si no, la primera que exista
    ruta = None
    if route_code_current:
        try:
            ruta = Ruta.objects.get(codigo=route_code_current)
        except Ruta.DoesNotExist:
            ruta = None
    if ruta is None and route_codes:
        for code in route_codes:
            try:
                ruta = Ruta.objects.get(codigo=code)
                break
            except Ruta.DoesNotExist:
                continue
    if ruta is None:
        return JsonResponse({"ok": False, "error": "No se pudo determinar la ruta del reporte."}, status=400)

    # crear robusto (tu modelo usa 'nombre'; lat/lng sólo si existen)
    field_names = {f.name for f in Reporte._meta.get_fields()}
    create_kwargs = {"descripcion": descripcion, "ruta": ruta}

    if "tipo" in field_names:
        create_kwargs["tipo"] = tipo
    elif "nombre" in field_names:
        create_kwargs["nombre"] = tipo

    if isinstance(user_latlng, dict):
        lat = user_latlng.get("lat")
        lng = user_latlng.get("lng")
        def _num(v):
            try: return float(v)
            except: return None
        if "lat" in field_names and _num(lat) is not None:
            create_kwargs["lat"] = float(lat)
        if "lng" in field_names and _num(lng) is not None:
            create_kwargs["lng"] = float(lng)

    try:
        with transaction.atomic():
            rep = Reporte.objects.create(**create_kwargs)
    except Exception:
        return JsonResponse({"ok": False, "error": "No se pudo guardar."}, status=500)

    return JsonResponse({"ok": True, "id": rep.id})

def _resolver_ruta_desde_payload(data):
    """
    Intenta resolver la Ruta a partir de los mismos campos que usas para reportes:
    - route_code_current
    - route_code
    - route_codes (toma la última)
    Si nada de eso viene, devuelve None y la vista responderá error amigable.
    """
    code = (data.get("route_code_current")
            or data.get("route_code")
            or (data.get("route_codes") or [None])[-1])
    if not code:
        return None
    try:
        return Ruta.objects.get(codigo=code)
    except Ruta.DoesNotExist:
        return None

@csrf_exempt
def crear_calificacion(request):
    if request.method != "POST":
        return JsonResponse({"ok": False, "error": "Método no permitido."}, status=405)
    try:
        data = json.loads(request.body.decode("utf-8") or "{}")
    except Exception:
        return JsonResponse({"ok": False, "error": "JSON inválido."}, status=400)

    try:
        puntuacion = int(data.get("puntuacion", 0))
    except (TypeError, ValueError):
        puntuacion = 0

    if puntuacion < 1 or puntuacion > 5:
        return JsonResponse({"ok": False, "error": "La puntuación debe ser un entero entre 1 y 5."}, status=400)

    ruta = _resolver_ruta_desde_payload(data)
    if ruta is None:
        return JsonResponse({"ok": False, "error": "No se pudo determinar la ruta a calificar."}, status=400)

    comentario = (data.get("comentario") or "").strip()[:200]
    follow_id = (data.get("follow_id") or "").strip()[:64]

    with transaction.atomic():
        cal = CalificacionRuta.objects.create(
            ruta=ruta,
            puntuacion=puntuacion,
            comentario=comentario,
            follow_id=follow_id,
        )
    return JsonResponse({"ok": True, "id": cal.id})
