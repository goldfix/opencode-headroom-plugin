#!/usr/bin/env python3
"""
Kroki Diagram Generator, Localizer & URL Encoder for Pi-Agent.

Encodes plain text diagram sources (C4-PlantUML, Excalidraw, Mermaid, PlantUML, Graphviz, D2, etc.)
using deflate (zlib level 9) + URL-safe Base64 into Kroki URLs.
Default diagram type: c4plantuml (C4-PlantUML)
Default format: svg

Features:
- Encodes diagram text to Kroki URLs
- Downloads SVG/PNG images locally
- Localizes remote Kroki image links in Markdown files to offline local SVG files
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.request
import zlib
from pathlib import Path
from typing import Any


def encode_kroki_payload(source_text: str) -> str:
    """
    Compresses text using zlib deflate (level 9) and encodes with URL-safe base64.
    Matches Kroki GET request payload requirement.
    """
    if not source_text or not source_text.strip():
        raise ValueError("Source text for diagram cannot be empty.")

    compressed = zlib.compress(source_text.encode("utf-8"), level=9)
    return base64.urlsafe_b64encode(compressed).decode("ascii")


def build_simple_c4_plantuml(source_text: str) -> str:
    """
    If source_text is not a full @startuml ... @enduml block,
    wraps plain text lines into a valid C4-Container diagram structure.
    """
    clean_text = source_text.strip()
    if clean_text.startswith("@startuml") or clean_text.startswith("C4") or clean_text.startswith("Person"):
        return source_text

    lines = [line.strip() for line in clean_text.splitlines() if line.strip()]
    if not lines:
        return source_text

    system_title = lines[0]
    components = lines[1:] if len(lines) > 1 else []

    puml = [
        "@startuml",
        "!include <C4/C4_Container>",
        "",
        f"System(system, '{system_title}', 'System')",
    ]
    for idx, comp in enumerate(components):
        puml.append(f"Container(comp_{idx}, '{comp}', 'Component')")
        puml.append(f"Rel(system, comp_{idx}, 'Uses')")
    puml.append("@enduml")

    return "\n".join(puml)


def build_simple_excalidraw_json(label_text: str) -> str:
    """
    Helper to construct a valid Excalidraw JSON structure from plain text labels/nodes.
    """
    lines = [line.strip() for line in label_text.strip().splitlines() if line.strip()]
    elements: list[dict[str, Any]] = []

    y_offset = 50
    for idx, line in enumerate(lines):
        elements.append({
            "id": f"elem_{idx}",
            "type": "rectangle",
            "x": 100,
            "y": y_offset,
            "width": 240,
            "height": 70,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "#e0f2fe" if idx == 0 else "#fff3bf",
            "fillStyle": "hachure",
            "strokeWidth": 2,
            "roughness": 1,
            "opacity": 100,
            "label": {"text": line},
        })
        y_offset += 100

    excalidraw_doc = {
        "type": "excalidraw",
        "version": 2,
        "source": "kroki-skill",
        "elements": elements,
    }
    return json.dumps(excalidraw_doc, ensure_ascii=False)


def generate_kroki_url(
    source_text: str,
    diagram_type: str = "c4plantuml",
    output_format: str = "svg",
    base_url: str = "https://kroki.io",
    params: dict[str, str] | None = None,
) -> str:
    """
    Generates a Kroki GET request URL for a given diagram source.
    If diagram_type is omitted or empty, defaults to 'c4plantuml' (C4-PlantUML).
    """
    if not diagram_type or not str(diagram_type).strip():
        diagram_type = "c4plantuml"
    diagram_type = str(diagram_type).lower().strip()

    if not output_format or not str(output_format).strip():
        output_format = "svg"
    output_format = str(output_format).lower().strip()

    if diagram_type == "c4plantuml":
        source_text = build_simple_c4_plantuml(source_text)
    elif diagram_type == "excalidraw" and not source_text.strip().startswith("{"):
        source_text = build_simple_excalidraw_json(source_text)

    payload = encode_kroki_payload(source_text)
    url = f"{base_url.rstrip('/')}/{diagram_type}/{output_format}/{payload}"

    if params:
        query_str = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query_str}"

    return url


def download_kroki_diagram(
    url: str,
    output_path: Path,
    user_agent: str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) kroki-diagrams/1.0",
) -> bool:
    """
    Downloads the diagram from Kroki URL and saves it to output_path.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    try:
        with urllib.request.urlopen(req) as response:
            content = response.read()
            with open(output_path, "wb") as f:
                f.write(content)
        return True
    except Exception as e:
        print(f"❌ Error downloading diagram from Kroki ({url}): {e}", file=sys.stderr)
        return False


