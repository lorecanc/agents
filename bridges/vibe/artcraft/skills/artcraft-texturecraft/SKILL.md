---
name: artcraft-texturecraft
description: Paint mesh textures and bake surface detail from source geometry in
  TextureCraft.
---

# TextureCraft

Start with `session_inspect` to identify the target mesh and texture set. Check the UVs and
material channels before painting. For a bake, establish which mesh receives the maps and which
supplies detail, and check the projection cage where applicable. Preview the result on the mesh,
especially at seams and silhouettes, then export the requested channels at the target
resolution.

Check the baked detail before painting over it. If an artifact follows a UV seam or projection
edge, adjust the bake setup and inspect that region again.
