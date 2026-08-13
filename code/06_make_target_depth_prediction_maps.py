#!/usr/bin/env python3
"""Cloud worker: download one GCS tile, create SOC/BD uncertainty maps, upload them."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def gs_exists(uri: str) -> bool:
    return subprocess.run(["gsutil", "-q", "stat", uri]).returncode == 0


def resolve_input_uri(input_uri: str | None, manifest_uri: str | None, task_index: int | None) -> str:
    """Resolve one tile from either --input-uri or a newline-delimited GCS manifest."""
    if input_uri:
        return input_uri
    if not manifest_uri:
        raise ValueError("Provide either --input-uri or --manifest-uri")
    index = task_index
    if index is None:
        raw_index = os.environ.get("BATCH_TASK_INDEX")
        if raw_index is None:
            raise ValueError("BATCH_TASK_INDEX is unavailable; pass --task-index for a local test")
        index = int(raw_index)
    manifest = subprocess.run(
        ["gsutil", "cat", manifest_uri], check=True, capture_output=True, text=True
    ).stdout.splitlines()
    tiles = [line.strip() for line in manifest if line.strip() and not line.lstrip().startswith("#")]
    if not 0 <= index < len(tiles):
        raise IndexError(f"Task index {index} is outside manifest range 0..{len(tiles) - 1}")
    return tiles[index]


def main() -> None:
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input-uri", help="gs://... covariate tile")
    source.add_argument("--manifest-uri", help="gs://... newline-delimited tile manifest")
    parser.add_argument("--task-index", type=int, help="Manifest row; defaults to BATCH_TASK_INDEX")
    parser.add_argument("--output-prefix", required=True, help="gs://bucket/path without trailing slash")
    parser.add_argument("--depths", nargs="+", type=float, default=[5, 15, 30, 60, 100])
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    input_uri = resolve_input_uri(args.input_uri, args.manifest_uri, args.task_index)
    tile_name = input_uri.rsplit("/", 1)[-1]
    stem = Path(tile_name).stem
    expected = {
        depth: f"{args.output_prefix.rstrip('/')}/{stem}_depth_{depth:g}cm_SOC_BD_uncertainty.tif"
        for depth in args.depths
    }
    pending = args.depths if args.overwrite else [d for d in args.depths if not gs_exists(expected[d])]
    if not pending:
        print(json.dumps({"status": "skipped", "reason": "all validated object names exist", "outputs": expected}))
        return
    with tempfile.TemporaryDirectory(prefix="soil_map_") as temporary:
        work = Path(temporary)
        local_input = work / tile_name
        local_output = work / "outputs"
        run(["gsutil", "-m", "cp", input_uri, str(local_input)])
        run([
            "python3", str(args.project_dir / "code" / "07_make_target_depth_uncertainty_maps.py"),
            "--input", str(local_input), "--output-dir", str(local_output),
            "--project-dir", str(args.project_dir), "--depths", *[str(d) for d in pending],
        ])
        records = []
        for depth in pending:
            local = local_output / f"{stem}_depth_{depth:g}cm_SOC_BD_uncertainty.tif"
            digest = hashlib.sha256(local.read_bytes()).hexdigest()
            destination = expected[depth]
            run(["gsutil", "-m", "cp", str(local), destination])
            records.append({"depth_cm": depth, "uri": destination, "sha256": digest, "bytes": local.stat().st_size})
        qc = work / f"{stem}_qc.json"
        qc.write_text(json.dumps({"input": input_uri, "outputs": records}, indent=2))
        run(["gsutil", "cp", str(qc), f"{args.output_prefix.rstrip('/')}/qc/{qc.name}"])
        print(json.dumps({"status": "complete", "outputs": records}, indent=2))


if __name__ == "__main__":
    main()
