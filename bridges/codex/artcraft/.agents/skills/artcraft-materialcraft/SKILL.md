---
name: artcraft-materialcraft
description: Build procedural material graphs and export physically based rendering (PBR) channels in MaterialCraft.
---

# MaterialCraft

Start from the surface properties the material needs. For example, vary roughness to change how
a patch catches light while keeping its base color consistent. Connect the graph to the
requested material outputs, inspect a channel in isolation with `view_render`, then preview the
combined material under lighting that reveals the effect. Save the editable graph and export the
requested maps.

When handing the maps to another app, label each output by its usage and check that the
receiving material assigns the right map to roughness, normals and base color.
