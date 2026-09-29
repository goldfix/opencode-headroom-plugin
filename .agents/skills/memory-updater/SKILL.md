---
name: memory-updater
description: Regole e procedure per aggiornare MEMORY.md, README.md e AGENTS.md dopo modifiche rilevanti al codice o all'architettura.
---

# Memory & Documentation Updater

Questa skill contiene le istruzioni e le linee guida per mantenere la documentazione del progetto sempre sincronizzata con l'attuale stato del codice.
Deve essere invocata (tramite chiamata diretta o in autonomia) alla fine di ogni sessione di sviluppo rilevante.

## Quando usare questa skill
1. Quando aggiungi un nuovo componente/modulo (es. nuovo servizio, package in `src/`).
2. Quando modifichi l'architettura tecnica (es. passaggio a client standard per immagini, uso di nuovi framework).
3. Quando risolvi un bug che merita di essere documentato nei Problemi Comuni.
4. Quando completi un'attività nella Roadmap.

## Usage

Prima di modificare i file, esamina le differenze correnti e l'albero del progetto.

### 1. MEMORY.md
Il file `MEMORY.md` è la memoria viva del progetto. Modifica le seguenti sezioni in base ai cambiamenti:
- **Roadmap**: Aggiorna lo stato (`🔲` -> `✅`) delle attività o aggiungine di nuove.
- **Decisioni architetturali**: Aggiungi nuove decisioni di design per giustificare i "perché" dietro al codice.
- **Problemi Comuni**: Se hai risolto un errore insidioso o oscuro, aggiungilo qui come riferimento futuro.
- **Log delle Sessioni di Lavoro**: Aggiungi un nuovo blocco sotto "Log delle Sessioni di Lavoro" con la data corrente, l'obiettivo e un riepilogo delle modifiche.

### 2. AGENTS.md
Modificalo **SOLO** se:
- Vengono aggiunti nuovi componenti/moduli (es. nell'albero delle directory).
- Cambiano i comandi essenziali CLI.
- Viene modificata l'architettura di base da far conoscere al prossimo Agente (es. regole su come fare i commit o su quali tool non usare).

### 3. README.md
Modificalo **SOLO** se il cambiamento interessa l'utente finale:
- Nuove funzionalità o componenti visibili all'utente.
- Nuove dipendenze o istruzioni d'uso.
- Cambiamenti nel file `.env` (variabili aggiunte/rimosse).
- Modifiche ai pattern di esecuzione.
- Fai particolare attenzione ai diagrammi. Se necessario aggiornali usando l'apposita skill "kroki-diagrams" (se disponibile).

## Checklist dell'Aggiornamento
Esegui questo script bash (tramite tool `bash`) prima di completare il lavoro per garantire l'integrità dei markdown:

```bash
python3 -c "
import re
for f in ['README.md', 'MEMORY.md', 'AGENTS.md']:
    try:
        src = open(f).read()
        fences = len(re.findall(r'\`\`\`', src))
        print(f'{f}: {fences} fence markers -> {\"OK\" if fences % 2 == 0 else \"MISMATCH!\"}')
    except Exception as e:
        print(f'Errore {f}: {e}')"
```
