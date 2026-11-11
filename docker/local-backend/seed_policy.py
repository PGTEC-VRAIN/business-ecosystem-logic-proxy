#!/usr/bin/env python3
"""Añade una oferta de prueba cuya especificación incluye una política ODRL (para probar el visor)."""
import json, urllib.request
def req(m, port, path, body=None):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None, headers={"Content-Type": "application/json"}, method=m)
    with urllib.request.urlopen(r, timeout=30) as f: return json.load(f)
org = req("GET", 8081, "/organization")[0]
party = [{"id": org["id"], "href": org["id"], "role": "Owner", "@referredType": "organization"}]
cat = next(c for c in req("GET", 8084, "/category") if c["name"] == "Lluvia")
policy = {"@context": "http://www.w3.org/ns/odrl.jsonld", "@type": "Policy", "uid": "demo-policy-1",
          "permission": [{"action": "use", "target": "urn:demo:rain-data", "constraint": [{"leftOperand": "purpose", "operator": "eq", "rightOperand": "research"}]}],
          "prohibition": [{"action": "distribute", "target": "urn:demo:rain-data"}]}
spec = req("POST", 8084, "/productSpecification", {"name": "Lluvia con política ODRL (demo)", "brand": "AEMET (demo)", "description": "Oferta de prueba con una política de uso ODRL.",
    "lifecycleStatus": "Launched", "version": "1.0", "isBundle": False, "relatedParty": party,
    "productSpecCharacteristic": [{"name": "Política de acceso", "description": "Política ODRL de uso del dato", "valueType": "string", "configurable": False,
        "productSpecCharacteristicValue": [{"isDefault": True, "value": json.dumps(policy)}]}]})
off = req("POST", 8084, "/productOffering", {"name": "Lluvia con política ODRL (demo)", "description": "Oferta de prueba con una política de uso ODRL.", "lifecycleStatus": "Launched",
    "version": "1.0", "isSellable": True, "isBundle": False, "category": [{"id": cat["id"], "href": cat["id"], "name": "Lluvia"}],
    "productSpecification": {"id": spec["id"], "href": spec["id"], "name": spec["name"]}, "validFor": {"startDateTime": "2026-01-01T00:00:00.000Z"}})
print(off["id"])
