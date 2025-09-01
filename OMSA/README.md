## Sistema de Seguimiento de Rutas – OMSA

Backend desarrollado en Django para la gestión y rastreo de autobuses de la Operadora Metropolitana de Servicios de Autobuses (OMSA), como parte del proyecto de tesis de Rasec Cordero y Emely Segura.

## 🧹 Funcionalidades

- Registro y administración de rutas de transporte
- Control de paradas por ruta
- Registro y gestión de autobuses
- Recepción de coordenadas en tiempo real
- Historial de ubicación por autobús
- API REST segura y documentada

---

## 🚀 Tecnologías utilizadas

- **Lenguaje**: Python 3.10
- **Framework**:  Django 5.2.1 + Django Rest Framework 3.14.0
- **Base de datos**: SQLite
- **Autenticación**: Token Authentication
- **Documentación API**: Swagger o Postman

---

## 📦 Instalación

1. Clona el repositorio:

```bash
git clone https://github.com/Jordin-Rosario/OMSA.git
cd backend-omsa
```

2. Crea y activa el entorno virtual:

```bash
python -m venv env
source env/bin/activate  # Windows: env\Scripts\activate
```

3. Instala dependencias:

```bash
pip install -r requirements.txt
```

4. Crear archivo .env
```
backend-omsa/
├── core/              ← Aquí va tu archivo `.env`
│   ├── settings.py
│   └── .env
├── manage.py
```
4.1 Dentro del archivo .env 
```
    SECRET_KEY='tu_clave_secreta_aqui'
    DEBUG=True
    ALLOWED_HOST='*'
    CORS_ORIGIN_WHITELIST=http://localhost:3000
    CORS_ALLOWED_ORIGINS=http://localhost:3000
```

5. Ejecuta migraciones y carga datos iniciales (si aplica):

```bash
python manage.py migrate
python manage.py loaddata fixtures.json  # si se incluye
```

6. Inicia el servidor:

```bash
python manage.py runserver
```

---

## 📱 Endpoints principales

| Método | Endpoint               | Descripción                         |
| ------ | ---------------------- | ----------------------------------- |
| GET    | /api/docs/swagger/     | Ver todos los endpoints             |
| GET    | /api/docs/redoc/       | Vista endpoint para no tecnicos     |
| GET    | /api/rutas/            | Listar rutas                        |
| POST   | /api/rutas/            | Crear ruta                          |
| GET    | /api/paradas/          | Listar paradas                      |
| POST   | /api/ubicaciones/      | Registrar ubicación de autobús      |
| GET    | /api/historial/?bus=ID | Historial de posiciones del autobús |

> Consulta completa disponible en Swagger o Postman.

---

## ✅ Estado del proyecto

✔️ Backend funcional con todos los modelos y endpoints definidos\
🛠️ Listo para integrarse con una aplicación móvil o dashboard web\
🔒 Entrega controlada por repositorio privado 
