---
name: seo-copywriting
description: Metodo per scrivere e rivedere i testi di un sito (home, landing, pagine servizio e prodotto, articoli, categorie) che si posizionino sui motori di ricerca senza sembrare scritti da un'IA. Brief di ricerca, contenuto people-first, copy concreto, title, meta description, heading, slug, link interni, dati strutturati e controlli tecnici. Caricala prima di scrivere o cambiare copy, metadati o markup SEO di pagine pubbliche.
---

# Copy SEO che non sembra scritto da un'IA

Per testi in italiano carica e applica anche `italiano-decente`: le sue regole valgono qui senza eccezioni e,
in caso di conflitto, prevalgono. Questa skill aggiunge ciò che serve perché la pagina risponda a una
ricerca reale e venga capita dai motori.

Un principio regge tutto il resto: si scrive per chi cerca. I motori premiano le pagine che risolvono il
problema di chi arriva, e le loro linee guida (contenuti utili, E-E-A-T, policy sullo spam) puniscono i testi
prodotti per riempire. Un testo generato con l'IA non viene penalizzato in quanto tale; viene penalizzato se è
generico, ripetuto su molte pagine o senza valore aggiunto.

## 1. Brief prima di scrivere (5–8 righe, nella todo o nella risposta)

- **Ricerca**: la query principale e 3–6 varianti con lo stesso intento (sinonimi, domande, forme locali).
  Se l'utente non le fornisce, deducile dal contenuto del sito e dichiarale come ipotesi.
- **Intento**: informativo (capire), commerciale (confrontare), transazionale (comprare, prenotare,
  contattare) o navigazionale (trovare il brand). Una pagina, un intento.
- **Lettore**: chi è, cosa sa già, quale dubbio lo ha portato qui.
- **Azione**: l'unica cosa che la pagina deve fargli fare.
- **Prova**: cosa sa questo sito che un concorrente non sa (esperienza diretta, numeri propri, casi, foto
  reali, nomi delle persone, luoghi, prezzi, tempi). Se manca, chiedila all'utente: senza prova il testo
  resta generico, e nessuna tecnica di scrittura lo salva.

## 2. Contenuto people-first

- La risposta al dubbio principale sta nelle prime due o tre righe, poi arrivano dettagli e approfondimenti.
- Copri ciò che il lettore deve sapere per decidere: costi o fascia di prezzo, tempi, limiti, alternative,
  cosa succede dopo il contatto. Ciò che un cliente chiederebbe al telefono va scritto in pagina.
- Una pagina per argomento. Due pagine che competono per la stessa query si uniscono.
- Vietato: keyword stuffing, testo nascosto, pagine porta clonate per città o varianti cambiando solo il
  nome, testi prodotti in massa senza revisione, contenuti copiati o parafrasati da altri siti, recensioni
  o dati inventati.
- Mostra chi parla: autore o azienda, data di aggiornamento per contenuti che invecchiano, contatti e
  riferimenti verificabili.

## 3. Copy che non sembra IA

Oltre ai divieti di `italiano-decente`:

- **Concreto sopra astratto.** Sostituisci ogni aggettivo vuoto con un fatto: «consegna in 48 ore in tutta
  la Lombardia» al posto di «servizio rapido ed efficiente».
- **Parole da eliminare** salvo che siano un fatto dimostrato: innovativo, all'avanguardia, leader del
  settore, soluzioni su misura, a 360 gradi, eccellenza, qualità senza compromessi, passione, esperienza
  pluriennale (scrivi gli anni), professionalità, sinergia, ecosistema, viaggio, potenziare, sbloccare,
  elevare, rivoluzionare.
- **Niente schemi fissi**: triadi di aggettivi in ogni frase, ogni paragrafo chiuso da una frase a effetto,
  domande retoriche in apertura di sezione, elenchi puntati dove serve un ragionamento, grassetti sparsi.
- **Un punto di vista.** Prendi posizione quando il sito ha un'opinione («per un bagno sotto i 5 m² la
  doccia a filo pavimento conviene quasi sempre»). Il testo neutro su tutto non convince nessuno.