def localize_markdown_diagrams(
    md_file_path: Path,
    assets_dir: Path = Path("assets"),
) -> dict[str, Any]:
    """
    Scans a Markdown file for remote Kroki image URLs, downloads the SVG files
    to assets_dir, and rewrites the Markdown image links to local relative paths.
    """
    if not md_file_path.exists():
        print(f"❌ Error: File {md_file_path} does not exist.", file=sys.stderr)
        return {"localized": 0, "failed": 0}

    assets_dir.mkdir(parents=True, exist_ok=True)
    content = md_file_path.read_text(encoding="utf-8")

    # Match ![Alt Text](https://kroki.io/...)
    pattern = r"!\[([^\]]+)\]\((https://kroki\.io/[^\)]+)\)"
    matches = re.findall(pattern, content)

    if not matches:
        print(f"ℹ️ No remote Kroki diagram URLs found in {md_file_path}.")
        return {"localized": 0, "failed": 0}

    print(f"🔍 Found {len(matches)} Kroki diagram(s) in {md_file_path}. Downloading SVGs to {assets_dir}...")

    stats = {"localized": 0, "failed": 0}
    new_content = content

    for idx, (alt_text, kroki_url) in enumerate(matches, start=1):
        clean_name = re.sub(r"[^a-zA-Z0-9]+", "_", alt_text.lower()).strip("_")
        clean_name = re.sub(r"_(c4_plantuml|excalidraw|style)$", "", clean_name)
        if not clean_name:
            clean_name = f"diagram_{idx}"

        svg_filename = f"{clean_name}.svg"
        svg_path = assets_dir / svg_filename

        print(f" ⬇️ [{idx}/{len(matches)}] Downloading: '{alt_text}' -> {svg_path}...")
        success = download_kroki_diagram(kroki_url, svg_path)

        if success:
            try:
                rel_svg_path = os.path.relpath(svg_path, md_file_path.parent)
            except ValueError:
                rel_svg_path = str(svg_path)
            old_tag = f"![{alt_text}]({kroki_url})"
            new_tag = f"![{alt_text}]({rel_svg_path})"
            new_content = new_content.replace(old_tag, new_tag)
            stats["localized"] += 1
        else:
            stats["failed"] += 1

    md_file_path.write_text(new_content, encoding="utf-8")
    print(f"✅ Localization complete for {md_file_path}: {stats['localized']} saved, {stats['failed']} failed.")
    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate Kroki diagram URLs, save images locally, and localize Markdown links."
    )
    parser.add_argument(
        "source",
        nargs="?",
        default=None,
        help="Diagram text source. If empty or '-', reads from stdin, --file, or --localize.",
    )
    parser.add_argument(
        "--file", "-f",
        type=Path,
        default=None,
        help="Path to file containing diagram source text.",
    )
    parser.add_argument(
        "--localize", "-l",
        type=Path,
        default=None,
        help="Target Markdown file (e.g. README.md) to download remote Kroki SVGs and replace links with local SVG paths.",
    )
    parser.add_argument(
        "--assets-dir", "-ad",
        type=Path,
        default=Path("assets"),
        help="Directory where localized SVG files are saved (default: assets).",
    )
    parser.add_argument(
        "--type", "-t",
        default="c4plantuml",
        help="Diagram type (default: c4plantuml). Options: c4plantuml, excalidraw, mermaid, plantuml, graphviz, d2, bpmn, etc.",
    )
    parser.add_argument(
        "--format", "-fmt",
        default="svg",
        help="Output image format: svg (default), png, jpeg, pdf.",
    )
    parser.add_argument(
        "--output", "-o",
        type=Path,
        default=None,
        help="Output file path to save downloaded image (optional).",
    )
    parser.add_argument(
        "--title",
        default="Diagram",
        help="Title for Markdown/HTML output tag.",
    )
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Output result as Markdown image tag ![Title](URL).",
    )
    parser.add_argument(
        "--html",
        action="store_true",
        help="Output result as HTML img tag.",
    )

    args = parser.parse_args()

    # Handle Markdown Localization mode
    if args.localize:
        localize_markdown_diagrams(args.localize, assets_dir=args.assets_dir)
        return

    # Determine diagram source
    source_text = ""
    if args.file and args.file.exists():
        source_text = args.file.read_text(encoding="utf-8")
    elif args.source and args.source != "-":
        source_text = args.source
    else:
        source_text = sys.stdin.read()

    if not source_text or not source_text.strip():
        print("❌ Error: No diagram source text provided. Use --help for usage.", file=sys.stderr)
        sys.exit(1)

    url = generate_kroki_url(
        source_text=source_text,
        diagram_type=args.type,
        output_format=args.format,
    )

    if args.output:
        success = download_kroki_diagram(url, args.output)
        if success:
            print(f"✅ Saved diagram to {args.output}")

    if args.markdown:
        print(f"![{args.title}]({url})")
    elif args.html:
        print(f'<img src="{url}" alt="{args.title}" />')
    else:
        print(url)


if __name__ == "__main__":
    main()
