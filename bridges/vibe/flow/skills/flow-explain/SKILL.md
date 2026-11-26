---
name: flow-explain
description: "Flow: spiega in italiano semplice cosa è cambiato e perché, con
  mappa Mermaid ed esempi"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Spiegami le modifiche correnti (o quelle indicate qui: $request) in **italiano semplice**, senza gergo tecnico. Non modificare nessun file.

Leggi le modifiche rispetto alla base indicata (per il lavoro corrente, `git diff HEAD` include anche i file in staging) e i nuovi file pertinenti. Se manca il primo commit, esamina sia `git diff --cached` sia `git diff`. Rispondi con queste quattro sezioni:

1. **Il perché, a colpo d'occhio**: il problema e su cosa cambia per chi usa il sistema.
2. **Mappa visiva**: un diagramma `mermaid` con i pezzi toccati e il flusso, evidenziando cosa è nuovo o modificato.
3. **Cosa è cambiato davvero**: per ogni modifica importante, un esempio concreto prima e dopo (un input reale e cosa succede), più il frammento di diff essenziale (poche righe, con `path:line`).
4. **Cosa tenere a mente**: rischi, cose da verificare a mano, limiti noti.

Tono: come spiegheresti a un collega intelligente che non ha visto il codice. Usa frasi brevi e nessun acronimo non spiegato.
