---
description: "Flow: spiega in italiano semplice cosa è cambiato e perché, con mappa Mermaid ed esempi"
agent: free-flow-build
---

Spiegami le modifiche correnti (o quelle indicate qui: $ARGUMENTS) in **italiano semplice**, senza gergo tecnico. Non modificare nessun file.

Modifiche rispetto a HEAD:
!`git status --short 2>/dev/null | head -60 || true`
!`git diff --stat 2>/dev/null | tail -30 || true`

Leggi il diff (`git diff`, più i file nuovi non tracciati) e rispondi con queste quattro sezioni:

1. **Il perché, a colpo d'occhio**: 3–5 frasi sul problema e su cosa cambia per chi usa il sistema.
2. **Mappa visiva**: un diagramma `mermaid` (flowchart, 6–10 nodi) con i pezzi toccati e il flusso, evidenziando cosa è nuovo o modificato.
3. **Cosa è cambiato davvero**: per ogni modifica importante, un esempio concreto prima e dopo (un input reale e cosa succede), più il frammento di diff essenziale (poche righe, con `path:line`).
4. **Cosa tenere a mente**: rischi, cose da verificare a mano, limiti noti.

Tono: come spiegheresti a un collega intelligente che non ha visto il codice. Usa frasi brevi e nessun acronimo non spiegato.
