---
name: artcraft-solidcraft
description: Model dimension-driven parts, constrained sketches and parametric solids in SolidCraft.
---

# SolidCraft

Inspect the existing feature history and consult the connected server's modeling reference
(`skill_reference` where available) for units, axes, sketch constraints and face selection. Use
a primitive for a simple boss or hole and a constrained sketch for a custom profile. Express
dimensions that should change together as parameter relationships. For example, position a hole
from the plate width and edge clearance so resizing the plate preserves that clearance.

Check the bounding box and volume against expected dimensions. For a hole, also inspect its
axis, center and radius, since a misplaced hole can remove the right volume. Test a
representative parameter change and restore the intended value before saving. If a call reports
work still running, retrieve its pending result before issuing another edit.

When revising a part, inspect the feature and its dependencies before editing. Measure the
dependent features after the change, particularly wall thickness and hole clearance.
