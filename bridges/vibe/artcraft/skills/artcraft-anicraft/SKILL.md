---
name: artcraft-anicraft
description: Create scene-based 2D animation, key poses, tweens and loops in AniCraft.
---

# AniCraft

Read `anicraft_document` for the active scene, layer, frame and selection before inserting a key
pose. Use the server's frame indexing when translating a storyboard cue. Establish the key poses
first, then add in-betweens or tweens. Render a frame between poses and check the transition
across the loop boundary for looping work.

For a cycle, check whether the export repeats the opening pose as its last frame. Play through
the join to distinguish an intentional hold from a doubled frame.
