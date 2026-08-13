#!/usr/bin/env python3
"""Create SOC% and bulk-density prediction/uncertainty maps from one covariate tile.

The input must be a multiband 250 m GeoTIFF whose band descriptions are covariate
names. One seven-band Cloud-Optimized GeoTIFF is written per requested depth.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import rasterio
import xgboost as xgb
from rasterio.enums import Resampling
from rasterio.shutil import copy as rio_copy


NODATA = -9999.0
ALIASES = {
    "EL": ["EL", "EL_MERIT"],
    "SF": ["SF", "SF_median"],
}
LU_CODES = {1: "C", 2: "F", 3: "R", 4: "X"}
NLCD_CODES = {
    11: "Open Water", 21: "Developed, Open Space", 22: "Developed, Low Intensity",
    23: "Developed, Medium Intensity", 24: "Developed, High Intensity",
    31: "Barren Land", 41: "Deciduous Forest", 42: "Evergreen Forest",
    43: "Mixed Forest", 52: "Shrub/Scrub", 71: "Grassland/Herbaceous",
    81: "Pasture/Hay", 82: "Cultivated Crops", 90: "Woody Wetlands",
    95: "Emergent Herbaceous Wetlands",
}


def load_bundle(project: Path, target: str) -> dict:
    point_dir = project / "model_artifacts" / target
    uncertainty_dir = project / "model_artifacts" / f"{target}_uncertainty"
    point_manifest = json.loads((point_dir / "run_manifest.json").read_text())
    uncertainty_manifest = json.loads((uncertainty_dir / "run_manifest.json").read_text())
    point_prep_name = "soc_pct_preprocessor.joblib" if target == "soc_pct" else "point_preprocessor.joblib"
    point_model_name = "soc_pct_xgboost.json" if target == "soc_pct" else "point_xgboost.json"
    point_model = xgb.XGBRegressor()
    point_model.load_model(point_dir / point_model_name)
    uncertainty_model = xgb.XGBRegressor()
    uncertainty_model.load_model(uncertainty_dir / "uncertainty_xgboost.json")
    return {
        "features": point_manifest["features"],
        "point_prep": joblib.load(point_dir / point_prep_name),
        "point_model": point_model,
        "uncertainty_features": uncertainty_manifest.get(
            "uncertainty_features", uncertainty_manifest["features"]
        ),
        "uncertainty_prep": joblib.load(uncertainty_dir / "uncertainty_preprocessor.joblib"),
        "uncertainty_model": uncertainty_model,
        # Bulk density can use a separately documented DSP4SH-scaled mapping
        # multiplier. SOC retains its RaCA-only calibration multiplier.
        "multiplier": float(uncertainty_manifest.get(
            "mapping_calibration_multiplier", uncertainty_manifest["calibration_multiplier"]
        )),
    }


def resolve_bands(descriptions: tuple[str | None, ...], required: set[str]) -> dict[str, int]:
    available = {name: index + 1 for index, name in enumerate(descriptions) if name}
    resolved = {}
    for feature in required:
        if feature in {"z_mid", "point_prediction"}:
            continue
        candidates = ALIASES.get(feature, [feature])
        match = next((name for name in candidates if name in available), None)
        if match is None:
            raise ValueError(
                f"Required raster feature {feature!r} is missing. Tried {candidates}. "
                f"Available bands: {sorted(available)}"
            )
        resolved[feature] = available[match]
    return resolved


def category_values(feature: str, values: np.ndarray, lrr_levels: list[str]) -> np.ndarray:
    rounded = np.rint(values).astype(np.int32)
    if feature == "LU_scraped":
        return np.array([LU_CODES.get(int(v), None) for v in rounded], dtype=object)
    if feature == "NLCD_name":
        return np.array([NLCD_CODES.get(int(v), None) for v in rounded], dtype=object)
    if feature == "LRR_group":
        return np.array([lrr_levels[v - 1] if 1 <= v <= len(lrr_levels) else None for v in rounded], dtype=object)
    return values


def predict_bundle(bundle: dict, frame: pd.DataFrame) -> tuple[np.ndarray, ...]:
    point = np.maximum(
        np.expm1(bundle["point_model"].predict(bundle["point_prep"].transform(frame[bundle["features"]]))),
        0,
    )
    uncertainty_frame = frame.copy()
    uncertainty_frame["point_prediction"] = point
    scale = np.maximum(
        np.expm1(bundle["uncertainty_model"].predict(
            bundle["uncertainty_prep"].transform(
                uncertainty_frame[bundle["uncertainty_features"]]
            )
        )),
        1e-4,
    )
    half = bundle["multiplier"] * scale
    lower = np.maximum(0, point - half)
    upper = point + half
    return point, lower, upper, upper - lower


def process_tile(input_path: Path, output_dir: Path, depths: list[float], project: Path) -> list[Path]:
    soc = load_bundle(project, "soc_pct")
    bd = load_bundle(project, "bulk_density")
    required = set(soc["features"]) | set(bd["features"])
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    with rasterio.open(input_path) as source:
        if not source.descriptions or not any(source.descriptions):
            raise ValueError("Input raster has no band descriptions; named bands are required")
        band_map = resolve_bands(source.descriptions, required)
        # GEE creates LRR codes from the alphabetically sorted names, matching this list.
        lrr_levels = sorted(
            soc["point_prep"].named_transformers_["categorical"]
            .named_steps["onehot"].categories_[0].astype(str).tolist()
        )
        profile = source.profile.copy()
        profile.update(driver="GTiff", count=9, dtype="float32", nodata=NODATA,
                       compress="DEFLATE", predictor=3, tiled=True, blockxsize=256, blockysize=256,
                       BIGTIFF="YES")
        for depth in depths:
            temporary = output_dir / f".{input_path.stem}_depth_{depth:g}cm.tmp.tif"
            final = output_dir / f"{input_path.stem}_depth_{depth:g}cm_SOC_BD_uncertainty.tif"
            with rasterio.open(temporary, "w", **profile) as destination:
                names = [
                    "soc_pct_prediction", "soc_pct_lower_90", "soc_pct_upper_90", "soc_pct_interval_width",
                    "bulk_density_prediction", "bulk_density_lower_90", "bulk_density_upper_90",
                    "bulk_density_interval_width", "valid_data_mask",
                ]
                for index, name in enumerate(names, 1):
                    destination.set_band_description(index, name)
                for _, window in source.block_windows(1):
                    columns = {}
                    valid = np.ones((window.height, window.width), dtype=bool)
                    for feature, band_index in band_map.items():
                        values = source.read(band_index, window=window).astype("float32")
                        band_nodata = source.nodatavals[band_index - 1]
                        invalid = ~np.isfinite(values) | (values == NODATA)
                        if band_nodata is not None:
                            invalid |= values == band_nodata
                        valid &= ~invalid
                        flat = values.ravel()
                        if feature in {"LRR_group", "LU_scraped", "NLCD_name"}:
                            flat = category_values(feature, flat, lrr_levels)
                        columns[feature] = flat
                    columns["z_mid"] = np.full(window.width * window.height, depth, dtype="float32")
                    frame = pd.DataFrame(columns)
                    valid_flat = valid.ravel()
                    bands = np.full((9, window.height * window.width), NODATA, dtype="float32")
                    if valid_flat.any():
                        subset = frame.loc[valid_flat]
                        soc_values = predict_bundle(soc, subset)
                        bd_values = predict_bundle(bd, subset)
                        for index, values in enumerate((*soc_values, *bd_values)):
                            bands[index, valid_flat] = values.astype("float32")
                        bands[8, valid_flat] = 1
                    destination.write(bands.reshape(9, window.height, window.width), window=window)
            # Convert after a complete write; an interrupted task never leaves a valid final object.
            rio_copy(temporary, final, driver="COG", compress="DEFLATE", blocksize=512,
                     overview_resampling=Resampling.nearest)
            temporary.unlink()
            outputs.append(final)
    return outputs


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path, help="Local multiband covariate GeoTIFF")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--depths", nargs="+", type=float, default=[5, 15, 30, 60, 100])
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parents[1])
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    written = process_tile(args.input, args.output_dir, args.depths, args.project_dir)
    print(json.dumps({"outputs": [str(path) for path in written]}, indent=2))
