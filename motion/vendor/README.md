# Vendored dependencies

## three.js

| | |
|---|---|
| Package | [`three`](https://www.npmjs.com/package/three) |
| Version | **0.183.0** |
| License | MIT (Copyright 2010-2026 Three.js Authors) |
| Upstream | `https://unpkg.com/three@0.183.0/build/` |

### Files and expected digests

```
sha256  c5f69a04c70de8c95152040c286a3c8a0489603b019dfd61b34c451e3371c4fd  three.core.min.js
sha256  e3ec4d5d223c0119f754150a3d9deef16139074ea17b073e93bbce315ad16eda  three.module.min.js
```

Verified byte-identical to the published npm release on 2026-08-22.

### Why these files are vendored rather than loaded from a CDN

Loading three.js from a CDN meant that a compromise of that CDN, or of the
published package, would execute arbitrary JavaScript on this origin. The
page previously used an import map, and **import map URLs cannot carry an
`integrity` attribute**, so there was no way to pin what got executed.

Vendoring moves the bytes under our own `script-src 'self'` and removes the
third party from the runtime trust path entirely.

### Both files are required

`three.module.min.js` imports `three.core.min.js` as a sibling. Vendoring
only the module file produces a 404 at runtime and the scene silently never
initialises. Keep them in the same directory.

### Re-verifying

```sh
curl -sO https://unpkg.com/three@0.183.0/build/three.core.min.js
curl -sO https://unpkg.com/three@0.183.0/build/three.module.min.js
sha256sum three.core.min.js three.module.min.js   # compare with the table above
```

(On Windows behind TLS interception, `curl` may fail with `schannel: the
revocation status is unknown`; add `--ssl-revoke-best-effort`.)

### Upgrading

1. Download both files at the new version from the same `unpkg.com` path.
2. Record the new version and both digests in this file.
3. Check `scene3d.js` still imports by relative path (no import map, no CDN).
4. Rename this folder to the new version (`vendor-<version>/`) and update
   the import path in `scene3d.js`, so browsers holding the week-long cache
   of the old files can never pair them with the new ones.
5. Re-test the hero canvas and the full-page layer, including the
   WebGL-unavailable fallback — `initScene3D` returns `null` rather than
   throwing, and `motion-bg-3d.js` removes the dead canvas on that path.
6. Regenerate `../MANIFEST.json` and copy the package to both hosts.
