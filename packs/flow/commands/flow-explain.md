---
description: "Flow: spiega in italiano semplice cosa è cambiato e perché, con mappa Mermaid ed esempi"
agent: flow-build
---

Spiegami le modifiche correnti (o quelle indicate qui: $ARGUMENTS) in **italiano semplice**, senza gergo tecnico. Non modificare nessun file.

Leggi le modifiche rispetto alla base indicata (per il lavoro corrente, `git diff HEAD` include anche i file in staging) e i nuovi file pertinenti. Se manca il primo commit, esamina sia `git diff --cached` sia `git diff`. Rispondi con queste quattro sezioni:

1. **Il perché, a colpo d'occhio**: il problema e su cosa cambia per chi usa il sistema.
2. **Mappa visiva**: un diagramma `mermaid` con i pezzi toccati e il flusso, evidenziando cosa è nuovo o modificato.
3. **Cosa è cambiato davvero**: per ogni modifica importante, un esempio concreto prima e dopo (un input reale e cosa succede), più il frammento di diff essenziale (poche righe, con `path:line`).
4. **Cosa tenere a mente**: rischi, cose da verificare a mano, limiti noti.

Tono: come spiegheresti a un collega intelligente che non ha visto il codice. Usa frasi brevi e nessun acronimo non spiegato.
