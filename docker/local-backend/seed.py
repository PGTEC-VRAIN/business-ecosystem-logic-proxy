#!/usr/bin/env python3
"""Carga datos de prueba en las APIs TMForum locales (organización, categorías, catálogo, ofertas)."""
import json, urllib.request
def post(port, path, body):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(r, timeout=30) as f: return json.load(f)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"POST {path} -> {e.code}: {e.read().decode()[:400]}")
org = post(8081, "/organization", {"tradingName": "AEMET (demo)", "isHeadOffice": True, "organizationType": "Public body",
    "contactMedium": [{"mediumType": "Email", "preferred": True, "characteristic": {"emailAddress": "demo@example.org"}}]})
print("org", org["id"])
party = [{"id": org["id"], "href": org["id"], "role": "Owner", "@referredType": "organization"}]
cats = {}
for name in ["Lluvia", "Ríos", "Temperatura", "Viento", "Incendios", "Sequía", "Vegetación", "Satélite"]:
    c = post(8084, "/category", {"name": name, "description": f"Datos de {name.lower()}", "isRoot": True, "lifecycleStatus": "Launched", "version": "1.0"})
    cats[name] = c; print("category", name, c["id"])
cat = post(8084, "/catalog", {"name": "Catálogo demo PGTEC", "description": "Catálogo de pruebas local", "lifecycleStatus": "Launched", "version": "1.0", "relatedParty": party})
print("catalog", cat["id"])
offers = [("Precipitación diaria por estación", "Lluvia", "Serie diaria de precipitación acumulada (mm) por estación meteorológica."),
          ("Caudales de ríos en tiempo real", "Ríos", "Caudal y nivel de las principales cuencas, actualizado cada 15 minutos."),
          ("Temperaturas máximas y mínimas", "Temperatura", "Temperaturas extremas diarias con histórico de 30 años."),
          ("Índice de riesgo de incendios", "Incendios", "Índice de peligro de incendio forestal por municipio."),
          ("Índice de sequía SPEI", "Sequía", "Índice estandarizado de precipitación-evapotranspiración mensual."),
          ("Viento a 10 m (rejilla)", "Viento", "Campo de viento a 10 metros en rejilla de 2,5 km.")]
for title, c, desc in offers:
    spec = post(8084, "/productSpecification", {"name": title, "brand": "AEMET (demo)", "description": desc, "lifecycleStatus": "Launched", "version": "1.0",
        "isBundle": False, "relatedParty": party, "productSpecCharacteristic": []})
    off = post(8084, "/productOffering", {"name": title, "description": desc, "lifecycleStatus": "Launched", "version": "1.0", "isSellable": True, "isBundle": False,
        "category": [{"id": cats[c]["id"], "href": cats[c]["id"], "name": c}],
        "productSpecification": {"id": spec["id"], "href": spec["id"], "name": title},
        "validFor": {"startDateTime": "2026-01-01T00:00:00.000Z"}})
    print("offer", title, off["id"])