- **Voce del brand.** Se il sito ha già un tono (tu o lei, tecnico o colloquiale), seguilo.
- **Test della sostituzione.** Per ogni frase chiediti: un concorrente potrebbe pubblicarla identica sul
  suo sito? Se sì, riscrivila con un dettaglio che appartiene solo a questo.
- **FAQ solo se reali**: domande che i clienti fanno davvero, con risposte brevi e precise.

## 4. On-page

- **`<title>`**: unico per pagina, circa 50–60 caratteri, query principale verso l'inizio, brand in coda
  («Rifacimento bagno a Bergamo, preventivo in 24 ore | Rossi Edilizia»). Niente elenchi di keyword.
- **Meta description**: circa 140–160 caratteri, specifica, con un fatto e un invito all'azione. Non è un
  fattore di ranking e il motore può riscriverla, ma incide sui clic. Unica per pagina.
- **Heading**: un solo H1, vicino al title ma non identico; H2 e H3 descrittivi, in ordine, scritti come
  frasi normali (maiuscola solo all'inizio). Chi legge solo i titoli deve capire la pagina.
- **Slug**: corto, minuscolo, parole separate da trattini, senza stop word inutili né date se il contenuto
  resta valido (`/rifacimento-bagno-bergamo`).
- **Link interni**: verso le pagine collegate, con anchor che descrivono la destinazione. Mai «clicca qui»
  o «scopri di più» da soli.
- **Immagini**: `alt` che descrive cosa si vede (vuoto se decorativa), nome file parlante, dimensioni
  esplicite, formati moderni e lazy loading sotto la piega.
- **Meta keywords**: non servono, non aggiungerle.

## 5. Controlli tecnici nel codice

Verifica nel progetto, e correggi se rientra nel lavoro richiesto:

- `<html lang="it">` (o la lingua corretta); `hreflang` reciproci se il sito è multilingua.
- `<link rel="canonical">` assoluto su ogni pagina; niente pagine importanti in `noindex` o bloccate da
  `robots.txt`; `sitemap.xml` aggiornata e dichiarata in `robots.txt`.
- Testo e link principali presenti nell'HTML servito (SSR o generazione statica), non solo dopo
  l'esecuzione di JavaScript lato client.
- Open Graph e Twitter card (titolo, descrizione, immagine) per le condivisioni.
- Dati strutturati JSON-LD coerenti con ciò che è visibile in pagina: `Organization` o `LocalBusiness`
  (nome, indirizzo, telefono, orari uguali al footer), `Product` con prezzo e disponibilità reali,
  `Article` con autore e date, `BreadcrumbList`. `FAQPage` solo per FAQ reali, sapendo che Google oggi ne
  mostra i risultati arricchiti quasi solo per siti istituzionali e sanitari. Mai markup per contenuti
  assenti dalla pagina.
- Core Web Vitals (LCP entro 2,5 s, INP entro 200 ms, CLS entro 0,1): misurali con Lighthouse o Chrome
  DevTools quando disponibili (skill `chrome-devtools-debug-optimize-lcp`), servendo il sito con `dev_serve`.
- Un solo URL per contenuto: redirect 301 tra varianti (http/https, www, slash finale), niente parametri
  che duplicano pagine.

## 6. Verifica prima della consegna

1. Checklist di `italiano-decente` superata per ogni testo.
2. Brief rispettato: la query e l'intento trovano risposta nelle prime righe; l'azione è chiara.
3. Title, meta description, H1 e slug presenti, unici e nei limiti indicati.
4. Query principale e varianti presenti in modo naturale (title, H1, primo paragrafo, almeno un H2), senza
   ripetizioni forzate.
5. Nessuna frase che superi il test della sostituzione; nessuna parola della lista del punto 3 senza un
   fatto a sostegno.
6. Nessun dato, recensione, numero o claim inventato: ogni fatto viene dal sito, dall'utente o da una fonte
   citata. Se manca un dato, lascia un segnaposto evidente (`[DA CONFERMARE: prezzo]`) e segnalalo.
7. Dati strutturati validi e coerenti con la pagina; canonical, `lang` e link interni a posto.

Se un punto fallisce, correggi e ripeti la verifica.
