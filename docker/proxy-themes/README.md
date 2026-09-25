# Frontend PGTEC (`docker/proxy-themes/bae-frontend`)

`docker/Dockerfile` copia esta carpeta **encima** de `portal/bae-frontend`, así
que la imagen sirve este bundle y no el de upstream. Es un build compilado de
[PGTEC-VRAIN/BAE-Frontend](https://github.com/PGTEC-VRAIN/BAE-Frontend) con el
tema PGTEC; no se edita a mano.

## Regenerarlo

```bash
cd BAE-Frontend                      # rama con el tema PGTEC y los cambios PGTEC
npm ci --fetch-timeout=900000 --fetch-retries=6   # los paquetes Font Awesome Pro descargan lento
npx ng build --configuration production
rsync -a --delete dist/bae-frontend/ ../business-ecosystem-logic-proxy/docker/proxy-themes/bae-frontend/
```

Cambios PGTEC que tiene que llevar el código fuente (antes estaban parcheados a
mano en el bundle minificado y se perdían al recompilar):

- Tema `pgtec` (`src/app/themes/pgtec.theme.*`, `src/assets/themes/pgtec`, i18n) y footer.
- `REGISTRATION_FORM_URL` → `https://onboarding.tailbe597b.ts.net/` en `src/environments/*`.
- `onLoginClick()` (`src/app/shared/header/header.component.ts`) redirige a
  `/auth/vc/login` (login VC del logic-proxy: wallet y certificado FNMT).

El build tiene que partir de una versión de BAE-Frontend que incluya los campos
de contract management del perfil de organización (upstream #234); sin ellos no
se puede configurar el `contractManagement` de los proveedores desde la UI.
