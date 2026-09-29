---
name: kroki-diagrams
description: Genera grafici, mappe mentali e diagrammi vettoriali (C4-PlantUML, Excalidraw, Mermaid, PlantUML, Graphviz, D2, ecc.) tramite Kroki usando la codifica URL zlib+Base64. Stile di default 'C4-PlantUML'. Uso esclusivo per documentazione (Pi-Agent), non integrata nell'applicazione.
---

# Kroki Diagram Generator

Questa skill permette di generare diagrammi, schemi architetturali, mappe mentali ed infografiche vettoriali (SVG/PNG) tramite il servizio **[Kroki.io](https://kroki.io)**.

L'integrazione si basa sull'interfaccia HTTP `GET` con codifica del contenuto tramite **zlib deflate (livello 9) + Base64 URL-safe**.

> ⚠️ **Uso esclusivo per documentazione**: questa skill è destinata SOLO a Pi-Agent per generare diagrammi da inserire nella documentazione (`README.md`, `docs/`). NON è registrata nei tool runtime dell'applicazione (`src/`).

---

## 📐 Regole di Default e Comportamento

1. **Stile di Default (C4-PlantUML)**:
   Se l'utente o la richiesta **non specifica uno stile**, il tipo di diagramma predefinito è **`c4plantuml`** (C4-PlantUML, ideale per schemi architetturali e di contesto/container).
2. **Formato Output**:
   Di default l'output è generato in formato **`svg`** (vettoriale scalabile). Il formato **`png`** è il secondo supportato (entrambi documentati). Altri formati (`jpeg`, `pdf`) possono funzionare ma **non sono garantiti** per tutti i tipi di diagramma.
3. **Algoritmo di Codifica URL** (allineato alla doc `setup/pages/encode-diagram.adoc`):
   Il testo sorgente del grafico viene compresso in Python tramite:
   ```python
   import base64
   import zlib

   compressed = zlib.compress(source_text.encode('utf-8'), level=9)
   payload = base64.urlsafe_b64encode(compressed).decode('ascii')
   url = f"https://kroki.io/{diagram_type}/{output_format}/{payload}"
   ```
   - Compressione **deflate a livello 9** (massima).
   - **Base64 URL-safe** (`+` → `-`, `/` → `_`).
   - Opzioni aggiuntive passabili come **query parameter** (`?key=value`, es. `?theme=dark`).
4. **Stile Linee Ortogonali & Pattern Standard Diagrammi**:
   Nei diagrammi `c4plantuml` e `plantuml`, adottare sempre il seguente **standard pattern strutturale e visivo**:
   ```plantuml
   @startuml <diagram_name>
   !include <C4/C4_Container>

   ' === TEMPLATE STANDARD DIAGRAM PATTERN ===
   skinparam linetype ortho
   skinparam nodesep 50
   skinparam ranksep 45
   skinparam rectangleFontSize 12
   skinparam arrowFontSize 10
   skinparam defaultTextAlignment center
   skinparam wrapWidth 180

   title Template — Titolo del Diagramma

   ' Elementi compatti con descrizioni sintetiche su 2-3 righe
   Container(id, "Titolo", "Tech", "Descrizione concisa\ne formattata su 2-3 righe")

   ' Connessioni direzionali esplicite per evitare incroci e sovrapposizioni
   Rel_D(a, b, "Invoca")
   Rel_R(b, c, "Invia dati")
   Rel_U(c, b, "Ritorna")
   @enduml
   ```
   **Regole di layout e tipografia**:
   - **Dimensioni naturali**: Non forzare scale o ingrandimenti artificiali. La dimensione ideale è quella naturale determinata dai componenti (~700-1200px di larghezza).
   - **Box compatti e uniformi**: Descrizioni brevi con interruzioni di riga esplicite (`\n`). Evitare testi chilometrici che allargano i blocchi a dismisura.
   - **Spaziature generose**: `nodesep 50` per la separazione orizzontale e `ranksep 45` per la separazione verticale tra livelli.
   - **Linee ortogonali squadrate**: `skinparam linetype ortho` per connessioni pulite a 90°.
   - **Nessuna sovrapposizione**: Etichette delle frecce corte e concise (1-2 parole: es. *"Invia"*, *"Delega"*, *"Memorizza"*, *"Routing"*). Frecce direzionali esplicite (`Rel_D`, `Rel_R`, `Rel_L`, `Rel_U`).

---

## 🎨 Tipi di Diagramma Supportati (lista non esaustiva)

Fonte: `docs/kroki/pages/index.adoc` e `docs/kroki/setup/pages/install.adoc`.

| Tipo (`diagram_type`) | Descrizione |
| :--- | :--- |
| **`c4plantuml`** *(Default)* | Diagrammi C4 Model (Context, Container, Component) basati su PlantUML. |
| **`excalidraw`** | Diagrammi in stile bozza/fatto a mano. Accetta sia JSON Excalidraw completo sia righe di testo per nodi veloci. |
| **`mermaid`** | Diagrammi di flusso (`flowchart`), sequenze, class diagram, ER e Gantt. |
| **`graphviz`** / **`dot`** | Grafi orientati e reti tramite la sintassi DOT. |
| **`plantuml`** / **`c4plantuml`** | Modelli UML complessi e architettura C4. |
| **`d2`** | Linguaggio moderno per diagrammi architetturali e di sistema. |
| **`bpmn`** | Diagrammi di processo di business. |
| **`blockdiag`** / **`nwdiag`** | Schemi a blocchi e di rete. |
| **`seqdiag`** / **`actdiag`** | Diagrammi di sequenza e di attività. |
| **`packetdiag`** / **`rackdiag`** | Diagrammi di pacchetti di rete e rack. |
| **`erd`** | Entity-Relationship diagram. |
| **`structurizr`** | Diagrammi architetturali C4 as code. |
| **`svgbob`** | Conversione da ASCII art a grafici SVG vettoriali! |
| **`bytefield`** | Diagrammi di strutture binarie (bytefields). |
| **`ditaa`** | Diagrammi da disegni ASCII grezzi. |
| **`goat`** | Diagrammi ASCII in stile GoAT. |
| **`nomnoml`** | Diagrammi UML rapidi con sintassi semplice. |
| **`symbolator`** | Schemi di componenti HDL. |
| **`umlet`** | Diagrammi UML via UMLet. |
| **`vega`** / **`vegalite`** | Visualizzazioni dati (chart, plot, mappe geografiche). |
| **`wavedrom`** | Diagrammi temporali (waveforms) digitali. |
| **`wireviz`** | Diagrammi di cablaggio e harness. |

> La lista completa dei tipi supportati dal container Docker è in `docs/kroki/setup/pages/install.adoc`.

---

## 💻 Uso dello Script CLI integrato

Lo script `.agents/skills/kroki-diagrams/scripts/kroki_generator.py` fornisce un'interfaccia da riga di comando pronta all'uso.

### Esempi di utilizzo:

```bash
# 1. Grafico C4-PlantUML di default (solo testo per nodi rapidi)
python3 .agents/skills/kroki-diagrams/scripts/kroki_generator.py "My System
API Service
Database" --markdown

# 2. Localizzazione automatica dei diagrammi Markdown (download SVG in assets/ e riscrittura dei link)
python3 .agents/skills/kroki-diagrams/scripts/kroki_generator.py --localize README.md

# 3. Grafico Mermaid con output Markdown
python3 .agents/skills/kroki-diagrams/scripts/kroki_generator.py "graph TD; A[Frontend]-->B[API];" --type mermaid --markdown

# 4. Grafico Graphviz scaricato su disco come file SVG
python3 .agents/skills/kroki-diagrams/scripts/kroki_generator.py "digraph G { Client -> Server; }" --type graphviz --output docs/images/example.svg

# 5. Input da file sorgente
python3 .agents/skills/kroki-diagrams/scripts/kroki_generator.py --file schema.dot --type graphviz --markdown
```

### 💾 Localizzazione Offline e Salvataggio SVG
Per rendere la documentazione del repository totalmente indipendente dal servizio Kroki online, lo script supporta la modalità `--localize` (o `-l`):
- Scansiona un file Markdown (es. `README.md`).
- Scarica tutti i file vettoriali SVG dai link Kroki remoti salvandoli nella cartella `assets/` alla root del progetto (creandola automaticamente se non esiste).
- Sostituisce i link remoti `https://kroki.io/...` con i percorsi relativi locali dei file SVG (`assets/nome_diagramma.svg`).

---

## 🐍 Integrazione in Python (per uso script/documentazione)

```python
import base64
import zlib

def generate_kroki_url(
    source_text: str,
    diagram_type: str = "excalidraw",
    output_format: str = "svg",
) -> str:
    """Genera l'URL Kroki per il diagramma fornito."""
    diagram_type = (diagram_type or "excalidraw").lower().strip()
    output_format = (output_format or "svg").lower().strip()

    compressed = zlib.compress(source_text.encode('utf-8'), level=9)
    payload = base64.urlsafe_b64encode(compressed).decode('ascii')

    return f"https://kroki.io/{diagram_type}/{output_format}/{payload}"
```

> Questo snippet è solo a scopo documentale: la generazione dei diagrammi avviene tramite la CLI della skill, non nel codice dell'applicazione.
